/**
 * A structural reading of rendered nginx configuration text: directives, their arguments and blocks, each with its
 * position in the text, so a caller can insert or replace text without reformatting anything else. It follows
 * nginx's own tokenizer (ngx_conf_read_token): `#` starts a comment only where a token starts, quoted tokens keep
 * backslash escapes, `${` belongs to a word, and `{`, `}` and `;` end a directive only outside quotes.
 */

export interface NginxConfigToken {
  /** The token as written, quotes included. */
  raw: string;
  /** The token without its quotes. */
  value: string;
  start: number;
  end: number;
}

export interface NginxConfigDirective {
  name: string;
  args: NginxConfigToken[];
  /** Position of the directive name. */
  start: number;
  /** Position after its `;` or after the `}` of its block. */
  end: number;
  block?: {
    /** Position of `{`. */
    open: number;
    /** Position of the closing `}`. */
    close: number;
    children: NginxConfigDirective[];
  };
}

export class NginxConfigParseError extends Error {}

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/** Parses rendered nginx configuration. Throws NginxConfigParseError on text nginx would not accept. */
export function parseNginxConfig(text: string): NginxConfigDirective[] {
  const root: NginxConfigDirective[] = [];
  const stack: Array<{ directive: NginxConfigDirective | null; children: NginxConfigDirective[] }> = [
    { directive: null, children: root },
  ];
  let pending: NginxConfigToken[] = [];
  let index = 0;

  const finishDirective = (end: number): NginxConfigDirective => {
    const [name, ...args] = pending;
    if (!name) throw new NginxConfigParseError(`unexpected ";" at ${end}`);
    pending = [];
    const directive: NginxConfigDirective = { name: name.value, args, start: name.start, end };
    stack[stack.length - 1]!.children.push(directive);
    return directive;
  };

  while (index < text.length) {
    const char = text[index]!;
    if (isSpace(char)) {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === ';') {
      finishDirective(index + 1);
      index += 1;
      continue;
    }
    if (char === '{') {
      const directive = finishDirective(index + 1);
      directive.block = { open: index, close: -1, children: [] };
      stack.push({ directive, children: directive.block.children });
      index += 1;
      continue;
    }
    if (char === '}') {
      if (pending.length > 0 || stack.length === 1) throw new NginxConfigParseError(`unexpected "}" at ${index}`);
      const { directive } = stack.pop()!;
      directive!.block!.close = index;
      directive!.end = index + 1;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== char) index += text[index] === '\\' ? 2 : 1;
      if (index >= text.length) throw new NginxConfigParseError(`unterminated quote at ${start}`);
      index += 1;
      const raw = text.slice(start, index);
      pending.push({ raw, value: raw.slice(1, -1), start, end: index });
      continue;
    }
    const start = index;
    let variable = false;
    while (index < text.length) {
      const current = text[index]!;
      if (current === '{' && variable) {
        index += 1;
        continue;
      }
      variable = false;
      if (current === '\\') {
        index += 2;
        continue;
      }
      if (current === '$') {
        variable = true;
        index += 1;
        continue;
      }
      if (isSpace(current) || current === ';' || current === '{') break;
      index += 1;
    }
    const raw = text.slice(start, index);
    pending.push({ raw, value: raw, start, end: index });
  }
  if (pending.length > 0 || stack.length !== 1) throw new NginxConfigParseError('unexpected end of configuration');
  return root;
}

/** Calls `visit` for every directive, depth first, with the blocks that enclose it (outermost first). */
export function walkNginxConfig(
  directives: NginxConfigDirective[],
  visit: (directive: NginxConfigDirective, parents: NginxConfigDirective[]) => void,
  parents: NginxConfigDirective[] = []
): void {
  for (const directive of directives) {
    visit(directive, parents);
    if (directive.block) walkNginxConfig(directive.block.children, visit, [...parents, directive]);
  }
}
