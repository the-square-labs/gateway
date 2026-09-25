#!/usr/bin/env python3
"""Fixed native Gateway backup runner. It accepts no caller-provided commands or paths."""
import base64
import ftplib
import hashlib
import hmac
import io
import json
import os
import paramiko
import pathlib
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

CONFIG = pathlib.Path("/run/gateway-backup/config.json")
WORK = pathlib.Path("/work")
RESULT = WORK / "result.json"
STARTED_AT = time.time()
# Leaves time to detach replication, restore masterauth and report a result
# before the executor enforces the run's deadline.
DEADLINE_RESERVE_SECONDS = 30


class BackupError(Exception):
    pass


def main():
    operation = sys.argv[1] if len(sys.argv) == 2 else ""
    config = load_config()
    try:
        if operation == "preflight":
            preflight(config)
            result(config, "completed", "preflight")
        elif operation == "backup":
            manifest = backup(config)
            result(config, "completed", "completed", manifest=manifest, bytes_written=sum(manifest["sizes"].values()))
        elif operation == "restore":
            restore(config)
            result(config, "completed", "completed")
        else:
            raise BackupError("unsupported operation")
    except Exception as error:
        result(config, "failed", operation or "validation", error=sanitize(str(error)))
        return 1
    return 0


def load_config():
    st = CONFIG.stat()
    if st.st_mode & 0o077:
        raise BackupError("backup config permissions are unsafe")
    config = json.loads(CONFIG.read_text())
    required = {"runId", "version", "direction", "engine", "destination", "limits", "toolImage"}
    if set(config) - (required | {"source", "staging", "restoreTarget", "restoreArtifact", "redisStaging", "redisStageImage", "redisStageAdvertiseHost", "deadlineAt"}):
        raise BackupError("backup config has unrecognized fields")
    if required - set(config) or config["version"] != 1:
        raise BackupError("backup config is incomplete")
    if config["direction"] not in {"backup", "restore"} or config["engine"] not in {"postgres", "redis", "clickhouse"}:
        raise BackupError("backup config engine or direction is invalid")
    if config["direction"] == "restore" and not config.get("restoreTarget"):
        raise BackupError("restore target is required")
    if config["direction"] == "backup" and not config.get("source"):
        raise BackupError("backup source is required")
    return config


def result(config, status, phase, manifest=None, bytes_written=0, error=None):
    payload = {"runId": config.get("runId", ""), "status": status, "phase": phase, "bytes": bytes_written}
    if manifest:
        payload["manifest"] = manifest
    if error:
        payload["error"] = error
    WORK.mkdir(mode=0o700, exist_ok=True)
    temp = RESULT.with_suffix(".tmp")
    temp.write_text(json.dumps(payload, separators=(",", ":")))
    os.chmod(temp, 0o600)
    temp.replace(RESULT)


def run_deadline(config):
    """Absolute time (epoch seconds) by which this run must finish."""
    deadline = STARTED_AT + int(config.get("limits", {}).get("timeoutSeconds", 3600))
    value = config.get("deadlineAt")
    if isinstance(value, str) and value:
        try:
            from datetime import datetime
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
            deadline = min(deadline, parsed)
        except ValueError:
            raise BackupError("backup deadline is invalid")
    return deadline


def remaining_seconds(config, minimum=1):
    """Time left for a wait inside the run, keeping a reserve for cleanup."""
    return max(minimum, run_deadline(config) - time.time() - DEADLINE_RESERVE_SECONDS)


def run(args, env=None, input_text=None):
    completed = subprocess.run(args, input=input_text, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, check=False)
    if completed.returncode:
        raise BackupError("native command failed")
    return completed.stdout


def safe_part(value):
    if not isinstance(value, str):
        raise BackupError("unsafe backup storage path")
    value = value.strip("/")
    if (
        not value
        or "\\" in value
        or any(ord(character) < 32 for character in value)
        or any(part in {"", ".", ".."} for part in value.split("/"))
    ):
        raise BackupError("unsafe backup storage path")
    return value


def db_args(endpoint, executable):
    args = [executable, "-h", endpoint["host"], "-p", str(endpoint["port"])]
    if endpoint.get("username"):
        args.extend(["-U", endpoint["username"]])
    return args


POSTGRES_TOOLS = pathlib.Path("/usr/lib/postgresql")


