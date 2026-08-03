import { describe, expect, it } from 'vitest';
import { displayEngineArgs, engineArgs, parseCommand } from './args.js';

describe('parseCommand', () => {
  it('keeps copied node flags for the engine', () => {
    const command = parseCommand(['install', 'node', '--type', 'databases', '--gateway', 'gateway.example:9443', '--token', 'secret', '-y']);
    expect(command.target).toBe('node');
    expect(engineArgs('node', command.flags)).toEqual([
      'install', 'node', '-y', '--type', 'databases', '--gateway', 'gateway.example:9443', '--token', 'secret',
    ]);
  });

  it('requires values for value flags', () => {
    expect(() => parseCommand(['install', 'node', '--gateway'])).toThrow('--gateway requires a value');
  });

  it('redacts secrets in a dry-run command', () => {
    const command = parseCommand(['install', 'node', '--type', 'nginx', '--token', 'secret']);
    expect(displayEngineArgs('node', command.flags)).toContain('<redacted>');
    expect(displayEngineArgs('node', command.flags)).not.toContain('secret');
  });
});
