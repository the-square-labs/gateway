// Node installers: every one parses, defines each function before the code that runs it at the top level, and
// completes a --dry-run for each profile, as root and with --user, with the host access switches, with its settings
// from the environment, and through setup-daemon.sh for each node type; every installer prints its help. The dry runs
// use a copy of the scripts whose root check passes for any user and whose host paths are under an empty directory,
// stub commands for docker, nginx and curl, and no network; a dry run changes nothing on the host.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