def postgres_major(endpoint):
    version = run(db_args(endpoint, "psql") + ["-d", endpoint["database"], "-Atqc", "SHOW server_version_num"], postgres_env(endpoint)).strip()
    return int(version) // 10000


def postgres_tool(name, major):
    # A dump written by a newer pg_dump does not restore into an older server: it carries settings that
    # server rejects. Use the client of the server's own major; the image default only covers the newest.
    candidate = POSTGRES_TOOLS / str(major) / "bin" / name
    return str(candidate) if candidate.exists() else name


def postgres_restore_tool(target, artifact):
    tool = postgres_tool("pg_restore", postgres_major(target))
    if tool == "pg_restore": return tool
    try:
        run([tool, "--list", str(artifact)])
    except BackupError:
        # An archive written by a newer pg_dump can only be read by that newer pg_restore.
        return "pg_restore"
    return tool


SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt"


def tls_verification(endpoint):
    """Explicit per-connection verification; None keeps the behavior of endpoints that do not carry it (managed relay routes)."""
    value = endpoint.get("tlsVerifyCertificate")
    return value if isinstance(value, bool) else None


def write_ca(endpoint, name):
    ca = WORK / name; ca.write_text(endpoint["caPem"]); os.chmod(ca, 0o600)
    return ca


def is_ip_address(value):
    try:
        socket.inet_pton(socket.AF_INET6 if ":" in value else socket.AF_INET, value)
        return True
    except OSError:
        return False


def postgres_env(endpoint):
    env = os.environ.copy()
    env["PGPASSWORD"] = endpoint.get("password", "")
    if endpoint.get("tls"):
        verify = tls_verification(endpoint)
        if verify is False:
            env["PGSSLMODE"] = "require"
        elif verify is True:
            # Chain and hostname, against the connection's CA or the public bundle.
            env["PGSSLMODE"] = "verify-full"
            env["PGSSLROOTCERT"] = str(write_ca(endpoint, "postgres-ca.pem")) if endpoint.get("caPem") else SYSTEM_CA_BUNDLE
        else:
            env["PGSSLMODE"] = "verify-ca" if endpoint.get("caPem") else "require"
            if endpoint.get("caPem"):
                env["PGSSLROOTCERT"] = str(write_ca(endpoint, "postgres-ca.pem"))
        if endpoint.get("serverName"):
            env["PGHOST"] = endpoint["host"]
    return env


def preflight(config):
    engine = config["engine"]
    if config["direction"] == "backup":
        source = config["source"]
        if engine == "postgres":
            run(db_args(source, "psql") + ["-d", source["database"], "-Atqc", "SELECT 1"], postgres_env(source))
        elif engine == "redis":
            redis_command(source, ["PING"])
        else:
            clickhouse_query(source, "SELECT 1")
            stage = config.get("staging") or config["destination"]
            if stage.get("provider") != "s3": raise BackupError("clickhouse requires an S3 native staging destination")
            probe_prefix = safe_part(stage.get("prefix", "database-backups")) + "/probe/" + config["runId"]
            try:
                # Preflight has seconds, not the run's time limit: prove the server itself can write to the
                # staging bucket with a one-row object instead of backing the whole database up twice.
                clickhouse_query(source, f"INSERT INTO FUNCTION {clickhouse_s3(stage, 'probe/' + config['runId'] + '/probe.csv', ['CSV', 'probe UInt8'])} SELECT 1")
                if not list_objects(stage, probe_prefix):
                    raise BackupError("clickhouse native staging probe produced no objects")
            finally:
                delete_prefix(stage, probe_prefix)
    else:
        assert_empty_target(engine, config["restoreTarget"])
    probe = WORK / "probe"; probe.write_bytes(b"gateway-backup-probe")
    remote = remote_key(config["destination"], f"{config['runId']}/.probe")
    try:
        upload(config["destination"], probe, remote)
        copied = WORK / "probe-copy"; download(config["destination"], remote, copied)
        if copied.read_bytes() != probe.read_bytes():
            raise BackupError("destination probe read did not match write")
    finally:
        delete_object(config["destination"], remote)


