export interface BackgroundPrewarmTask {
  key: string;
  run: () => Promise<unknown>;
}

const DEFAULT_START_DELAY_MS = 350;

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/** Starts at most one prewarm request at a time and spaces request starts. */
export async function runBackgroundPrewarm(
  tasks: BackgroundPrewarmTask[],
  signal: AbortSignal,
  delayMs = DEFAULT_START_DELAY_MS
): Promise<void> {
  for (let index = 0; index < tasks.length; index += 1) {
    if (signal.aborted) return;
    if (index > 0) await waitForDelay(delayMs, signal);
    if (signal.aborted) return;
    try {
      await tasks[index]!.run();
    } catch (error) {
      if (signal.aborted) return;
      const retryAfterSeconds = Number(
        (error as { retryAfterSeconds?: number } | null)?.retryAfterSeconds
      );
      if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        await waitForDelay(retryAfterSeconds * 1000, signal);
      }
    }
  }
}
