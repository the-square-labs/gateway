import { describe, expect, it } from 'vitest';
import { engineStep, failureSummary } from './engine-output.js';

describe('engine output', () => {
  it('renders machine progress including image download percentage', () => {
    expect(engineStep('{"id":"redis","status":"Downloading","progressDetail":{"current":25,"total":100}}'))
      .toBe('redis · Downloading · 25%');
  });

  it('keeps an actionable failure while redacting enrollment tokens', () => {
    expect(failureSummary('@@wiolett-step:Downloading Gateway images\nwrite /var/lib/docker: no space left on device\n--token gw_node_secret'))
      .toContain('no space left on device');
    expect(failureSummary('--token gw_node_secret')).not.toContain('gw_node_secret');
  });
});