def backup(config):
    artifact_dir = WORK / ("artifacts-" + config["runId"]); artifact_dir.mkdir(mode=0o700, exist_ok=True)
    engine = config["engine"]
    if engine == "postgres":
        artifact = artifact_dir / "database.dump"
        source = config["source"]
        run(db_args(source, postgres_tool("pg_dump", postgres_major(source))) + ["-d", source["database"], "--format=custom", "--no-owner", "--no-privileges", "--file", str(artifact)], postgres_env(source))
        engine_version = run(db_args(source, "psql") + ["-d", source["database"], "-Atqc", "SHOW server_version"], postgres_env(source)).strip()
    elif engine == "redis":
        artifact = artifact_dir / "database.rdb"
        redis_command(config["source"], ["--rdb", str(artifact)])
        engine_version = redis_version(config["source"])
    else:
        return clickhouse_backup(config)
    return upload_artifacts(config, artifact_dir, engine_version)


def restore(config):
    manifest = config.get("restoreArtifact")
    if not manifest or not manifest.get("artifactKeys") or not manifest.get("fileChecksums"):
        raise BackupError("restore artifact manifest is incomplete")
    # ClickHouse stages each artifact into native S3. Its restore path performs
    # the checksum-verified download, so the generic restore directory would
    # only download the same artifacts a second time.
    if config["engine"] == "clickhouse":
        assert_empty_target(config["engine"], config["restoreTarget"])
        restore_clickhouse(config, manifest)
        return
    artifact_dir = WORK / "restore"; artifact_dir.mkdir(mode=0o700, exist_ok=True)
    for key in manifest["artifactKeys"]:
        local = artifact_dir / pathlib.PurePosixPath(key).name
        download(config["destination"], key, local)
        if sha256(local) != manifest["fileChecksums"].get(key):
            raise BackupError("artifact checksum mismatch")
    # A target can change after the earlier preflight. Recheck immediately
    # before any engine-native restore command.
    assert_empty_target(config["engine"], config["restoreTarget"])
    if config["engine"] == "postgres":
        artifact = next(artifact_dir.glob("*.dump"))
        target = config["restoreTarget"]
        run(db_args(target, postgres_restore_tool(target, artifact)) + ["-d", target["database"], "--no-owner", "--no-privileges", "--exit-on-error", str(artifact)], postgres_env(target))
        if target.get("managedDatabaseId"):
            transfer_postgres_ownership(target)
    elif config["engine"] == "redis":
        restore_redis(config, next(artifact_dir.glob("*.rdb")))
    else:
        restore_clickhouse(config, manifest)


# A managed PostgreSQL database is owned by a NOLOGIN application role that
# binding and direct-access principals SET ROLE to, while Gateway restores as
# its superuser control account. --no-owner makes every restored object owned
# by that control account, which the application role cannot use. Hand them to
# the database owner. Legacy managed databases (owner == restoring account) and
# superuser-owned databases are left unchanged.
POSTGRES_OWNERSHIP_TRANSFER_SQL = """
DO $gateway$
DECLARE
  database_owner name;
  owner_is_superuser boolean;
BEGIN
  SELECT r.rolname, r.rolsuper INTO database_owner, owner_is_superuser
  FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba
  WHERE d.datname = current_database();
  IF database_owner IS NULL OR database_owner = current_user OR owner_is_superuser THEN
    RETURN;
  END IF;
  EXECUTE format('REASSIGN OWNED BY %I TO %I', current_user, database_owner);
END
$gateway$;
"""


def transfer_postgres_ownership(target):
    run(db_args(target, "psql") + ["-d", target["database"], "-v", "ON_ERROR_STOP=1", "-Atq"], postgres_env(target), POSTGRES_OWNERSHIP_TRANSFER_SQL)


def upload_artifacts(config, artifact_dir, engine_version):
    owned_prefix = safe_part(config["destination"].get("prefix", "database-backups")) + "/" + config["runId"]
    keys, sizes, checksums = [], {}, {}
    for file in artifact_dir.iterdir():
        key = remote_key(config["destination"], f"{owned_prefix}/{file.name}")
        upload(config["destination"], file, key)
        keys.append(key); sizes[key] = file.stat().st_size; checksums[key] = sha256(file)
    manifest = {"engine": config["engine"], "version": 1, "engineVersion": engine_version, "sourceIdentity": config["source"]["connectionId"], "sourceDatabase": config["source"].get("database"), "artifactKeys": keys, "sizes": sizes, "fileChecksums": checksums, "ownedPrefix": owned_prefix}
    manifest["manifestSha256"] = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    manifest_path = artifact_dir / "manifest.json"; manifest_path.write_text(json.dumps(manifest, sort_keys=True)); os.chmod(manifest_path, 0o600)
    manifest_key = remote_key(config["destination"], f"{owned_prefix}/manifest.json"); upload(config["destination"], manifest_path, manifest_key)
    return manifest


