// Node installers: every one parses, defines each function before the code that runs it at the top level, and
// completes a --dry-run for each profile, as root and with --user, with the host access switches, with its settings
// from the environment, and through setup-daemon.sh for each node type; every installer prints its help. The dry runs
// use a copy of the scripts whose root check passes for any user and whose host paths are under an empty directory,
// stub commands for docker, nginx and curl, and no network; a dry run changes nothing on the host.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const scriptsDir = path.resolve('scripts');
const installers = (await readdir(scriptsDir)).filter((name) => /^setup-.*\.sh$/.test(name)).sort();
const linux = process.platform === 'linux';
const CERT = `sha256:${'a'.repeat(64)}`;
const VERSION = 'v2.11.1';

// Top-level functions with their definition line and the functions their bodies call, and the top-level lines that
// run (outside function bodies and heredocs) with the functions they call.
function parseShell(source) {
  const lines = source.split('\n');
  const names = new Set();
  for (const line of lines) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\(\) \{/.exec(line);
    if (match) names.add(match[1]);
  }
  const functions = new Map();
  const topLevel = [];
  let current = null;
  let heredoc = null;
  lines.forEach((line, index) => {
    if (heredoc) {
      if ((heredoc.strip ? line.replace(/^\t+/, '') : line) === heredoc.word) heredoc = null;
      return;
    }
    const definition = current ? null : /^([A-Za-z_][A-Za-z0-9_]*)\(\) \{/.exec(line);
    if (definition) {
      current = { name: definition[1], line: index, calls: new Set() };
      functions.set(current.name, current);
    } else if (current && line === '}') {
      current = null;
      return;
    }
    // A trap handler runs when the trap fires, not where it is set.
    const code = /^\s*trap\s/.test(line) ? '' : executableText(line);
    const opened = /<<(-?)\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (opened) heredoc = { strip: opened[1] === '-', word: opened[2] };
    if (definition) return;
    const calls = [...code.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((word) => word[0]).filter((word) => names.has(word));
    if (current) for (const call of calls) current.calls.add(call);
    else if (calls.length > 0) topLevel.push({ line: index, calls });
  });
  return { functions, topLevel };
}

// The parts of a line the shell runs as commands: no comments, no single-quoted text, and of double-quoted text only
// command substitutions.
function executableText(line) {
  let out = '';
  let quote = null;
  let depth = 0;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      index++;
      continue;
    }
    if (quote === '"' && depth === 0) {
      if (char === '"') quote = null;
      else if (char === '$' && line[index + 1] === '(') {
        depth = 1;
        index++;
        out += ' ';
      }
      continue;
    }
    if (depth > 0) {
      if (char === '(') depth++;
      if (char === ')') depth--;
      if (depth > 0) out += char;
      else out += ' ';
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) break;
    out += char;
  }
  return out;
}

function definedBeforeUseErrors(source) {
  const { functions, topLevel } = parseShell(source);
  const errors = [];
  for (const { line, calls } of topLevel) {
    const seen = new Set();
    const pending = [...calls];
    while (pending.length > 0) {
      const name = pending.pop();
      if (seen.has(name)) continue;
      seen.add(name);
      const fn = functions.get(name);
      if (!fn) continue;
      if (fn.line > line) errors.push(`line ${line + 1} runs ${name}, defined at line ${fn.line + 1}`);
      pending.push(...fn.calls);
    }
  }
  return errors;
}

test('every installer parses and defines its functions before the top-level code runs them', async () => {
  assert.ok(installers.length >= 6, `found ${installers.join(', ')}`);
  for (const name of installers) {
    const source = await readFile(path.join(scriptsDir, name), 'utf8');
    if (linux) {
      const parsed = spawnSync('bash', ['-n', path.join(scriptsDir, name)], { encoding: 'utf8' });
      assert.equal(parsed.status, 0, `${name}: ${parsed.stderr}`);
    }
    assert.deepEqual(definedBeforeUseErrors(source), [], name);
  }
});

let work;
let sleeper;

before(async () => {
  if (!linux) return;
  work = await mkdtemp(path.join(tmpdir(), 'gateway-installers-'));
  const bin = path.join(work, 'bin');
  const copies = path.join(work, 'scripts');
  await spawnAsync('mkdir', ['-p', bin, copies]);
  for (const name of installers) {
    const source = await readFile(path.join(scriptsDir, name), 'utf8');
    // The root checks pass for the test user, and the host paths an installer reads or would write (/etc, /var, /run,
    // /usr/local) are under an empty directory, so a daemon already installed on the test host changes nothing.
    // Everything else runs as written.
    const copy = source
      .replaceAll('$EUID -ne 0', '0 -ne 0')
      .replaceAll('${EUID} -eq 0', '0 -eq 0')
      .replaceAll('"$EUID" -eq 0', '0 -eq 0')
      .replace(/(?<![\w.$/-])\/(etc|var|run|usr\/local)\//g, `${work}/host/$1/`)
      .replaceAll(`${work}/host/etc/os-release`, '/etc/os-release');
    await writeFile(path.join(copies, name), copy, { mode: 0o755 });
  }
  // A process of the --user account plays the nginx master that a non-root nginx-daemon requires.
  sleeper = spawn('sleep', ['600'], { stdio: 'ignore', detached: false });
  await writeFile(path.join(work, 'nginx.pid'), `${sleeper.pid}\n`);
  const stubs = {
    docker: `#!/bin/sh\ncase "$1" in version) echo 26.1.5 ;; info) echo ok ;; *) exit 0 ;; esac\n`,
    nginx: `#!/bin/sh\ncase "$1" in -v) echo "nginx version: nginx/1.26.3" >&2 ;; -V) echo "nginx version: nginx/1.26.3" >&2; echo "configure arguments: --pid-path=${work}/nginx.pid" >&2 ;; -T) echo "pid ${work}/nginx.pid;" ;; *) exit 0 ;; esac\n`,
    curl: '#!/bin/sh\necho "curl is stubbed: installer dry runs use no network" >&2\nexit 22\n',
  };
  for (const [name, body] of Object.entries(stubs)) {
    await writeFile(path.join(bin, name), body);
    await chmod(path.join(bin, name), 0o755);
  }
});

after(async () => {
  sleeper?.kill();
  if (work) await rm(work, { recursive: true, force: true });
});

function spawnAsync(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('close', resolve);
  });
}

