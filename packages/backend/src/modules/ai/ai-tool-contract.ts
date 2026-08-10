import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { AIToolDefinition } from './ai.types.js';

export type AIToolArgumentsResult = { ok: true; arguments: Record<string, unknown> } | { ok: false; error: string };

export interface AIToolArgumentValidator {
  parseAndValidate(toolName: string, rawArguments: string): AIToolArgumentsResult;
  validate(toolName: string, argumentsValue: unknown): AIToolArgumentsResult;
}

export function createAIToolArgumentValidator(tools: readonly AIToolDefinition[]): AIToolArgumentValidator {
  const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: false });
  const validators = new Map<string, { tool: AIToolDefinition; validate: ValidateFunction }>();

  for (const tool of tools) {
    if (validators.has(tool.name)) throw new Error(`Duplicate AI tool definition: ${tool.name}`);
    validators.set(tool.name, { tool, validate: ajv.compile(tool.parameters) });
  }

  return {
    parseAndValidate(toolName, rawArguments) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawArguments || '{}');
      } catch {
        return { ok: false, error: 'Invalid tool arguments: malformed JSON' };
      }

      return validateArguments(validators, toolName, parsed);
    },
    validate: (toolName, argumentsValue) => validateArguments(validators, toolName, argumentsValue),
  };
}

function validateArguments(
  validators: ReadonlyMap<string, { tool: AIToolDefinition; validate: ValidateFunction }>,
  toolName: string,
  argumentsValue: unknown
): AIToolArgumentsResult {
  const compiled = validators.get(toolName);
  if (!compiled) return { ok: false, error: `Unknown AI tool: ${toolName}` };
  if (!isPlainObject(argumentsValue)) {
    return { ok: false, error: 'Invalid tool arguments: expected a JSON object' };
  }
  if (!compiled.validate(argumentsValue)) {
    return { ok: false, error: formatValidationErrors(compiled.validate.errors) };
  }
  const operationDiscriminator = compiled.tool.operationDiscriminator;
  if (operationDiscriminator) {
    const values = operationDiscriminator.arguments.map((argument) => argumentsValue[argument]);
    const key = values.join('.');
    if (values.some((value) => typeof value !== 'string') || !operationDiscriminator.operations[key]) {
      return {
        ok: false,
        error: `Invalid tool arguments at ${operationDiscriminator.arguments.map((argument) => `$/${argument}`).join(', ')}`,
      };
    }
  }
  return { ok: true, arguments: argumentsValue };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function formatValidationErrors(errors: ErrorObject[] | null | undefined): string {
  const paths = [...new Set((errors ?? []).map(validationErrorPath))].sort();
  return `Invalid tool arguments${paths.length > 0 ? ` at ${paths.join(', ')}` : ''}`;
}

function validationErrorPath(error: ErrorObject): string {
  if (error.keyword === 'required') {
    const missing = (error.params as { missingProperty?: unknown }).missingProperty;
    if (typeof missing === 'string' && missing) return `${error.instancePath || '$'}/${missing}`;
  }
  if (error.keyword === 'additionalProperties') {
    const property = (error.params as { additionalProperty?: unknown }).additionalProperty;
    if (typeof property === 'string' && property) return `${error.instancePath || '$'}/${property}`;
  }
  return error.instancePath || '$';
}