def redis_command(endpoint, command, last_argument=None):
    args = ["redis-cli", "--no-auth-warning", "-h", endpoint["host"], "-p", str(endpoint["port"])]
    if endpoint.get("username"): args.extend(["--user", endpoint["username"]])
    verify = tls_verification(endpoint)
    if endpoint.get("tls"):
        args.append("--tls")
        if verify is False:
            args.append("--insecure")
        elif verify is True and not is_ip_address(endpoint["host"]):
            args.extend(["--sni", endpoint["host"]])
    if endpoint.get("caPem") and verify is not False:
        args.extend(["--cacert", str(write_ca(endpoint, "redis-ca.pem"))])
    env = os.environ.copy()
    if endpoint.get("password"):
        env["REDISCLI_AUTH"] = endpoint["password"]
    else:
        env.pop("REDISCLI_AUTH", None)
    if last_argument is not None:
        # -x reads the final argument from stdin, keeping it out of argv.
        return run(args + ["-x"] + command, env, last_argument)
    return run(args + command, env)


def redis_command_secret_last(endpoint, command, secret):
    """Runs a Redis command whose last argument is a secret without exposing it in the process arguments."""
    return redis_command(endpoint, command, last_argument=secret)


def redis_version(endpoint):
    for line in redis_command(endpoint, ["INFO", "server"]).splitlines():
        if line.startswith("redis_version:"): return line.split(":", 1)[1]
    raise BackupError("Redis server version is unavailable")


def assert_empty_target(engine, target):
    if engine == "postgres":
        query = "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND c.relkind IN ('r','p','m','v','S')"
        if run(db_args(target, "psql") + ["-d", target["database"], "-Atqc", query], postgres_env(target)).strip() != "0": raise BackupError("PostgreSQL restore target is not empty")
    elif engine == "redis":
        if redis_has_keys(target): raise BackupError("Redis restore target is not empty")
    else:
        if clickhouse_query(target, "SELECT count() FROM system.tables WHERE database = currentDatabase() AND is_temporary = 0").strip() != "0": raise BackupError("ClickHouse restore target is not empty")


def redis_has_keys(target):
    # REPLICAOF affects the entire Redis instance. INFO keyspace covers every
    # non-empty logical DB, while DBSIZE checks only the selected DB (usually 0).
    lines = redis_command(target, ["INFO", "keyspace"]).replace("\r", "").split("\n")
    if "# Keyspace" not in lines:
        raise BackupError("Redis target keyspace inspection failed")
    for line in lines:
        name, separator, details = line.partition(":")
        if not separator or not name.startswith("db") or not name[2:].isdigit():
            continue
        values = dict(part.split("=", 1) for part in details.split(",") if "=" in part)
        if "keys" not in values:
            raise BackupError("Redis target keyspace inspection failed")
        key_count = values["keys"]
        if not key_count.isascii() or not key_count.isdigit() or int(key_count) < 0:
            raise BackupError("Redis target keyspace inspection failed")
        if int(key_count) > 0:
            return True
    return False


def clickhouse_ssl_context(endpoint):
    context = ssl.create_default_context(cadata=endpoint["caPem"]) if endpoint.get("caPem") else ssl.create_default_context()
    if tls_verification(endpoint) is False:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    return context


def clickhouse_query(endpoint, query, timeout=60):
    scheme = "https" if endpoint.get("tls") else "http"
    url = f"{scheme}://{endpoint['host']}:{endpoint['port']}/?database={urllib.parse.quote(endpoint.get('database', 'default'))}"
    request = urllib.request.Request(url, data=query.encode(), method="POST")
    token = base64.b64encode(f"{endpoint.get('username','')}:{endpoint.get('password','')}".encode()).decode()
    request.add_header("Authorization", "Basic " + token)
    context = clickhouse_ssl_context(endpoint)
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            return response.read().decode()
    except Exception as error:
        raise BackupError("clickhouse native command failed") from error


