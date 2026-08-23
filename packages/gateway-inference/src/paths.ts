import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const GATEWAY_INFERENCE_HOME_ENV = 'GATEWAY_INFERENCE_HOME';

export interface CliPaths {
  configDir: string;
  dataDir: string;
  homeDir?: string;
  profilesFile: string;
  fileCredentialsFile: string;
  runtimeDir: string;
  runtimeFile: string;
}

export function resolveCliPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  explicitHome?: string
): CliPaths {
  let configDir: string;
  let dataDir: string;
  const configuredHome = explicitHome?.trim() || env[GATEWAY_INFERENCE_HOME_ENV]?.trim();

  if (configuredHome) {
    const expanded =
      configuredHome === '~'
        ? home
        : configuredHome.startsWith('~/') || configuredHome.startsWith('~\\')
          ? join(home, configuredHome.slice(2))
          : configuredHome;
    configDir = resolve(expanded);
    dataDir = configDir;
  } else if (platform === 'darwin') {
    configDir = join(home, 'Library', 'Application Support', 'Wiolett Gateway');
    dataDir = configDir;
  } else if (platform === 'win32') {
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    configDir = join(appData, 'Wiolett', 'Gateway');
    dataDir = join(localAppData, 'Wiolett', 'Gateway');
  } else {
    configDir = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'wiolett', 'gateway');
    dataDir = join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'wiolett', 'gateway');
  }

  const runtimeDir = join(dataDir, 'runtime');
  return {
    configDir,
    dataDir,
    ...(configuredHome ? { homeDir: configDir } : {}),
    profilesFile: join(configDir, 'profiles.json'),
    fileCredentialsFile: join(dataDir, 'credentials.json'),
    runtimeDir,
    runtimeFile: join(runtimeDir, 'gateway-cli.js'),
  };
}
