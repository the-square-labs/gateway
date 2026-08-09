import { AppError } from '@/middleware/error-handler.js';

function splitSqlStatementsForDialect(sql: string, carriageReturnEndsLineComment: boolean): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarQuoteTag: string | null = null;

  while (i < sql.length) {
    const char = sql[i]!;
    const next = sql[i + 1];

    if (inLineComment) {
      current += char;
      if (char === '\n' || (carriageReturnEndsLineComment && char === '\r')) inLineComment = false;
      i += 1;
      continue;
    }

    if (inBlockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        inBlockComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (dollarQuoteTag) {
      if (sql.startsWith(dollarQuoteTag, i)) {
        current += dollarQuoteTag;
        i += dollarQuoteTag.length;
        dollarQuoteTag = null;
      } else {
        current += char;
        i += 1;
      }
      continue;
    }

    if (inSingleQuote) {
      current += char;
      if (char === "'" && next === "'") {
        current += next;
        i += 2;
        continue;
      }
      if (char === "'") inSingleQuote = false;
      i += 1;
      continue;
    }

    if (inDoubleQuote) {
      current += char;
      if (char === '"' && next === '"') {
        current += next;
        i += 2;
        continue;
      }
      if (char === '"') inDoubleQuote = false;
      i += 1;
      continue;
    }

    if (inBacktick) {
      current += char;
      if (char === '`' && next === '`') {
        current += next;
        i += 2;
        continue;
      }
      if (char === '`') inBacktick = false;
      i += 1;
      continue;
    }

    if (char === '-' && next === '-') {
      current += char + next;
      inLineComment = true;
      i += 2;
      continue;
    }

    if (char === '/' && next === '*') {
      current += char + next;
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (char === "'") {
      current += char;
      inSingleQuote = true;
      i += 1;
      continue;
    }

    if (char === '"') {
      current += char;
      inDoubleQuote = true;
      i += 1;
      continue;
    }

    if (char === '`') {
      current += char;
      inBacktick = true;
      i += 1;
      continue;
    }

    if (char === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        const tag = match[0];
        current += tag;
        dollarQuoteTag = tag;
        i += tag.length;
        continue;
      }
    }

    if (char === ';') {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      i += 1;
      continue;
    }

    current += char;
    i += 1;
  }

  const finalStatement = current.trim();
  if (finalStatement) statements.push(finalStatement);
  if (statements.length === 0) {
    throw new AppError(400, 'INVALID_SQL', 'SQL statement is required');
  }
  return statements;
}

/**
 * ClickHouse terminates `--` comments with LF only. Keep that behavior for
 * the shared/default splitter used by its adapter.
 */
export function splitSqlStatements(sql: string): string[] {
  return splitSqlStatementsForDialect(sql, false);
}

/** PostgreSQL treats both CR and LF as line-comment terminators. */
export function splitPostgresStatements(sql: string): string[] {
  return splitSqlStatementsForDialect(sql, true);
}

export function splitRedisCommands(commandText: string): string[] {
  const commands: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < commandText.length; i += 1) {
    const char = commandText[i]!;

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if (inSingleQuote) {
      current += char;
      if (char === "'") inSingleQuote = false;
      continue;
    }

    if (inDoubleQuote) {
      current += char;
      if (char === '"') inDoubleQuote = false;
      continue;
    }

    if (char === "'") {
      current += char;
      inSingleQuote = true;
      continue;
    }

    if (char === '"') {
      current += char;
      inDoubleQuote = true;
      continue;
    }

    if (char === ';' || char === '\n') {
      const trimmed = current.trim();
      if (trimmed) commands.push(trimmed);
      current = '';
      continue;
    }

    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) commands.push(trimmed);
  if (commands.length === 0) {
    throw new AppError(400, 'INVALID_COMMAND', 'Redis command is required');
  }
  if (inSingleQuote || inDoubleQuote || escaped) {
    throw new AppError(400, 'INVALID_COMMAND', 'Unterminated quoted Redis command');
  }
  return commands;
}