def clickhouse_s3(endpoint, suffix, extra=()):
    native_endpoint = endpoint.get("nativeEndpoint") or endpoint.get("endpoint")
    parsed = urllib.parse.urlparse(native_endpoint or "")
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise BackupError("clickhouse requires a server-reachable native S3 endpoint")
    base = native_endpoint.rstrip("/") + "/" + endpoint["bucket"] + "/" + safe_part(endpoint.get("prefix", "database-backups")) + "/" + suffix.strip("/")
    # BACKUP/RESTORE take the S3 engine; with a format and structure in `extra` the same arguments form the s3() table function.
    return ("s3(" if extra else "S3(") + ", ".join(repr(value) for value in [base, endpoint["accessKeyId"], endpoint["secretAccessKey"], *extra]) + ")"


def clickhouse_backup(config):
    stage = config.get("staging") or config["destination"]
    if stage.get("provider") != "s3": raise BackupError("clickhouse native backup requires S3 staging")
    database = quote_identifier(config["source"].get("database", "default")); stage_prefix = "native/" + config["runId"]
    stage_root = safe_part(stage.get("prefix", "database-backups")) + "/" + stage_prefix
    try:
        # BACKUP is synchronous and runs for as long as the data takes; the run's own limit bounds it.
        clickhouse_query(config["source"], f"BACKUP DATABASE {database} TO {clickhouse_s3(stage, stage_prefix)}", timeout=config["limits"]["timeoutSeconds"])
        entries = list_objects(stage, stage_root)
        if not entries:
            raise BackupError("clickhouse native backup produced no staged artifacts")
        owned_prefix = safe_part(config["destination"].get("prefix", "database-backups")) + "/" + config["runId"]
        keys, sizes, checksums = [], {}, {}
        transfer_dir = WORK / "clickhouse-transfer"; transfer_dir.mkdir(mode=0o700, exist_ok=True)
        for source_key in entries:
            relative = source_key.removeprefix(stage_root + "/")
            local = transfer_dir / pathlib.PurePosixPath(relative)
            local.parent.mkdir(parents=True, exist_ok=True)
            download(stage, source_key, local)
            key = remote_key(config["destination"], f"{owned_prefix}/{relative}")
            upload(config["destination"], local, key)
            keys.append(key); sizes[key] = local.stat().st_size; checksums[key] = sha256(local)
        manifest = {"engine": "clickhouse", "version": 1, "engineVersion": clickhouse_query(config["source"], "SELECT version()").strip(), "sourceIdentity": config["source"]["connectionId"], "sourceDatabase": config["source"].get("database", "default"), "artifactKeys": keys, "sizes": sizes, "fileChecksums": checksums, "ownedPrefix": owned_prefix, "nativeStagePrefix": stage_root}
        manifest["manifestSha256"] = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        manifest_path = transfer_dir / "manifest.json"; manifest_path.write_text(json.dumps(manifest, sort_keys=True)); os.chmod(manifest_path, 0o600)
        upload(config["destination"], manifest_path, remote_key(config["destination"], f"{owned_prefix}/manifest.json"))
        return manifest
    finally:
        delete_prefix(stage, stage_root)


def restore_clickhouse(config, manifest):
    stage = config.get("staging") or config["destination"]
    if stage.get("provider") != "s3": raise BackupError("clickhouse native restore requires S3 staging")
    if not manifest.get("nativeStagePrefix"):
        raise BackupError("clickhouse artifact has no native stage layout")
    restore_prefix = safe_part(stage.get("prefix", "database-backups")) + "/native-restore/" + config["runId"]
    transfer_dir = WORK / "clickhouse-restore"; transfer_dir.mkdir(mode=0o700, exist_ok=True)
    source_prefix = safe_part(manifest["ownedPrefix"])
    try:
        for source_key in manifest["artifactKeys"]:
            relative = source_key.removeprefix(source_prefix + "/")
            local = transfer_dir / pathlib.PurePosixPath(relative)
            local.parent.mkdir(parents=True, exist_ok=True)
            download(config["destination"], source_key, local)
            if sha256(local) != manifest["fileChecksums"].get(source_key): raise BackupError("clickhouse artifact checksum mismatch")
            upload(stage, local, remote_key(stage, f"{restore_prefix}/{relative}"))
        target = config["restoreTarget"]
        source_database = manifest.get("sourceDatabase")
        if not isinstance(source_database, str) or not source_database:
            raise BackupError("clickhouse artifact source database is missing")
        target_database = quote_identifier(target.get("database", "default"))
        clickhouse_query(target, f"RESTORE DATABASE {quote_source_identifier(source_database)} AS {target_database} FROM {clickhouse_s3(stage, restore_prefix.removeprefix(safe_part(stage.get('prefix', 'database-backups')) + '/'))}", timeout=config["limits"]["timeoutSeconds"])
    finally:
        delete_prefix(stage, restore_prefix)


