/**
 * Adds host access-list directives to direct child locations in an advanced
 * server snippet. Nginx does not inherit directives from the generated
 * `location /` into its sibling locations, so the directives must be emitted
 * into each custom location instead of at server scope.
 */
export function injectAccessListIntoAdvancedLocations(advancedConfig: string, directives: readonly string[]): string {
  if (!advancedConfig || directives.length === 0) return advancedConfig;

  let result = '';
  let header = '';
  let blockDepth = 0;
  let lineStart = 0;
  let inComment = false;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < advancedConfig.length; index++) {
    const char = advancedConfig[index]!;

    if (inComment) {
      result += char;
      if (char === '\n') {
        inComment = false;
        header += '\n';
        lineStart = index + 1;
      }
      continue;
    }

    if (quote) {
      result += char;
      header += char;
      if (char === quote && !isEscaped(advancedConfig, index)) quote = null;
      if (char === '\n') lineStart = index + 1;
      continue;
    }

    if (char === '#') {
      result += char;
      inComment = true;
      continue;
    }

    if (char === '"' || char === "'") {
      result += char;
      header += char;
      quote = char;
      continue;
    }

    if (char === '{') {
      result += char;
      if (blockDepth === 0 && /^\s*location\b/i.test(header)) {
        const lineIndent = advancedConfig.slice(lineStart, index).match(/^[\t ]*/)?.[0] ?? '';
        const injected = directives.map((directive) => `${lineIndent}    ${directive}`).join('\n');
        result += `\n${injected}`;
        if (advancedConfig[index + 1] !== '\n' && advancedConfig[index + 1] !== '\r') result += '\n';
      }
      blockDepth++;
      header = '';
      continue;
    }

    if (char === '}') {
      result += char;
      blockDepth = Math.max(0, blockDepth - 1);
      header = '';
      continue;
    }

    result += char;
    if (char === ';') {
      header = '';
      continue;
    }
    header += char;
    if (char === '\n') lineStart = index + 1;
  }

  return result;
}

function isEscaped(value: string, index: number): boolean {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) backslashCount++;
  return backslashCount % 2 === 1;
}
