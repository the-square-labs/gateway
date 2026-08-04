import { runFoundationMigrations } from './foundation/foundation-migrator.js';

interface CliOptions {
  hostDir: string;
  targetVersion?: string;
  imageRef?: string;
  databaseConnectorImage?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { hostDir: '/host' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--host-dir' && next) {
      options.hostDir = next;
      index += 1;
      continue;
    }
    if (arg === '--target-version' && next) {
      options.targetVersion = next;
      index += 1;
      continue;
    }
    if (arg === '--image-ref' && next) {
      options.imageRef = next;
      index += 1;
      continue;
    }
    if (arg === '--database-connector-image' && next) {
      options.databaseConnectorImage = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete foundation migrator argument: ${arg}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runFoundationMigrations(options);
  console.log(
    JSON.stringify({
      ok: true,
      changedFiles: result.changedFiles,
      backupDir: result.backupDir,
      sandboxWorkspaceDir: result.sandboxWorkspaceDir,
    })
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