function dryRun(script, args, env = {}) {
  const result = spawnSync('bash', [path.join(work, 'scripts', script), ...args, '--dry-run'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PATH: `${path.join(work, 'bin')}:${process.env.PATH}`, ...env },
    input: '',
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

const common = ['--gateway', 'gw.example.com:9443', '--token', 'gw_node_test', '--gateway-cert-sha256', CERT, '--version', VERSION];
const switches = [[], ['--disable-console', '--disable-files']];
// The account the non-root runs use: the test user, or nobody when the test runs as root.
const nonRootUser = userInfo().uid === 0 ? 'nobody' : userInfo().username;

test('every installer completes a dry run for each profile, as root and with --user', { skip: !linux }, () => {
  const runs = [];
  for (const extra of switches) {
    for (const user of ['root', nonRootUser]) {
      runs.push(['setup-monitoring-node.sh', ['-y', ...common, '--user', user, ...extra]]);
      runs.push(['setup-docker-node.sh', ['-y', ...common, '--mode', 'docker', '--user', user, ...extra]]);
      runs.push([
        'setup-relay-node.sh',
        [...common, '--advertise-address', 'relay.example.com', ...extra],
        { GATEWAY_RELAY_RUN_USER: user },
      ]);
    }
    // A non-root nginx-daemon needs an nginx master running as its user; the stub's pid file names one of the test
    // user. Root needs a root master, which the stub cannot provide without root.
    if (userInfo().uid === 0) runs.push(['setup-node.sh', ['-y', ...common, '--nginx-mode', 'integrate', ...extra]]);
    else runs.push(['setup-node.sh', ['-y', ...common, '--nginx-mode', 'integrate', '--user', nonRootUser, ...extra]]);
    for (const mode of ['builder', 'storage', 'databases']) {
      runs.push(['setup-docker-node.sh', ['-y', ...common, '--mode', mode, ...extra]]);
    }
    runs.push(['setup-storage-node.sh', ['-y', ...common, ...extra]]);
    runs.push(['setup-database-node.sh', ['-y', ...common, ...extra]]);
  }
  for (const [script, args, env] of runs) {
    const { status, output } = dryRun(script, args, env);
    assert.equal(status, 0, `${script} ${args.join(' ')}\n${output}`);
    assert.doesNotMatch(output, /command not found/, `${script} ${args.join(' ')}\n${output}`);
    if (args.includes('--disable-console')) assert.match(output, /console\.enabled: false/, `${script}\n${output}`);
  }
});

// Each environment variable an installer documents as the equivalent of an option reaches the run: a dry run gets
// all its settings from the environment, and an invalid value is refused like the option's.
test('the installers take their settings from the environment', { skip: !linux }, () => {
  const settings = {
    GATEWAY_NODE_TOKEN: 'gw_node_test',
    GATEWAY_NODE_CERT_SHA256: CERT,
    GATEWAY_NODE_DAEMON_VERSION: VERSION,
    GATEWAY_NODE_DISABLE_CONSOLE: '1',
    GATEWAY_NODE_DISABLE_FILES: '1',
  };
  const address = { ...settings, GATEWAY_NODE_ADDRESS: 'gw.example.com:9443' };
  const hostPort = { ...settings, GATEWAY_NODE_HOST: 'gw.example.com', GATEWAY_NODE_PORT: '9443' };
  const nginxUser = userInfo().uid === 0 ? [] : ['--user', nonRootUser];
  const relayArgs = [
    ...['--gateway', 'gw.example.com:9443', '--token', 'gw_node_test', '--gateway-cert-sha256', CERT],
    ...['--advertise-address', 'relay.example.com', '--service-port', '853', '--version', VERSION],
  ];
  const runs = [
    ['setup-monitoring-node.sh', ['-y'], address, /monitoring-daemon installed \(v2\.11\.1; dry run\)/],
    ['setup-monitoring-node.sh', ['-y'], hostPort, /files\.enabled: false/],
    [
      'setup-node.sh',
      ['-y', ...nginxUser],
      { ...hostPort, GATEWAY_NODE_NGINX_MODE: 'integrate', GATEWAY_NODE_SKIP_NGINX: '1' },
      /nginx configuration updated \(integrate mode; dry run\)/,
    ],
    [
      'setup-docker-node.sh',
      ['-y'],
      { ...address, GATEWAY_DOCKER_MODE: 'builder', GATEWAY_BUILDER_EGRESS_PROFILE: 'offline' },
      /Build Worker profile/,
    ],
    ['setup-docker-node.sh', ['-y'], { ...hostPort, GATEWAY_DOCKER_SECURE_RUNTIME: '1' }, /Secure Runtime/],
    [
      'setup-database-node.sh',
      ['-y', ...common],
      { GATEWAY_DATABASE_STORAGE_ROOT: '/srv/gateway-test' },
      /storage: \/srv\/gateway-test/,
    ],
    ['setup-database-node.sh', ['-y', ...common, '--storage-root', '/srv/gw-flag'], {}, /storage: \/srv\/gw-flag/],
    ['setup-storage-node.sh', ['-y', ...common], {}, /Database docker profile written/],
    [
      'setup-relay-node.sh',
      relayArgs,
      {
        ...settings,
        GATEWAY_RELAY_RUN_USER: nonRootUser,
        GATEWAY_RELAY_RUN_GROUP: userInfo().uid === 0 ? 'nogroup' : '',
      },
      /files\.enabled: false/,
    ],
  ];
  for (const [script, args, env, expected] of runs) {
    const { status, output } = dryRun(script, args, env);
    assert.equal(status, 0, `${script} ${JSON.stringify(env)}\n${output}`);
    assert.match(output, expected, `${script} ${JSON.stringify(env)}\n${output}`);
    if (env.GATEWAY_NODE_DISABLE_CONSOLE) assert.match(output, /console\.enabled: false/, `${script}\n${output}`);
  }
  const relay = dryRun('setup-relay-node.sh', relayArgs, { GATEWAY_RELAY_RUN_USER: nonRootUser });
  assert.match(relay.output, /CAP_NET_BIND_SERVICE for port 853/, relay.output);
  // The Gateway address in two parts, as options.
  const parts = ['--host', 'gw.example.com', '--port', '9443', '--no-logo'];
  const credentials = ['--token', 'gw_node_test', '--gateway-cert-sha256', CERT, '--version', VERSION];
  for (const [script, extra] of [
    ['setup-monitoring-node.sh', []],
    ['setup-docker-node.sh', ['--mode', 'docker']],
    ['setup-node.sh', ['--nginx-mode', 'integrate', ...nginxUser]],
  ]) {
    const { status, output } = dryRun(script, ['-y', ...parts, ...credentials, ...extra]);
    assert.equal(status, 0, `${script}\n${output}`);
  }

  const refused = [
    [
      'setup-docker-node.sh',
      ['-y'],
      { ...address, GATEWAY_BUILDER_EGRESS_PROFILE: 'none' },
      /Invalid --builder-egress 'none'/,
    ],
    ['setup-docker-node.sh', ['-y'], { ...address, GATEWAY_DOCKER_MODE: 'cluster' }, /Invalid --mode 'cluster'/],
    [
      'setup-docker-node.sh',
      ['-y'],
      { ...address, GATEWAY_DOCKER_MODE: 'storage', GATEWAY_DOCKER_SECURE_RUNTIME: '1' },
      /--secure-runtime applies to the docker profile only/,
    ],
    ['setup-node.sh', ['-y', ...nginxUser], { ...address, GATEWAY_NODE_NGINX_MODE: 'x' }, /Unknown nginx mode: x/],
    ['setup-database-node.sh', ['-y', ...common, '--user', nonRootUser], {}, /must run docker-daemon as root/],
    [
      'setup-relay-node.sh',
      relayArgs,
      { GATEWAY_RELAY_RUN_USER: nonRootUser, GATEWAY_RELAY_RUN_GROUP: 'gateway-no-such-group' },
      /does not exist; Relay installation stopped/,
    ],
    [
      'setup-relay-node.sh',
      relayArgs,
      { GATEWAY_RELAY_RUN_USER: 'gateway-no-such-user' },
      /does not exist; Relay installation stopped/,
    ],
  ];
  for (const [script, args, env, expected] of refused) {
    const { status, output } = dryRun(script, args, env);
    assert.notEqual(status, 0, `${script} ${JSON.stringify(env)}\n${output}`);
    assert.match(output, expected, `${script} ${JSON.stringify(env)}\n${output}`);
  }
});

// setup-daemon.sh runs the installer of each node type from a local directory and forwards the other arguments.
test('setup-daemon.sh dispatches every node type to its installer', { skip: !linux }, () => {
  const copies = path.join(work, 'scripts');
  const nginxUser = userInfo().uid === 0 ? [] : ['--user', nonRootUser];
  const types = {
    monitoring: 'setup-monitoring-node.sh',
    docker: 'setup-docker-node.sh',
    storage: 'setup-storage-node.sh',
    databases: 'setup-database-node.sh',
    nginx: 'setup-node.sh',
  };
  // setup-daemon.sh keeps --version for itself (the release of the installers), so the daemon release comes from the
  // environment.
  const args = ['-y', '--gateway', 'gw.example.com:9443', '--token', 'gw_node_test', '--gateway-cert-sha256', CERT];
  const env = { GATEWAY_NODE_DAEMON_VERSION: VERSION };
  for (const [type, script] of Object.entries(types)) {
    const extra = type === 'nginx' ? ['--nginx-mode', 'integrate', ...nginxUser] : [];
    const viaFlag = dryRun('setup-daemon.sh', ['--type', type, '--script-dir', copies, ...args, ...extra], env);
    assert.equal(viaFlag.status, 0, `${type}\n${viaFlag.output}`);
    assert.match(viaFlag.output, new RegExp(`Running local ${script.replace('.', '\\.')}`), viaFlag.output);
    const viaEnv = dryRun('setup-daemon.sh', ['--type', type, ...args, ...extra], {
      ...env,
      GATEWAY_SETUP_SCRIPT_DIR: copies,
    });
    assert.equal(viaEnv.status, 0, `${type}\n${viaEnv.output}`);
  }
  const unknown = dryRun('setup-daemon.sh', ['--type', 'gateway', '--script-dir', copies]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.output, /Unknown daemon type: gateway/);
});

test('every installer prints its help', { skip: !linux }, () => {
  for (const name of [...installers, 'install.sh']) {
    const source = path.join(name === 'install.sh' ? scriptsDir : path.join(work, 'scripts'), name);
    const result = spawnSync('bash', [source, '--help'], { encoding: 'utf8', timeout: 30_000, input: '' });
    assert.equal(result.status, 0, `${name}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Usage/i, name);
  }
});

// The OpenRC services of a daemon with its own user. supervise-daemon opens the output and error logs after it
// drops to that user, so the service has to give it the files first (checkpath runs as root, before the drop); a
// daemon that goes back to root takes them back the same way.
function openrcUserServices(source) {
  const lines = source.split('\n');
  const services = [];
  lines.forEach((line, index) => {
    if (line !== '#!/sbin/openrc-run') return;
    let end = index;
    while (lines[end] !== 'UNIT') end++;
    if (lines.slice(index, end).some((entry) => entry.startsWith('command_user='))) services.push({ index, end });
  });
  return { lines, services };
}

// Renders the service the installer would write for the account, with the text the installer builds before it.
function renderOpenrcService(source, user, group) {
  const { lines, services } = openrcUserServices(source);
  assert.equal(services.length, 1);
  const [{ index, end }] = services;
  assert.match(lines[index - 1], /<<UNIT/, 'the service text follows its heredoc line');
  const prefixStart = lines.findIndex((line, at) => at < index && /^\s+local unit_runtime=/.test(line));
  const prefixEnd = lines.findIndex((line, at) => at > prefixStart && line === '    if has_systemd; then');
  const prefix = prefixStart > 0 ? lines.slice(prefixStart, prefixEnd) : [];
  const script = [
    `RUN_USER=${user}; RUN_GROUP=${group}; openrc_need="net docker"; NGINX_DAEMON_RUNTIME_DIRS=(nginx-daemon gateway-secure-links)`,
    'render() {',
    ...prefix,
    'cat <<UNIT',
    ...lines.slice(index, end),
    'UNIT',
    '}',
    'render',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const OPENRC_OWNED_LOGS = {
  'setup-monitoring-node.sh': 'monitoring-daemon',
  'setup-docker-node.sh': 'docker-daemon',
  'setup-node.sh': 'nginx-daemon',
  'setup-relay-node.sh': 'gateway-relay-supervisor',
};

test('OpenRC services of a non-root daemon hand their log files over before the privilege drop', () => {
  for (const [script, daemon] of Object.entries(OPENRC_OWNED_LOGS)) {
    const source = readFileSync(path.join(scriptsDir, script), 'utf8');
    for (const [user, group] of [
      ['svcuser', 'svcgroup'],
      ['root', 'root'],
    ]) {
      const service = renderOpenrcService(source, user, group);
      assert.match(service, new RegExp(`^command_user="${user}:${group}"$`, 'm'), `${script}\n${service}`);
      assert.match(service, new RegExp(`^output_log="/var/log/${daemon}\\.log"$`, 'm'), script);
      assert.match(service, new RegExp(`^error_log="/var/log/${daemon}\\.err"$`, 'm'), script);
      const startPre = /^start_pre\(\) \{\n([\s\S]*?)^\}$/m.exec(service);
      assert.ok(startPre, `${script} has a start_pre\n${service}`);
      for (const log of [`${daemon}.log`, `${daemon}.err`]) {
        assert.ok(
          startPre[1].includes(`    checkpath --file --owner ${user}:${group} --mode 0640 /var/log/${log}\n`),
          `${script} gives ${log} to ${user}:${group}\n${service}`
        );
      }
    }
  }
  // A non-root nginx-daemon keeps the runtime directories it already got.
  const nginx = renderOpenrcService(readFileSync(path.join(scriptsDir, 'setup-node.sh'), 'utf8'), 'svcuser', 'svcgroup');
  assert.match(nginx, /checkpath --directory --mode 0755 --owner svcuser:svcgroup "\/run\/\${dir}"/);
  assert.match(nginx, /^capabilities="\^cap_net_bind_service"$/m);
  // No other generated OpenRC service drops privileges: the lease watchdog runs as root.
  for (const name of installers) {
    const { services } = openrcUserServices(readFileSync(path.join(scriptsDir, name), 'utf8'));
    assert.equal(services.length, name in OPENRC_OWNED_LOGS ? 1 : 0, name);
  }
});

test('an installer that cannot keep the OpenRC service up says so and shows the supervise-daemon reason', () => {
  for (const [script, daemon] of Object.entries(OPENRC_OWNED_LOGS)) {
    const source = readFileSync(path.join(scriptsDir, script), 'utf8');
    assert.match(source, /is not running; the service manager could not keep it up/, script);
    // supervise-daemon logs why it could not start the service to the system log, not to the service's own logs.
    const filter = daemon === 'gateway-relay-supervisor' ? 'gateway-relay' : daemon;
    assert.ok(source.includes(`grep -h 'supervise-daemon.*${filter}' /var/log/messages`), script);
  }
});

// A host that cannot run the Build Worker profile (it needs systemd) fails the install before the installer installs
// packages, downloads or writes anything.
test('the Build Worker host check runs before any host change', () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-docker-node.sh'), 'utf8');
  const { topLevel } = parseShell(source);
  assert.match(source, /preflight_builder_host\(\) \{\n[^}]*has_systemd \|\|/);
  assert.doesNotMatch(source, /preflight_builder_runtime\(\) \{\n[^}]*has_systemd/, 'the late preflight does not own the host check');
  const firstRun = (name) => Math.min(...topLevel.filter((entry) => entry.calls.includes(name)).map((entry) => entry.line));
  const check = firstRun('preflight_builder_host');
  assert.ok(Number.isFinite(check), 'the host check runs at the top level');
  for (const change of [
    'check_dependencies',
    'ensure_docker_installed',
    'ensure_builder_system_packages',
    'prepare_run_user_switch',
    'create_directories',
    'install_daemon',
    'install_builder_runtime',
  ]) {
    assert.ok(check < firstRun(change), `the host check runs before ${change}`);
  }
});

test('a Build Worker install on a host without systemd stops before it changes anything', { skip: !linux }, () => {
  const host = path.join(work, 'host');
  const result = spawnSync('bash', [path.join(work, 'scripts', 'setup-docker-node.sh'), '-y', ...common, '--mode', 'builder'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PATH: `${path.join(work, 'bin')}:${process.env.PATH}` },
    input: '',
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /Builder nodes require systemd/, output);
  assert.doesNotMatch(output, /Installing|Downloading|Creating required directories/, output);
  assert.equal(spawnSync('test', ['-e', path.join(host, 'usr/local/bin/docker-daemon')]).status, 1);
  assert.equal(spawnSync('test', ['-e', path.join(host, 'etc/docker-daemon')]).status, 1);
});

// A top-level shell function of an installer, to run on its own.
function shellFunction(source, name) {
  const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm').exec(source);
  assert.ok(match, `${name} is defined`);
  return match[0];
}

function runShell(script) {
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

// The managed nginx.conf names the pid file the host's nginx service watches. Alpine's service watches
// /run/nginx/nginx.pid; a pid file elsewhere leaves OpenRC without a master process (the service reads "crashed" and
// cannot restart while the old master keeps its ports). Debian and Ubuntu name /run/nginx.pid in the unit.
test('managed nginx.conf names the pid file of the distribution service', { skip: !linux }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-node.sh'), 'utf8');
  assert.doesNotMatch(source, /^pid \/run\/nginx\.pid;$/m, 'the pid file is not hardcoded');
  assert.match(source, /^pid __NGINX_PID_FILE__;$/m);
  assert.match(source, /s\|__NGINX_PID_FILE__\|\$\(nginx_service_pid_file\)\|g/);
  const dir = await mkdtemp(path.join(tmpdir(), 'gateway-nginx-pid-'));
  try {
    const initScript = path.join(dir, 'nginx');
    const body = shellFunction(source, 'nginx_service_pid_file').replaceAll('/etc/init.d/nginx', initScript);
    const pidFile = (setup) => runShell(`${setup}\n${body}\nnginx_service_pid_file`).output.trim();
    const stubs = (systemd, systemctlOut, built) =>
      [
        `has_systemd() { return ${systemd ? 0 : 1}; }`,
        `has_openrc() { return ${systemd ? 1 : 0}; }`,
        `systemctl() { echo '${systemctlOut}'; }`,
        `nginx() { echo 'configure arguments: --prefix=/usr --pid-path=${built}' >&2; }`,
      ].join('\n');
    await writeFile(initScript, '#!/sbin/openrc-run\npidfile=/run/nginx/nginx.pid\ncommand=/usr/sbin/nginx\n');
    assert.equal(pidFile(stubs(false, '', '/run/nginx.pid')), '/run/nginx/nginx.pid');
    await writeFile(initScript, '#!/sbin/openrc-run\npidfile="/var/run/nginx.pid"\n');
    assert.equal(pidFile(stubs(false, '', '/run/nginx.pid')), '/var/run/nginx.pid');
    await writeFile(initScript, '#!/sbin/openrc-run\npidfile="${PIDFILE:-/x}"\n');
    assert.equal(pidFile(stubs(false, '', '/run/built.pid')), '/run/built.pid');
    assert.equal(pidFile(stubs(true, '/run/nginx.pid', '/run/built.pid')), '/run/nginx.pid');
    assert.equal(pidFile(stubs(true, '', '/run/built.pid')), '/run/built.pid');
    assert.equal(pidFile(stubs(true, '', '').replace(/nginx\(\) \{.*\}/, 'nginx() { :; }')), '/run/nginx.pid');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The installer secures the pid directory of Alpine's nginx service for a root nginx (the stock service gives it to the
// unprivileged nginx user on every start and reload). The service must still give the directory to the user nginx runs
// as when /etc/conf.d/nginx sets command_user, which is how docs/nodes.md prepares a non-root nginx.
test('the secured nginx OpenRC service gives the pid directory to the user nginx runs as', { skip: !linux }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-node.sh'), 'utf8');
  const dir = await mkdtemp(path.join(tmpdir(), 'gateway-nginx-openrc-'));
  try {
    const service = path.join(dir, 'nginx');
    const stock = [
      '#!/sbin/openrc-run',
      'pidfile=/run/nginx/nginx.pid',
      'start_pre() {',
      '\tcheckpath --directory --owner nginx:nginx ${pidfile%/*}',
      '}',
      'reload_pre() {',
      '\tcheckpath --directory --owner nginx:nginx ${pidfile%/*}',
      '}',
      '',
    ].join('\n');
    const earlier = stock.replaceAll('--owner nginx:nginx', '--mode 0755 --owner root:root');
    const body = shellFunction(source, 'ensure_nginx_openrc_pid_directory').replaceAll('/etc/init.d', dir);
    const migrate = async (content, runUser) => {
      await writeFile(service, content, { mode: 0o755 });
      const result = runShell(
        [
          source.split('\n').filter((line) => /^NGINX_OPENRC_(STOCK|EARLIER)_LINE=/.test(line)).join('\n'),
          'has_openrc() { return 0; }',
          'die() { echo "$*" >&2; exit 1; }',
          'log() { :; }',
          'backup_if_exists() { :; }',
          // The service directories are root-owned and not writable by others on a host; the test files are not.
          'stat() { case "$*" in "-c %u"*) echo 0 ;; *) echo 755 ;; esac; }',
          `RUN_USER=${runUser}`,
          body,
          'ensure_nginx_openrc_pid_directory',
        ].join('\n')
      );
      assert.equal(result.status, 0, result.output);
      return readFileSync(service, 'utf8');
    };
    // The owner the start and reload steps hand /run/nginx to, with and without command_user.
    const owners = (content, commandUser) => {
      const lines = content.split('\n').filter((line) => line.includes('checkpath'));
      assert.equal(lines.length, 2, content);
      return lines.map((line) => {
        const result = runShell(
          [
            'checkpath() { echo "$@"; }',
            'pidfile=/run/nginx/nginx.pid',
            commandUser ? `command_user=${commandUser}` : '',
            line.trim(),
          ].join('\n')
        );
        return result.output.trim();
      });
    };
    for (const [content, runUser] of [
      [stock, 'root'],
      [earlier, 'root'],
      [earlier, 'nginx'],
    ]) {
      const secured = await migrate(content, runUser);
      assert.deepEqual(owners(secured, ''), Array(2).fill('--directory --mode 0755 --owner root:root /run/nginx'));
      assert.deepEqual(owners(secured, 'nginx:nginx'), Array(2).fill('--directory --mode 0755 --owner nginx:nginx /run/nginx'));
      assert.equal(await migrate(secured, runUser), secured, 'migrating twice changes nothing');
    }
    // A non-root daemon next to the stock service leaves the operator's pid directory alone.
    assert.equal(await migrate(stock, 'nginx'), stock);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A daemon that moves to another user says so, in both directions.
test('every installer announces the switch of the run user from root and to root', { skip: !linux }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gateway-run-user-'));
  try {
    const configs = {
      'setup-monitoring-node.sh': '/etc/monitoring-daemon',
      'setup-docker-node.sh': '/etc/docker-daemon',
      'setup-node.sh': '/etc/nginx-daemon',
      'setup-relay-node.sh': '/etc/gateway-relay-supervisor',
    };
    for (const [script, config] of Object.entries(configs)) {
      const source = readFileSync(path.join(scriptsDir, script), 'utf8');
      const body = shellFunction(source, 'prepare_run_user_switch').replaceAll(config, path.join(dir, 'conf'));
      const run = (runUser, previousUid) =>
        runShell(
          [
            'log() { echo "$*"; }',
            `PREVIOUS_RUN_UID=${previousUid}`,
            `RUN_USER=${runUser}`,
            body,
            'prepare_run_user_switch',
          ].join('\n')
        );
      // No installation yet: a fresh install does not switch anything.
      assert.doesNotMatch(run('gwsvc', 0).output, /switching/, script);
      await rm(path.join(dir, 'conf'), { recursive: true, force: true });
      runShell(`mkdir -p '${path.join(dir, 'conf')}'`);
      const toUser = run('gwsvc', 0);
      assert.equal(toUser.status, 0, `${script}\n${toUser.output}`);
      assert.match(toUser.output, /ran as root; switching it to gwsvc/, script);
      assert.doesNotMatch(run('root', 0).output, /switching/, `${script} stays root`);
      await rm(path.join(dir, 'conf'), { recursive: true, force: true });
    }
    // Leaving a non-root user is announced by the same function before the daemon is stopped.
    for (const script of Object.keys(configs)) {
      const source = readFileSync(path.join(scriptsDir, script), 'utf8');
      assert.match(source, /ran as \$\(id -nu "\$PREVIOUS_RUN_UID"/, script);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A Docker node needs the memory, cpu and pids cgroup controllers for its containers (the Secure Link connector sets
// all three limits). Where the root cgroup passes none down (an LXC guest with OpenRC) Docker starts, a container with
// limits does not, and the node would enroll without its connectors. The installer refuses before it enrolls.
test('the Docker installer refuses a host whose containers cannot get the cgroup controllers', { skip: !linux }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-docker-node.sh'), 'utf8');
  const { topLevel } = parseShell(source);
  const firstRun = (name) => Math.min(...topLevel.filter((entry) => entry.calls.includes(name)).map((entry) => entry.line));
  const check = firstRun('preflight_docker_cgroup_controllers');
  assert.ok(Number.isFinite(check), 'the check runs at the top level');
  assert.ok(firstRun('ensure_docker_installed') < check, 'after Docker is present');
  for (const later of ['install_daemon', 'enroll_daemon', 'start_daemon']) {
    assert.ok(check < firstRun(later), `before ${later}`);
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'gateway-cgroup-'));
  try {
    const body = shellFunction(source, 'preflight_docker_cgroup_controllers').replaceAll('/sys/fs/cgroup', dir);
    const write = (name, content) => runShell(`mkdir -p '${path.dirname(path.join(dir, name))}' && printf '%s\\n' '${content}' > '${path.join(dir, name)}'`);
    const check_ = (info, { DOCKER_MODE = 'docker' } = {}) =>
      runShell(
        [
          // The installer runs with IFS=$'\n\t' (set at its top); the check must not depend on the default IFS.
          "IFS=$'\\n\\t'",
          `DOCKER_MODE=${DOCKER_MODE}; LOG_FILE=/dev/null`,
          // The real docker CLI evaluates the template against moby's system.Info Go field names (CPUCfsQuota, not
          // the JSON name CpuCfsQuota); a wrong name fails the command, and the check would be skipped.
          'docker_run() { case "$*" in *"{{.CgroupVersion}} {{.CgroupDriver}} {{.MemoryLimit}} {{.PidsLimit}} {{.CPUCfsQuota}}"*) echo "' +
            info +
            '" ;; *) echo "template: cannot evaluate field" >&2; return 1 ;; esac; }',
          'warn() { echo "WARN $*"; }',
          'err() { echo "ERR $*" >&2; }',
          'die() { err "$@"; exit 1; }',
          body,
          'preflight_docker_cgroup_controllers && echo PASSED',
        ].join('\n')
      );
    const all = '2 cgroupfs true true true';
    // The controllers pass down to Docker's cgroup.
    write('docker/cgroup.controllers', 'cpu memory pids');
    assert.match(check_(all).output, /PASSED/);
    // An empty root cgroup: Docker's cgroup has none.
    write('docker/cgroup.controllers', '');
    const empty = check_(all);
    assert.equal(empty.status, 1, empty.output);
    assert.match(empty.output, /cannot give containers the cgroup controllers: cpu memory pids\./);
    assert.match(empty.output, /Alpine with OpenRC in an LXC container/);
    assert.match(empty.output, /nothing was enrolled/);
    // Only the missing one is named; the root cgroup is read when Docker has no cgroup yet.
    write('docker/cgroup.controllers', 'cpu memory');
    assert.match(check_(all).output, /controllers: pids\./);
    runShell(`rm '${path.join(dir, 'docker/cgroup.controllers')}'`);
    write('cgroup.subtree_control', 'cpuset cpu io memory pids');
    assert.match(check_(all).output, /PASSED/);
    write('cgroup.subtree_control', '');
    assert.match(check_(all).output, /controllers: cpu memory pids\./);
    // docker info says the kernel lacks a controller (cgroup v1 too); the systemd driver reads no files.
    assert.match(check_('1 cgroupfs true false true').output, /controllers: pids\./);
    assert.match(check_('2 systemd true true true').output, /PASSED/);
    // A Build Worker has no Docker.
    assert.match(check_('2 cgroupfs false false false', { DOCKER_MODE: 'builder' }).output, /PASSED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Without -y an installer asks on the terminal. A terminal that cannot be read (no controlling terminal, or sudo's pty
// with a piped stdout, where the read fails with EIO) answers nothing, and a default must not stand in for the answer:
// an unreadable terminal used to read as "yes" to "Proceed?" and to the nginx upgrade from nginx.org.
test('a terminal that cannot be read is never answered with a default', { skip: !linux }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gateway-tty-'));
  try {
    const answers = path.join(dir, 'answers');
    const unreadable = { missing: path.join(dir, 'no-such-tty'), 'a read error': dir };
    const helpers = {
      'setup-node.sh': ['prompt_input', 'prompt_secret', 'prompt_yes_no', 'prompt_choice'],
      'setup-docker-node.sh': ['prompt_input', 'prompt_secret', 'prompt_yes_no', 'prompt_choice'],
      'setup-monitoring-node.sh': ['prompt_input', 'prompt_secret', 'prompt_yes_no', 'prompt_choice'],
      'setup-database-node.sh': ['prompt_choice'],
    };
    for (const [script, names] of Object.entries(helpers)) {
      const source = readFileSync(path.join(scriptsDir, script), 'utf8');
      assert.doesNotMatch(source, /\[\[? -e \/dev\/tty \]\]?/, `${script} reads the terminal and checks the result`);
      assert.doesNotMatch(source, /reply="\$default"|\|\| reply=""/, script);
      const prelude = [
        'set -euo pipefail',
        'NON_INTERACTIVE=0; BRAND_MINT=""; NC=""; BOLD=""; GRAY=""; TERM=dumb',
        'err() { echo "ERR $*" >&2; }',
        'die() { err "$@"; exit 1; }',
        shellFunction(source, 'refuse_unanswered_prompt'),
        ...names.map((name) => shellFunction(source, name)),
      ];
      const calls = {
        // The installers assign the answer in a plain assignment, where set -e stops them when the helper fails.
        prompt_input: 'answer=$(prompt_input "Host" "default-host"); echo "got=${answer}"',
        prompt_secret: 'answer=$(prompt_secret "Token"); echo "got=${answer}"',
        prompt_yes_no: 'if prompt_yes_no "Upgrade nginx now?" "Y"; then echo "got=yes"; else echo "got=no"; fi',
        prompt_choice: 'answer=$(prompt_choice "Choose" "1" "root" "user"); echo "got=${answer}"',
      };
      for (const name of names) {
        for (const [what, tty] of Object.entries(unreadable)) {
          const body = prelude.map((part) => part.replaceAll('/dev/tty', tty));
          const result = runShell([...body, calls[name], 'echo AFTER'].join('\n'));
          assert.equal(result.status, 1, `${script} ${name} with a terminal that is ${what}\n${result.output}`);
          assert.match(result.output, /Cannot read an answer from the terminal/, `${script} ${name}`);
          assert.match(result.output, /pass -y to install non-interactively/, `${script} ${name}`);
          assert.doesNotMatch(result.output, /got=|AFTER/, `${script} ${name} did not default (${what})`);
        }
        // A readable terminal still answers, and an empty reply takes the default shown to the user.
        const answered = (reply) => {
          runShell(`printf '%s' '${reply}' > '${answers}'`);
          const body = prelude.map((part) => part.replaceAll('/dev/tty', answers));
          return runShell([...body, calls[name]].join('\n'));
        };
        assert.equal(answered('\n').status, 0, `${script} ${name}`);
        if (name === 'prompt_yes_no') {
          assert.match(answered('n\n').output, /got=no/, script);
          assert.match(answered('y\n').output, /got=yes/, script);
          assert.match(answered('\n').output, /got=yes/, script);
        }
        if (name === 'prompt_input') assert.match(answered('\n').output, /got=default-host/, script);
      }
    }
    // The node type menu of setup-daemon.sh does not pick its default for an unreadable terminal either.
    const daemon = readFileSync(path.join(scriptsDir, 'setup-daemon.sh'), 'utf8');
    assert.match(daemon, /read -r reply < "\$tty" 2>\/dev\/null \|\| die "Cannot read an answer from the terminal/);
    // -y stays the way to run without a terminal, and it still refuses an nginx upgrade it cannot ask about.
    const node = readFileSync(path.join(scriptsDir, 'setup-node.sh'), 'utf8');
    assert.match(node, /if \[\[ "\$NON_INTERACTIVE" -eq 1 \]\]; then\n\s+die "nginx \$\{NGINX_MIN_VERSION\}\+ is required\. Re-run interactively to approve the stable nginx upgrade\."/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// An Alpine host whose nginx service still has the PID-directory line an earlier installer wrote (owner root:root), and
// whose operator ran nginx as the daemon's user (command_user in /etc/conf.d/nginx) before installing: that nginx
// cannot start, so there is no nginx master to find. The preflight only detects this and the summary announces the
// repair; the service line is migrated and nginx started after the user confirmed (or under -y). Nothing on the host
// changes before the prompt, and a dry run only prints the plan.
test('the nginx service repair of a non-root install is planned before the prompt and done after it', { skip: !linux }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-node.sh'), 'utf8');
  const { functions } = parseShell(source);
  const preflight = functions.get('preflight_run_user_nginx');
  assert.ok(preflight.calls.has('nginx_openrc_service_repair_needed'), 'the preflight detects the case');
  for (const change of ['ensure_nginx_openrc_pid_directory', 'start_nginx_after_service_repair', 'backup_if_exists']) {
    assert.ok(!preflight.calls.has(change), `the preflight does not call ${change}`);
  }
  const preflightCode = shellFunction(source, 'preflight_run_user_nginx')
    .split('\n')
    .filter((line) => !/^\s*err "/.test(line))
    .join('\n');
  assert.doesNotMatch(preflightCode, /rc-service/, 'the preflight runs no service command');
  assert.doesNotMatch(shellFunction(source, 'nginx_openrc_service_repair_needed'), /rc-service nginx (zap|start|restart)/);
  // The summary announces the plan before the prompt; the repair runs in the configuration step after it.
  const prompt = source.indexOf('prompt_yes_no "Proceed with installation?"');
  assert.ok(source.indexOf('summary_row "Nginx fix:   will update the nginx PID-directory line and start nginx"') < prompt);
  assert.ok(source.indexOf('\npreflight_run_user_nginx\n') < prompt);
  const configure = shellFunction(source, 'configure_nginx');
  assert.ok(configure.indexOf('ensure_nginx_openrc_pid_directory') < configure.indexOf('start_nginx_after_service_repair'));
  const runStart = source.indexOf('\n# ── Run ─');
  assert.ok(runStart > prompt && source.indexOf('\nconfigure_nginx\n') > runStart, 'configure_nginx runs after the prompt');
  assert.match(source, /dry_run_preview\(\) \{[\s\S]*Would update the nginx OpenRC service's PID-directory line and start nginx \(dry run\)/);
  assert.deepEqual(definedBeforeUseErrors(source), []);

  const dir = await mkdtemp(path.join(tmpdir(), 'gateway-nginx-migrate-'));
  try {
    const service = path.join(dir, 'nginx');
    const confd = path.join(dir, 'conf-nginx');
    const calls = path.join(dir, 'calls');
    const earlier = [
      '#!/sbin/openrc-run',
      'pidfile=/run/nginx/nginx.pid',
      'start_pre() {',
      '\tcheckpath --directory --mode 0755 --owner root:root ${pidfile%/*}',
      '}',
      '',
    ].join('\n');
    const text = ['ensure_nginx_openrc_pid_directory', 'nginx_openrc_service_repair_needed', 'start_nginx_after_service_repair', 'preflight_run_user_nginx']
      .map((name) => shellFunction(source, name).replaceAll('/etc/init.d', dir).replaceAll('/etc/conf.d/nginx', confd))
      .join('\n');
    const constants = source
      .split('\n')
      .filter((line) => /^NGINX_OPENRC_(STOCK|EARLIER)_LINE=|^NGINX_SERVICE_REPAIR_PLANNED=/.test(line))
      .join('\n');
    const stubs = (dryRun) => [
      'RUN_USER=nginx; RUN_GROUP=nginx; NGINX_MODE=integrate; LOG_FILE=/dev/null',
      `DRY_RUN=${dryRun}`,
      constants,
      'has_openrc() { return 0; }',
      'command_exists() { return 0; }',
      'log() { echo "LOG $*"; }',
      'err() { echo "ERR $*" >&2; }',
      'die() { err "$@"; exit 1; }',
      'backup_if_exists() { :; }',
      'id() { case "$1" in -u) echo 1000 ;; *) echo nginx ;; esac; }',
      'stat() { case "$*" in *"/proc/"*) echo 1000 ;; *"-c %u"*) echo 0 ;; *) echo 755 ;; esac; }',
      // The service is down until something starts it; every call is recorded.
      `rc-service() { echo "$*" >> '${calls}'; case "$2" in start) touch '${dir}/up' ;; esac; [[ "$2" != status ]] || [[ -e '${dir}/up' ]]; }`,
      `nginx_master_pid() { [[ -e '${dir}/up' ]] && echo $$; }`,
      text,
    ];
    const run = async ({ confdText, dryRun = 0, afterPrompt = false }) => {
      await writeFile(service, earlier, { mode: 0o755 });
      await writeFile(confd, confdText);
      await writeFile(calls, '');
      runShell(`rm -f '${dir}/up'`);
      const steps = ['preflight_run_user_nginx', 'echo "PLANNED=${NGINX_SERVICE_REPAIR_PLANNED}"'];
      if (afterPrompt) steps.push('ensure_nginx_openrc_pid_directory', 'start_nginx_after_service_repair');
      const result = runShell([...stubs(dryRun), ...steps, 'echo DONE'].join('\n'));
      return { ...result, script: readFileSync(service, 'utf8'), calls: readFileSync(calls, 'utf8') };
    };
    const prepared = 'command_user="nginx:nginx"\ncapabilities="^cap_net_bind_service"\n';
    // Before the prompt: planned, nothing changed, nothing started.
    const planned = await run({ confdText: prepared });
    assert.equal(planned.status, 0, planned.output);
    assert.match(planned.output, /PLANNED=1/);
    assert.equal(planned.script, earlier, 'the service file is untouched before the prompt');
    assert.doesNotMatch(planned.calls, /zap|start/, 'no service action before the prompt');
    // After the prompt: the line is migrated, then nginx is started.
    const done = await run({ confdText: prepared, afterPrompt: true });
    assert.equal(done.status, 0, done.output);
    assert.match(done.script, /--owner "\$\{command_user:-root:root\}" \$\{pidfile%\/\*\}/);
    assert.match(done.calls, /nginx zap\nnginx start\n/);
    // A dry run only prints the plan; the repair functions change nothing.
    const dry = await run({ confdText: prepared, dryRun: 1, afterPrompt: true });
    assert.equal(dry.script, earlier);
    assert.doesNotMatch(dry.calls, /zap|start/);
    // Without command_user for the run user nothing is planned and the refusal stays as before.
    for (const confdText of ['', 'command_user="www-data"\n']) {
      const refused = await run({ confdText });
      assert.equal(refused.status, 1, refused.output);
      assert.match(refused.output, /no running nginx master process was found/);
      assert.match(refused.output, /rc-service nginx zap, then rc-service nginx start/);
      assert.match(refused.output, /nothing was changed\./);
      assert.equal(refused.script, earlier);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The relay installer re-runs like the monitoring, nginx and Docker installers: an enrolled relay re-run without a token
// keeps its identity and takes what is not given from its configuration (the documented user switch is such a re-run);
// with a token it re-enrolls, and when Gateway refuses the token the relay keeps running as it was but the install
// fails; a new relay still needs every argument.
test('an enrolled relay re-runs without a token and keeps its identity', { skip: !linux }, async () => {
  const host = path.join(work, 'host');
  const config = path.join(host, 'etc/gateway-relay-supervisor/config.yaml');
  const identity = path.join(host, 'var/lib/gateway-relay-supervisor/supervisor-identity/node.pem');
  const relayArgs = ['--version', VERSION];
  const full = ['--gateway', 'gw.example.com:9443', '--gateway-cert-sha256', CERT, '--advertise-address', 'relay.example.com'];
  try {
    // A new relay: every argument is still required.
    for (const args of [relayArgs, [...relayArgs, ...full], ['--token', 'gw_node_x', ...relayArgs, '--gateway', 'gw.example.com:9443']]) {
      const fresh = dryRun('setup-relay-node.sh', args);
      assert.equal(fresh.status, 2, `${args.join(' ')}\n${fresh.output}`);
      assert.match(fresh.output, /Usage: setup-relay-node\.sh/);
    }
    await writeFile(
      path.join(work, 'relay-config.yaml'),
      [
        'gateway:',
        '  address: gw.example.com:9443',
        '  token: gw_node_used',
        `  cert_sha256: ${CERT}`,
        'worker:',
        '  service_port: 853',
        '  advertised_addresses:',
        '    - relay.example.com',
        '',
      ].join('\n')
    );
    runShell(`mkdir -p '${path.dirname(config)}' '${path.dirname(identity)}' && cp '${path.join(work, 'relay-config.yaml')}' '${config}' && echo pem > '${identity}'`);
    // Enrolled, no token: gateway, pin, advertised address and port come from the configuration.
    const kept = dryRun('setup-relay-node.sh', relayArgs);
    assert.equal(kept.status, 0, kept.output);
    assert.match(kept.output, /for Gateway gw\.example\.com:9443, advertised at relay\.example\.com:853\./);
    assert.match(kept.output, /no token was given: it keeps its identity/);
    // What is given wins.
    const given = dryRun('setup-relay-node.sh', [...relayArgs, '--gateway', 'other.example.com:9443', '--service-port', '9444']);
    assert.match(given.output, /for Gateway other\.example\.com:9443, advertised at relay\.example\.com:9444\./, given.output);
    // With a token it re-enrolls.
    const reenroll = dryRun('setup-relay-node.sh', ['--token', 'gw_node_new', ...relayArgs]);
    assert.equal(reenroll.status, 2, 'a token alone is not a complete command for a new relay');
    const reenrollFull = dryRun('setup-relay-node.sh', ['--token', 'gw_node_new', ...relayArgs, ...full]);
    assert.equal(reenrollFull.status, 0, reenrollFull.output);
    assert.match(reenrollFull.output, /a token was given: it re-enrolls, and keeps its previous identity if Gateway refuses the token/);
    // A configuration that lacks the values cannot be re-run without them.
    runShell(`printf 'gateway:\\n  token: x\\n' > '${config}'`);
    const incomplete = dryRun('setup-relay-node.sh', relayArgs);
    assert.equal(incomplete.status, 2, incomplete.output);
    assert.match(incomplete.output, /does not name its Gateway, certificate pin and advertised address/);
  } finally {
    runShell(`rm -f '${config}' '${identity}' '${path.join(work, 'relay-config.yaml')}'`);
  }

  const source = readFileSync(path.join(scriptsDir, 'setup-relay-node.sh'), 'utf8');
  // No token, no token line: a token in the configuration of an enrolled supervisor starts a re-enrollment.
  const start = source.indexOf('GATEWAY_TOKEN_YAML=""');
  const end = source.indexOf('\nCONFIG\n', start) + '\nCONFIG\n'.length;
  const rendered = path.join(work, 'rendered-relay-config.yaml');
  const render = (token) => {
    const result = runShell(
      [
        `GATEWAY=gw.example.com:9443; TOKEN='${token}'; GATEWAY_CERT_SHA256=${CERT}; HOST_IDENTITY_PATH=/h; SERVICE_PORT=9443; ADVERTISE_ADDRESS=relay.example.com`,
        source.slice(start, end).replace('/etc/gateway-relay-supervisor/config.yaml', rendered),
      ].join('\n')
    );
    assert.equal(result.status, 0, result.output);
    return readFileSync(rendered, 'utf8');
  };
  assert.doesNotMatch(render(''), /token:/);
  assert.match(render(''), /^gateway:\n {2}address: gw\.example\.com:9443\n {2}cert_sha256: /);
  assert.match(render('gw_node_new'), /^ {2}address: gw\.example\.com:9443\n {2}token: gw_node_new\n {2}cert_sha256:/m);
  // Without a token there is no enrollment result to wait for, only the Gateway session.
  assert.match(source, /Without a token there is no enrollment to wait for[^\n]*\n\s+\[\[ -n "\$TOKEN" \]\] \|\| enrolled=1/);
  // A refused re-enrollment token is a failure that says the relay still runs.
  assert.match(source, /enrollment_status" -eq 1 && "\$REENROLLMENT" -eq 1[\s\S]*keeps running with its previous identity, but it was not re-enrolled[\s\S]*without --token[\s\S]*exit 1/);
});
