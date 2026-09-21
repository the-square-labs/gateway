import importlib.util
import hashlib
import base64
from unittest.mock import Mock, patch
import pathlib
import tempfile
import unittest


RUNNER = pathlib.Path(__file__).with_name("gateway-backup-runner.py")
SPEC = importlib.util.spec_from_file_location("gateway_backup_runner", RUNNER)
runner = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(runner)


class FileProtocolKeyTests(unittest.TestCase):
    def test_redis_restore_rejects_keys_in_any_logical_database(self):
        target = {"host": "redis.example.test", "port": 6379}
        with patch.object(runner, "redis_command", return_value="# Keyspace\ndb0:keys=0,expires=0,avg_ttl=0\ndb3:keys=1,expires=0,avg_ttl=0\n"):
            with self.assertRaises(runner.BackupError):
                runner.assert_empty_target("redis", target)

    def test_redis_restore_accepts_an_empty_instance(self):
        target = {"host": "redis.example.test", "port": 6379}
        with patch.object(runner, "redis_command", return_value="# Keyspace\n"):
            runner.assert_empty_target("redis", target)

    def test_redis_restore_rejects_unverified_or_malformed_keyspace(self):
        target = {"host": "redis.example.test", "port": 6379}
        for response in ("NOPERM this user has no permissions to run the 'info' command", "# Keyspace\ndb1:keys=-1,expires=0,avg_ttl=0\n", "# Keyspace\ndb1:keys=oops,expires=0,avg_ttl=0\n"):
            with self.subTest(response=response), patch.object(runner, "redis_command", return_value=response):
                with self.assertRaises(runner.BackupError):
                    runner.assert_empty_target("redis", target)

    def test_clickhouse_restore_downloads_each_artifact_once(self):
        original_work = runner.WORK
        with tempfile.TemporaryDirectory() as directory:
            runner.WORK = pathlib.Path(directory)
            config = {
                "runId": "run-1",
                "engine": "clickhouse",
                "limits": {"timeoutSeconds": 7200},
                "destination": {"provider": "s3", "endpoint": "https://destination.example.test", "bucket": "backups", "prefix": "nightly"},
                "staging": {"provider": "s3", "endpoint": "https://stage.example.test", "bucket": "stage", "prefix": "native", "accessKeyId": "key", "secretAccessKey": "secret"},
                "restoreTarget": {"database": "target"},
            }
            contents = {"nightly/run-1/a": b"a", "nightly/run-1/b": b"b"}
            manifest = {
                "artifactKeys": list(contents),
                "fileChecksums": {key: hashlib.sha256(value).hexdigest() for key, value in contents.items()},
                "ownedPrefix": "nightly/run-1",
                "nativeStagePrefix": "native/run-1",
                "sourceDatabase": "source",
            }

            def download(_, key, local):
                local.write_bytes(contents[key])

            with patch.object(runner, "download", side_effect=download) as downloaded, patch.object(runner, "upload"), patch.object(runner, "delete_prefix"), patch.object(runner, "clickhouse_query") as queried, patch.object(runner, "assert_empty_target"):
                runner.restore({**config, "restoreArtifact": manifest})
            self.assertEqual(downloaded.call_count, len(contents))
            # RESTORE is bounded by the run's limit, not the short default used for probes.
            self.assertEqual(queried.call_args.kwargs["timeout"], 7200)
        runner.WORK = original_work

    def test_manifest_key_never_contains_base_path_or_bucket(self):
        endpoint = {"provider": "sftp", "bucket": "archives", "basePath": "/gateway/backups"}
        logical = runner.remote_key(endpoint, "owned/run-1/database.dump")
        self.assertEqual(logical, "owned/run-1/database.dump")
        self.assertEqual(
            runner.file_protocol_path(endpoint, logical),
            "/gateway/backups/archives/owned/run-1/database.dump",
        )

    def test_sftp_hashes_the_host_key_and_preserves_absolute_base_path(self):
        key = b"verified-server-host-key"
        pin = "SHA256:" + base64.b64encode(hashlib.sha256(key).digest()).decode().rstrip("=")
        transport = Mock()
        transport.get_remote_server_key.return_value.asbytes.return_value = key
        client = Mock()
        with patch.object(runner.paramiko, "Transport", return_value=transport), patch.object(runner.paramiko.SFTPClient, "from_transport", return_value=client):
            runner.sftp_transfer({"host": "server", "port": 22, "hostKeyFingerprint": pin, "username": "user", "password": "secret"}, pathlib.Path("local"), "/upload/bucket/key", False)
            client.get.assert_called_once_with("/upload/bucket/key", "local")
            transport.auth_password.assert_called_once_with("user", "secret")
            transport.reset_mock()
            with self.assertRaises(runner.BackupError):
                runner.sftp_transfer({"host": "server", "port": 22, "hostKeyFingerprint": "SHA256:wrong", "username": "user", "password": "secret"}, pathlib.Path("local"), "/upload/bucket/key", False)
            transport.auth_password.assert_not_called()

    def test_control_characters_are_rejected_before_any_transport_call(self):
        with self.assertRaises(runner.BackupError):
            runner.remote_key({"provider": "sftp"}, "owned/run\n!shell")

    def test_rclone_uses_private_ca_and_session_token_without_disabling_tls(self):
        original_work = runner.WORK
        with tempfile.TemporaryDirectory() as directory:
            runner.WORK = pathlib.Path(directory)
            endpoint = {
                "provider": "s3",
                "endpoint": "https://127.0.0.1:9000",
                "accessKeyId": "key",
                "secretAccessKey": "secret",
                "sessionToken": "session-token",
                "caPem": "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
            }
            command = runner.rclone_args(endpoint, "lsjson", "target:bucket/prefix")
            self.assertIn("--ca-cert", command)
            self.assertNotIn("--no-check-certificate", command)
            config = (runner.WORK / "rclone.conf").read_text()
            self.assertIn("session_token = session-token", config)
            self.assertEqual((runner.WORK / "s3-ca.pem").stat().st_mode & 0o777, 0o600)
        runner.WORK = original_work

    def test_clickhouse_uses_native_endpoint_while_rclone_keeps_executor_endpoint(self):
        endpoint = {
            "endpoint": "https://127.0.0.1:9000",
            "nativeEndpoint": "https://storage-reachable.example.test",
            "bucket": "stage",
            "prefix": "native",
            "accessKeyId": "key",
            "secretAccessKey": "secret",
        }
        statement = runner.clickhouse_s3(endpoint, "run-1")
        self.assertIn("storage-reachable.example.test", statement)
        self.assertNotIn("127.0.0.1", statement)

    def test_clickhouse_preflight_probes_native_staging_without_backing_the_database_up(self):
        original_work = runner.WORK
        stage = {"provider": "s3", "endpoint": "https://stage.example.test", "bucket": "stage", "prefix": "native", "accessKeyId": "key", "secretAccessKey": "secret"}
        config = {"runId": "run-1", "engine": "clickhouse", "direction": "backup", "source": {"host": "ch.example.test", "port": 8123, "database": "app"}, "destination": stage}
        with tempfile.TemporaryDirectory() as directory:
            runner.WORK = pathlib.Path(directory)

            def download(_, __, local):
                local.write_bytes(b"gateway-backup-probe")

            with patch.object(runner, "clickhouse_query") as queried, patch.object(runner, "list_objects", return_value=["native/probe/run-1/probe.csv"]), patch.object(runner, "delete_prefix") as deleted, patch.object(runner, "upload"), patch.object(runner, "download", side_effect=download), patch.object(runner, "delete_object"):
                runner.preflight(config)
        runner.WORK = original_work
        statements = [call.args[1] for call in queried.call_args_list]
        self.assertFalse(any(statement.startswith("BACKUP") for statement in statements))
        probe = next(statement for statement in statements if statement.startswith("INSERT INTO FUNCTION s3("))
        self.assertIn("'https://stage.example.test/stage/native/probe/run-1/probe.csv'", probe)
        self.assertTrue(probe.endswith("'CSV', 'probe UInt8') SELECT 1"))
        deleted.assert_called_once_with(stage, "native/probe/run-1")

    def test_postgres_tools_follow_the_server_major_and_fall_back_to_the_image_default(self):
        original_tools = runner.POSTGRES_TOOLS
        with tempfile.TemporaryDirectory() as directory:
            runner.POSTGRES_TOOLS = pathlib.Path(directory)
            binary = pathlib.Path(directory) / "16" / "bin" / "pg_restore"
            binary.parent.mkdir(parents=True); binary.write_text("")
            (binary.parent / "pg_dump").write_text("")
            self.assertEqual(runner.postgres_tool("pg_dump", 16), str(binary.parent / "pg_dump"))
            self.assertEqual(runner.postgres_tool("pg_dump", 18), "pg_dump")
            target = {"host": "pg.example.test", "port": 5432, "database": "app"}
            with patch.object(runner, "postgres_major", return_value=16), patch.object(runner, "run") as ran:
                self.assertEqual(runner.postgres_restore_tool(target, pathlib.Path("database.dump")), str(binary))
                ran.assert_called_once_with([str(binary), "--list", "database.dump"])
            # An archive from a newer pg_dump is unreadable for the older client.
            with patch.object(runner, "postgres_major", return_value=16), patch.object(runner, "run", side_effect=runner.BackupError("native command failed")):
                self.assertEqual(runner.postgres_restore_tool(target, pathlib.Path("database.dump")), "pg_restore")
        runner.POSTGRES_TOOLS = original_tools


if __name__ == "__main__":
    unittest.main()
