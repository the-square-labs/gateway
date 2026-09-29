import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Handlebars from 'handlebars';
import { describe, expect, it, vi } from 'vitest';
import type { ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { NginxTemplateService } from './nginx-template.service.js';
import { OVERRIDABLE_TEMPLATE_VARIABLE_NAMES, RESERVED_TEMPLATE_VARIABLE_NAMES } from './proxy-template-variables.js';

// Grant cleanup on delete is covered against PostgreSQL in resource-scope-cleanup.database.test.ts.
vi.mock('@/lib/resource-scope-cleanup.js', () => ({
  transactionWithScopeCleanup: (db: any, work: (tx: any) => unknown) =>
    db.transaction ? db.transaction(work) : work(db),
}));
vi.mock('@/db/schema/proxy-hosts.js', () => ({ proxyHosts: { nginxTemplateId: 'nginx_template_id' } }));
vi.mock('@/db/schema/nginx-templates.js', () => ({
  nginxTemplates: { id: 'nginx_templates.id', type: 'nginx_templates.type', isBuiltin: 'nginx_templates.is_builtin' },
}));

// The template editor checks variables and helpers against these generated copies.
const FRONTEND_CONTEXT = join(process.cwd(), '../frontend/src/lib/nginx-template-context.ts');
const FRONTEND_BUILTIN_TEMPLATES = join(process.cwd(), '../frontend/src/test/nginx-builtin-templates.json');
const REGENERATE =
  'cd packages/backend && UPDATE_NGINX_TEMPLATE_CONTEXT=1 pnpm vitest run src/modules/proxy/nginx-template-context.test.ts';

/** Handlebars' own block helpers; the rest are called inline. */
const HANDLEBARS_BLOCK_HELPERS = ['each', 'if', 'unless', 'with'];

const host: ProxyHostConfig = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'proxy',
  domainNames: ['example.com'],
  enabled: true,
  forwardHost: 'app',
  forwardPort: 8080,
  forwardScheme: 'http',
  sslEnabled: false,
  sslForced: false,
  http2Support: false,
  websocketSupport: false,
  redirectUrl: null,
  redirectStatusCode: 301,
  customHeaders: [],
  cacheEnabled: false,
  cacheOptions: null,
  rateLimitEnabled: false,
  rateLimitOptions: null,
  customRewrites: [],
  advancedConfig: null,
  accessList: null,
  sslCertPath: null,
  sslKeyPath: null,
  sslChainPath: null,
};

function service() {
  const db = { query: { nginxTemplates: { findFirst: async () => undefined } } };
  return new NginxTemplateService(db as never, {} as never);
}

/** Every key of the context a template renders with, read from inside a render. */
function renderContextVariables(): string[] {
  let keys: string[] = [];
  Handlebars.registerHelper('captureContext', function (this: Record<string, unknown>) {
    keys = Object.keys(this);
    return '';
  });
  try {
    service().renderTemplate('{{captureContext}}', host);
  } finally {
    Handlebars.unregisterHelper('captureContext');
  }
  return keys.sort();
}

/** Helpers a template can call; the `*Missing` hooks are Handlebars internals. */
function templateHelpers(): string[] {
  return Object.keys(Handlebars.helpers)
    .filter((name) => !name.endsWith('Missing'))
    .sort();
}

function renderList(name: string, doc: string, values: string[]): string[] {
  const declaration = `export const ${name}: readonly string[] = [`;
  const oneLine = `${declaration}${values.map((value) => `"${value}"`).join(', ')}];`;
  if (oneLine.length <= 100) return [`/** ${doc} */`, oneLine];
  return [`/** ${doc} */`, declaration, ...values.map((value) => `  "${value}",`), '];'];
}

/** The generated frontend module, formatted the way Biome keeps it. */
function renderFrontendContext(): string {
  return `${[
    '// Generated from the nginx template renderer (packages/backend/src/modules/proxy). Do not edit by hand.',
    `// Regenerate: ${REGENERATE}`,
    '',
    ...renderList(
      'NGINX_TEMPLATE_CONTEXT_VARIABLES',
      'Variables Gateway puts in the render context of every nginx template.',
      renderContextVariables()
    ),
    '',
    ...renderList('NGINX_TEMPLATE_HELPERS', 'Handlebars helpers nginx templates can call.', templateHelpers()),
    '',
    ...renderList(
      'NGINX_TEMPLATE_BLOCK_HELPERS',
      'Helpers that open a block: `{{#name}}…{{/name}}`.',
      HANDLEBARS_BLOCK_HELPERS
    ),
  ].join('\n')}\n`;
}

async function builtinTemplates(): Promise<Record<string, string>> {
  const templates = service();
  return {
    proxy: await templates.getBuiltinTemplateContent('proxy'),
    redirect: await templates.getBuiltinTemplateContent('redirect'),
    '404': await templates.getBuiltinTemplateContent('404'),
  };
}

async function renderFrontendBuiltinTemplates(): Promise<string> {
  const fixture = {
    generatedFrom: 'packages/backend/src/modules/proxy/nginx-template.service.ts',
    regenerate: REGENERATE,
    templates: await builtinTemplates(),
  };
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

function parseFrontendList(source: string, name: string): string[] {
  const body = source.match(new RegExp(`${name}[^=]*= \\[([\\s\\S]*?)\\];`));
  if (!body) throw new Error(`${name} not found`);
  return [...body[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe('nginx template context shipped to the frontend', () => {
  it('renders with exactly the managed and overridable variables', () => {
    expect(renderContextVariables()).toEqual(
      [...RESERVED_TEMPLATE_VARIABLE_NAMES, ...OVERRIDABLE_TEMPLATE_VARIABLE_NAMES].sort()
    );
  });

  it('keeps the block helpers registered', () => {
    expect(templateHelpers()).toEqual(expect.arrayContaining(HANDLEBARS_BLOCK_HELPERS));
  });

  it('ships the render context and helpers to the template editor', async () => {
    if (process.env.UPDATE_NGINX_TEMPLATE_CONTEXT === '1') {
      writeFileSync(FRONTEND_CONTEXT, renderFrontendContext());
      writeFileSync(FRONTEND_BUILTIN_TEMPLATES, await renderFrontendBuiltinTemplates());
    }
    const source = readFileSync(FRONTEND_CONTEXT, 'utf8');
    expect(parseFrontendList(source, 'NGINX_TEMPLATE_CONTEXT_VARIABLES')).toEqual(renderContextVariables());
    expect(parseFrontendList(source, 'NGINX_TEMPLATE_HELPERS')).toEqual(templateHelpers());
    expect(parseFrontendList(source, 'NGINX_TEMPLATE_BLOCK_HELPERS')).toEqual(HANDLEBARS_BLOCK_HELPERS);
  });

  it('ships the built-in template sources the editor analysis is tested on', async () => {
    const fixture = JSON.parse(readFileSync(FRONTEND_BUILTIN_TEMPLATES, 'utf8')) as {
      templates: Record<string, string>;
    };
    expect(fixture.templates).toEqual(await builtinTemplates());
  });
});
