import {
  NGINX_TEMPLATE_BLOCK_HELPERS,
  NGINX_TEMPLATE_CONTEXT_VARIABLES,
  NGINX_TEMPLATE_HELPERS,
} from "@/lib/nginx-template-context";

// What the backend renders nginx templates with (generated from its renderer). `else` is
// Handlebars syntax rather than a helper, but it starts expressions like `{{else if x}}`.
const BUILTIN_TEMPLATE_VARIABLES = new Set(NGINX_TEMPLATE_CONTEXT_VARIABLES);
const BUILTIN_TEMPLATE_HELPERS = new Set([...NGINX_TEMPLATE_HELPERS, "else"]);
const BLOCK_HELPERS = new Set(NGINX_TEMPLATE_BLOCK_HELPERS);

function buildLineStarts(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function getLineNumber(lineStarts: number[], index: number) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= index) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}

/**
 * Checks a template's Handlebars expressions against the render context: unknown
 * variables and helpers become error ranges, unbalanced blocks error lines (1-based).
 */
export function analyzeTemplateContent(content: string, customVariables: string[]) {
  const lineStarts = buildLineStarts(content);
  const errorLines = new Set<number>();
  const errorRanges: Array<{ from: number; to: number }> = [];
  const blockStack: Array<{ helper: string; line: number }> = [];
  const allowedVariables = new Set([...BUILTIN_TEMPLATE_VARIABLES, ...customVariables]);

  const addErrorLine = (index: number) => {
    errorLines.add(getLineNumber(lineStarts, index));
  };

  const addErrorRange = (from: number, to: number) => {
    if (from < to) errorRanges.push({ from, to });
  };

  const isLiteralToken = (token: string) =>
    /^-?\d+(\.\d+)?$/.test(token) ||
    token === "true" ||
    token === "false" ||
    token === "null" ||
    token === "undefined" ||
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"));

  const validateIdentifier = (token: string, offset: number) => {
    if (!token || isLiteralToken(token)) return;
    if (
      token.startsWith("@") ||
      token === "this" ||
      token.startsWith("this.") ||
      token.startsWith("../")
    ) {
      return;
    }
    const root = token.split(".")[0];
    if (!allowedVariables.has(root)) {
      addErrorRange(offset, offset + token.length);
    }
  };

  const validateExpression = (expr: string, globalStart: number) => {
    const trimmed = expr.trim();
    if (!trimmed) return;

    if (trimmed === "else") {
      if (blockStack.length === 0) addErrorLine(globalStart);
      return;
    }

    if (trimmed.startsWith("#") || trimmed.startsWith("/")) {
      const isClose = trimmed.startsWith("/");
      const helper = trimmed.slice(1).trim().split(/\s+/)[0] || "";
      const helperStart = globalStart + trimmed.indexOf(helper);

      if (!BLOCK_HELPERS.has(helper)) {
        addErrorRange(helperStart, helperStart + helper.length);
        addErrorLine(globalStart);
        return;
      }

      if (isClose) {
        const open = blockStack.at(-1);
        if (!open || open.helper !== helper) {
          addErrorLine(globalStart);
        } else {
          blockStack.pop();
        }
        return;
      }

      blockStack.push({ helper, line: getLineNumber(lineStarts, globalStart) });
      const args = trimmed.slice(trimmed.indexOf(helper) + helper.length).trim();
      validateTokens(args, globalStart + trimmed.indexOf(args));
      return;
    }

    validateTokens(trimmed, globalStart + expr.indexOf(trimmed));
  };

  const validateTokens = (expr: string, globalStart: number) => {
    const matches = Array.from(expr.matchAll(/"[^"]*"|'[^']*'|\([^()]*\)|[^\s]+/g));
    if (matches.length === 0) return;

    const [firstMatch, ...rest] = matches;
    const firstToken = firstMatch[0];
    const firstOffset = globalStart + (firstMatch.index ?? 0);

    if (firstToken.startsWith("(") && firstToken.endsWith(")")) {
      validateTokens(firstToken.slice(1, -1), firstOffset + 1);
    } else if (rest.length === 0) {
      validateIdentifier(firstToken, firstOffset);
    } else if (BUILTIN_TEMPLATE_HELPERS.has(firstToken)) {
      for (const match of rest) {
        const token = match[0];
        const offset = globalStart + (match.index ?? 0);
        if (token.startsWith("(") && token.endsWith(")")) {
          validateTokens(token.slice(1, -1), offset + 1);
        } else {
          validateIdentifier(token, offset);
        }
      }
    } else {
      addErrorRange(firstOffset, firstOffset + firstToken.length);
      for (const match of rest) {
        const token = match[0];
        const offset = globalStart + (match.index ?? 0);
        if (token.startsWith("(") && token.endsWith(")")) {
          validateTokens(token.slice(1, -1), offset + 1);
        } else {
          validateIdentifier(token, offset);
        }
      }
    }
  };

  for (let index = 0; index < content.length; ) {
    const openIndex = content.indexOf("{{", index);
    if (openIndex === -1) break;

    const triple = content.startsWith("{{{", openIndex);
    const closeToken = triple ? "}}}" : "}}";
    const closeIndex = content.indexOf(closeToken, openIndex + (triple ? 3 : 2));
    if (closeIndex === -1) {
      addErrorLine(openIndex);
      break;
    }

    const exprStart = openIndex + (triple ? 3 : 2);
    const expr = content.slice(exprStart, closeIndex);
    validateExpression(expr, exprStart);
    index = closeIndex + closeToken.length;
  }

  for (const dangling of blockStack) {
    errorLines.add(dangling.line);
  }

  return {
    errorLines: Array.from(errorLines).sort((a, b) => a - b),
    errorRanges,
  };
}
