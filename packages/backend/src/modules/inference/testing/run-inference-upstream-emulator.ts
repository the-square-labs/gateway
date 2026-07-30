import { InferenceUpstreamEmulator } from './inference-upstream.emulator.js';

const emulator = new InferenceUpstreamEmulator();
const baseUrl = await emulator.start(Number(process.env.PORT ?? 4319));
process.stdout.write(`Inference upstream emulator listening at ${baseUrl}\n`);

async function stop() {
  await emulator.stop();
  process.exit(0);
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