export function tokenizeRedisCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false;
      } else {
        current += char;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (char === '"') {
        inDoubleQuote = false;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      continue;
    }

    if (char === '"') {
      inDoubleQuote = true;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    current += char;
  }

  if (escaped || inSingleQuote || inDoubleQuote) {
    throw new AppError(400, 'INVALID_COMMAND', 'Unterminated quoted Redis command');
  }

  pushCurrent();
  if (tokens.length === 0) {
    throw new AppError(400, 'INVALID_COMMAND', 'Redis command is required');
  }
  return tokens;
}

function inferPostgresStatementIntent(sql: string): 'read' | 'write' | 'admin' {
  const normalized = sql.trim().replace(/^\s+/, '').toLowerCase();
  const token = normalized.split(/\s+/, 1)[0] ?? '';
  if (['select', 'show', 'explain', 'values'].includes(token) || normalized.startsWith('with ')) {
    if (
      /\b(insert|update|delete|merge|alter|drop|create|truncate|grant|revoke|vacuum|reindex|comment|refresh|cluster|copy|lock|call|do)\b/i.test(
        normalized
      )
    ) {
      return 'admin';
    }
    return 'read';
  }
  if (['insert', 'update', 'delete', 'merge', 'copy', 'lock'].includes(token)) return 'write';
  return 'admin';
}

export function inferPostgresIntent(sql: string): 'read' | 'write' | 'admin' {
  const intents = splitPostgresStatements(sql).map(inferPostgresStatementIntent);
  if (intents.includes('admin')) return 'admin';
  if (intents.includes('write')) return 'write';
  return 'read';
}

function inferClickHouseStatementIntent(sql: string): 'read' | 'write' | 'admin' {
  const normalized = sql.trim().toLowerCase();
  const token = normalized.split(/\s+/, 1)[0] ?? '';
  if (['select', 'show', 'describe', 'desc', 'explain', 'exists'].includes(token) || normalized.startsWith('with ')) {
    if (
      /\b(insert|delete|update|alter|create|drop|truncate|rename|optimize|system|kill|grant|revoke|attach|detach)\b/i.test(
        normalized
      )
    ) {
      return 'admin';
    }
    return 'read';
  }
  if (['insert', 'delete'].includes(token)) return 'write';
  return 'admin';
}

export function inferClickHouseIntent(sql: string): 'read' | 'write' | 'admin' {
  const intents = splitSqlStatements(sql).map(inferClickHouseStatementIntent);
  if (intents.includes('admin')) return 'admin';
  if (intents.includes('write')) return 'write';
  return 'read';
}

export function inferRedisSingleCommandIntent(command: string): 'read' | 'write' | 'admin' {
  const token = command.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  if (
    [
      'get',
      'mget',
      'hget',
      'hgetall',
      'lrange',
      'llen',
      'smembers',
      'scard',
      'zrange',
      'zrevrange',
      'zcard',
      'ttl',
      'pttl',
      'type',
      'exists',
      'scan',
      'info',
      'xrange',
      'xrevrange',
      'keys',
      'dbsize',
      'ping',
    ].includes(token)
  ) {
    return 'read';
  }
  if (
    [
      'set',
      'mset',
      'del',
      'unlink',
      'expire',
      'persist',
      'rename',
      'hset',
      'hdel',
      'lpush',
      'rpush',
      'ltrim',
      'sadd',
      'srem',
      'zadd',
      'zrem',
      'incr',
      'decr',
      'xadd',
      'xdel',
    ].includes(token)
  ) {
    return 'write';
  }
  return 'admin';
}

export function inferRedisIntent(commandText: string): 'read' | 'write' | 'admin' {
  const intents = splitRedisCommands(commandText).map(inferRedisSingleCommandIntent);
  if (intents.includes('admin')) return 'admin';
  if (intents.includes('write')) return 'write';
  return 'read';
}
