import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('AI bootstrap recovery ordering', () => {
  it('registers the complete AI runtime before recovering interrupted runs', async () => {
    const source = await readFile(new URL('./bootstrap.ts', import.meta.url), 'utf8');
    const serviceRegistration = source.indexOf('container.registerInstance(AIService, aiService);');
    const recovery = source.indexOf('await aiRunService.recoverInterruptedRuns');

    expect(serviceRegistration).toBeGreaterThan(-1);
    expect(recovery).toBeGreaterThan(serviceRegistration);
    expect(source.match(/recoverInterruptedRuns/g)).toHaveLength(1);
  });
});
