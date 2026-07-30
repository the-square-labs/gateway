import { redactValue } from './errors.js';

export interface Output {
  json: boolean;
  write(value: unknown, human: () => string): void;
}

export function createOutput(json: boolean, stdout: Pick<NodeJS.WriteStream, 'write'> = process.stdout): Output {
  return {
    json,
    write(value, human) {
      stdout.write(json ? `${JSON.stringify(redactValue(value), null, 2)}\n` : `${human()}\n`);
    },
  };
}