def restore_redis(config, artifact):
    target = config["restoreTarget"]
    stage = config.get("redisStaging")
    if not stage: raise BackupError("external Redis restore requires node-created staged Redis")
    stage_dir = WORK / "redis-stage"; stage_dir.mkdir(mode=0o700, exist_ok=True)
    # The staged Redis starts as soon as dump.rdb exists, so it must appear complete.
    shutil.copyfile(artifact, stage_dir / "dump.rdb.tmp")
    os.replace(stage_dir / "dump.rdb.tmp", stage_dir / "dump.rdb")
    # A large dump takes long to load and to replicate: both waits use the
    # run's remaining time rather than fixed limits.
    deadline = time.time() + remaining_seconds(config)
    while time.time() < deadline:
        try:
            redis_command(stage, ["PING"]); break
        except BackupError: time.sleep(0.5)
    else: raise BackupError("staged Redis did not become ready")
    redis_command(target, ["PING"])
    previous_masterauth = redis_config_value(target, "masterauth")
    replication_started = False
    try:
        if stage.get("password"):
            redis_command_secret_last(target, ["CONFIG", "SET", "masterauth"], stage["password"])
        redis_command(target, ["REPLICAOF", stage["host"], str(stage["port"])])
        replication_started = True
        deadline = time.time() + remaining_seconds(config)
        while time.time() < deadline:
            info = redis_command(target, ["INFO", "replication"])
            if "master_sync_in_progress:0" in info and "master_link_status:up" in info and "role:slave" in info:
                break
            time.sleep(1)
        else:
            raise BackupError("Redis full synchronization did not complete")
    finally:
        if replication_started:
            try:
                redis_command(target, ["REPLICAOF", "NO", "ONE"])
            finally:
                redis_command_secret_last(target, ["CONFIG", "SET", "masterauth"], previous_masterauth)
                redis_command(target, ["SAVE"])


def redis_config_value(endpoint, key):
    lines = redis_command(endpoint, ["CONFIG", "GET", key]).replace("\r", "").split("\n")
    if len(lines) < 2 or lines[0] != key:
        raise BackupError("Redis target admin preflight failed")
    return lines[1]


def remote_key(endpoint, value):
    # Manifest keys remain logical bucket-relative object names regardless of
    # transport. Base paths belong only to FTP-family I/O, so control-plane
    # retention can delete by (bucket, key) without double-prefixing them.
    return safe_part(value)


def file_protocol_path(endpoint, logical_key):
    logical_key = remote_key(endpoint, logical_key)
    bucket = safe_part(endpoint.get("bucket", ""))
    base_path = endpoint.get("basePath", "")
    if not isinstance(base_path, str) or "\\" in base_path or any(ord(character) < 32 for character in base_path):
        raise BackupError("unsafe backup storage path")
    absolute = base_path.startswith("/")
    stripped = base_path.strip("/")
    if stripped and any(part in {"", ".", ".."} for part in stripped.split("/")):
        raise BackupError("unsafe backup storage path")
    prefix = ("/" if absolute else "") + stripped
    return "/".join(part for part in (prefix, bucket, logical_key) if part)


def rclone_config(endpoint):
    path = WORK / "rclone.conf"
    parsed = urllib.parse.urlparse(endpoint["endpoint"])
    lines = ["[target]", "type = s3", "provider = Other", f"endpoint = {parsed.scheme}://{parsed.netloc}", f"access_key_id = {endpoint.get('accessKeyId','')}", f"secret_access_key = {endpoint.get('secretAccessKey','')}"]
    if endpoint.get("region"): lines.append(f"region = {endpoint['region']}")
    lines.append(f"force_path_style = {'true' if endpoint.get('forcePathStyle') else 'false'}")
    lines.append("no_check_bucket = true")
    if endpoint.get("sessionToken"): lines.append(f"session_token = {endpoint['sessionToken']}")
    path.write_text("\n".join(lines) + "\n"); os.chmod(path, 0o600)
    return path


