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
          `DOCKER_MODE=${DOCKER_MODE}; LOG_FILE=/dev/null`,
          'docker_run() { echo "' + info + '"; }',
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
