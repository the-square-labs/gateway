import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CliPaths {
  configDir: string;
  dataDir: string;
  profilesFile: string;
  fileCredentialsFile: string;
  runtimeDir: string;
  runtimeFile: string;
}

export function resolveCliPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir()
): CliPaths {
  let configDir: string;
  let dataDir: string;

  if (platform === 'darwin') {
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
    profilesFile: join(configDir, 'profiles.json'),
    fileCredentialsFile: join(dataDir, 'credentials.json'),
    runtimeDir,
    runtimeFile: join(runtimeDir, 'gateway-cli.js'),
  };
}