def rclone_args(endpoint, *args):
    command = ["rclone", "--config", str(rclone_config(endpoint))]
    if endpoint.get("caPem"):
        ca_path = WORK / "s3-ca.pem"
        ca_path.write_text(endpoint["caPem"])
        os.chmod(ca_path, 0o600)
        command.extend(["--ca-cert", str(ca_path)])
    return [*command, *args]


def list_objects(endpoint, prefix):
    if endpoint["provider"] != "s3": raise BackupError("native ClickHouse staging must use S3")
    raw = run(rclone_args(endpoint, "lsjson", "--recursive", f"target:{endpoint['bucket']}/{prefix}"))
    entries = json.loads(raw)
    return [remote_key(endpoint, f"{prefix}/{entry['Path']}") for entry in entries if not entry.get("IsDir")]


def upload(endpoint, local, remote):
    if endpoint["provider"] == "s3":
        run(rclone_args(endpoint, "copyto", str(local), f"target:{endpoint['bucket']}/{remote}")); return
    ftp_upload(endpoint, local, file_protocol_path(endpoint, remote))


def download(endpoint, remote, local):
    if endpoint["provider"] == "s3":
        run(rclone_args(endpoint, "copyto", f"target:{endpoint['bucket']}/{remote}", str(local))); return
    ftp_download(endpoint, file_protocol_path(endpoint, remote), local)


def delete_object(endpoint, remote):
    remote = remote_key(endpoint, remote)
    if endpoint["provider"] == "s3":
        run(rclone_args(endpoint, "deletefile", f"target:{endpoint['bucket']}/{remote}"))
        return
    ftp_delete(endpoint, file_protocol_path(endpoint, remote))


def delete_prefix(endpoint, prefix):
    if endpoint["provider"] != "s3":
        raise BackupError("native ClickHouse staging must use S3")
    prefix = safe_part(prefix)
    run(rclone_args(endpoint, "delete", "--rmdirs", f"target:{endpoint['bucket']}/{prefix}"))


class ImplicitFTP_TLS(ftplib.FTP_TLS):
    def connect(self, host="", port=0, timeout=-999):
        self.host = host
        self.port = port
        if timeout != -999: self.timeout = timeout
        self.sock = self.context.wrap_socket(
            socket.create_connection((self.host, self.port), self.timeout), server_hostname=self.host
        )
        self.af = self.sock.family
        self.file = self.sock.makefile("r", encoding=self.encoding)
        self.welcome = self.getresp()
        return self.welcome


def ftp_client(endpoint):
    if endpoint["provider"] == "sftp": return None
    context = ssl.create_default_context(cadata=endpoint.get("caPem"))
    if endpoint["provider"] == "ftps":
        client = ImplicitFTP_TLS(context=context) if endpoint.get("implicitTls") else ftplib.FTP_TLS(context=context)
    else:
        client = ftplib.FTP()
    client.connect(endpoint["host"], endpoint["port"], timeout=60)
    if endpoint["provider"] == "ftps" and not endpoint.get("implicitTls"):
        client.auth()
    client.login(endpoint.get("username", ""), endpoint.get("password", ""))
    if endpoint["provider"] == "ftps": client.prot_p()
    return client


def ftp_upload(endpoint, local, remote):
    if endpoint["provider"] == "sftp": return sftp_transfer(endpoint, local, remote, True)
    client = ftp_client(endpoint)
    try:
        ensure_ftp_dirs(client, pathlib.PurePosixPath(remote).parent)
        with local.open("rb") as source: client.storbinary("STOR " + remote, source)
    finally: client.quit()


def ftp_download(endpoint, remote, local):
    if endpoint["provider"] == "sftp": return sftp_transfer(endpoint, local, remote, False)
    client = ftp_client(endpoint)
    try:
        with local.open("wb") as target: client.retrbinary("RETR " + remote, target.write)
    finally: client.quit()


def ftp_delete(endpoint, remote):
    if endpoint["provider"] == "sftp": return sftp_delete(endpoint, remote)
    client = ftp_client(endpoint)
    try:
        client.delete(remote)
    finally: client.quit()


def ensure_ftp_dirs(client, path):
    current = "/" if path.is_absolute() else ""
    for part in path.parts:
        if part in {"", ".", "/"}: continue
        current = f"{current.rstrip('/')}/{part}" if current else part
        try: client.mkd(current)
        except ftplib.error_perm: pass


