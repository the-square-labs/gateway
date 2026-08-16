import type { Pool } from 'pg';
import type { ApiClient, ApiResponse } from './api-client.js';
import type { E2EConfig } from './config.js';

export type TestContext = {
  client: ApiClient;
  config: E2EConfig;
  db: Pool;
  cleanup: Array<() => Promise<void>>;
};

export type TestCase = {
  name: string;
  run: (ctx: TestContext) => Promise<void>;
  skip?: (ctx: TestContext) => string | false;
};

export function test(name: string, run: TestCase['run'], skip?: TestCase['skip']): TestCase {
  return { name, run, skip };
}

export function expectStatus(response: ApiResponse, statuses: number | number[], label: string) {
  const allowed = Array.isArray(statuses) ? statuses : [statuses];
  if (!allowed.includes(response.status)) {
    throw new Error(`${label}: expected ${allowed.join(', ')}, got ${response.status}: ${response.text.slice(0, 500)}`);
  }
}

export function expectOk(response: ApiResponse, label: string) {
  if (response.status < 200 || response.status > 299) {
    throw new Error(`${label}: expected 2xx, got ${response.status}: ${response.text.slice(0, 500)}`);
  }
}

export function expectApiAccessible(response: ApiResponse, label: string) {
  if (response.status === 401 || response.status === 403 || response.status >= 500) {
    throw new Error(
      `${label}: expected accessible non-5xx response, got ${response.status}: ${response.text.slice(0, 500)}`
    );
  }
}

export function expectApiAccessibleOrFeatureDisabled(response: ApiResponse, label: string, code: string) {
  if (response.status === 503 && response.text.includes(`"code":"${code}"`)) return;
  expectApiAccessible(response, label);
}

export function expectSessionOnly(response: ApiResponse, label: string) {
  expectStatus(response, 403, label);
  if (!response.text.includes('browser session')) {
    throw new Error(`${label}: expected browser-session-only rejection, got: ${response.text.slice(0, 500)}`);
  }
}

export async function runTests(ctx: TestContext, tests: TestCase[]) {
  let passed = 0;
  let skipped = 0;
  const failed: Array<{ name: string; error: unknown }> = [];

  for (const item of tests) {
    const skipReason = item.skip?.(ctx);
    if (skipReason) {
      skipped += 1;
      console.log(`- SKIP ${item.name}: ${skipReason}`);
      continue;
    }

    try {
      await item.run(ctx);
      passed += 1;
      console.log(`- PASS ${item.name}`);
    } catch (error) {
      failed.push({ name: item.name, error });
      console.error(`- FAIL ${item.name}`);
      console.error(error instanceof Error ? error.stack : error);
    }
  }

  console.log(`\nAPI e2e result: ${passed} passed, ${skipped} skipped, ${failed.length} failed`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}