def file_remote_path(value):
    absolute = value.startswith("/")
    return ("/" if absolute else "") + safe_part(value.lstrip("/"))


def sftp_transfer(endpoint, local, remote, upload_mode):
    remote = file_remote_path(remote)
    transport = paramiko.Transport((endpoint["host"], endpoint["port"]))
    try:
        transport.start_client(timeout=60)
        remote_key = transport.get_remote_server_key()
        actual = "SHA256:" + base64.b64encode(hashlib.sha256(remote_key.asbytes()).digest()).decode().rstrip("=")
        expected = str(endpoint.get("hostKeyFingerprint", "")).rstrip("=")
        if not hmac.compare_digest(actual, expected):
            raise BackupError("SFTP host key fingerprint did not match pin")
        username = endpoint.get("username", "")
        if endpoint.get("privateKey"):
            private_key = load_sftp_private_key(endpoint["privateKey"], endpoint.get("passphrase"))
            transport.auth_publickey(username, private_key)
        elif endpoint.get("password"):
            transport.auth_password(username, endpoint["password"])
        else:
            raise BackupError("SFTP credentials are required")
        if not transport.is_authenticated():
            raise BackupError("SFTP authentication failed")
        client = paramiko.SFTPClient.from_transport(transport)
        try:
            if upload_mode:
                ensure_sftp_dirs(client, pathlib.PurePosixPath(remote).parent)
                client.put(str(local), remote, confirm=True)
            else:
                client.get(remote, str(local))
        finally:
            client.close()
    except BackupError:
        raise
    except Exception as error:
        raise BackupError("SFTP transfer failed") from error
    finally:
        transport.close()


def sftp_delete(endpoint, remote):
    remote = file_remote_path(remote)
    transport = paramiko.Transport((endpoint["host"], endpoint["port"]))
    try:
        transport.start_client(timeout=60)
        actual = "SHA256:" + base64.b64encode(hashlib.sha256(transport.get_remote_server_key().asbytes()).digest()).decode().rstrip("=")
        expected = str(endpoint.get("hostKeyFingerprint", "")).rstrip("=")
        if not hmac.compare_digest(actual, expected):
            raise BackupError("SFTP host key fingerprint did not match pin")
        username = endpoint.get("username", "")
        if endpoint.get("privateKey"):
            transport.auth_publickey(username, load_sftp_private_key(endpoint["privateKey"], endpoint.get("passphrase")))
        elif endpoint.get("password"):
            transport.auth_password(username, endpoint["password"])
        else:
            raise BackupError("SFTP credentials are required")
        client = paramiko.SFTPClient.from_transport(transport)
        try:
            client.remove(remote)
        finally:
            client.close()
    except BackupError:
        raise
    except Exception as error:
        raise BackupError("SFTP cleanup failed") from error
    finally:
        transport.close()


def load_sftp_private_key(value, passphrase):
    for key_type in (paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.RSAKey, paramiko.DSSKey):
        try:
            return key_type.from_private_key(io.StringIO(value), password=passphrase)
        except paramiko.SSHException:
            continue
    raise BackupError("SFTP private key is invalid")


def ensure_sftp_dirs(client, path):
    current = "/" if path.is_absolute() else ""
    for part in path.parts:
        if part in {"", ".", "/"}:
            continue
        current = f"{current.rstrip('/')}/{part}" if current else part
        try:
            client.stat(current)
        except IOError:
            client.mkdir(current)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""): digest.update(block)
    return digest.hexdigest()


def quote_source_identifier(value):
    # The source name comes from the backup itself and may be any name the
    # source server accepted (for example `my-app`); quote it rather than
    # requiring a plain identifier.
    if not isinstance(value, str) or not value or len(value) > 255 or any(ord(character) < 32 or character in "`\\" for character in value):
        raise BackupError("database identifier is invalid")
    return "`" + value + "`"


def quote_identifier(value):
    if not isinstance(value, str) or not value or not value.replace("_", "a").isalnum(): raise BackupError("database identifier is invalid")
    return '"' + value.replace('"', '""') + '"'


def sanitize(value):
    lowered = value.lower()
    for marker in ("password=", "secret=", "token=", "privatekey="):
        index = lowered.find(marker)
        if index >= 0: return value[:index] + marker + "[redacted]"
    return value.replace("\n", " ")[:2048]


if __name__ == "__main__":
    sys.exit(main())
