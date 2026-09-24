import { AppError } from '@/middleware/error-handler.js';
import { CreateTemplateSchema, UpdateTemplateSchema } from '@/modules/pki/templates.schemas.js';
import type { TemplatesService } from '@/modules/pki/templates.service.js';
import type { User } from '@/types.js';

export const PKI_TEMPLATE_TOOL_NAMES = new Set([
  'list_templates',
  'create_template',
  'delete_template',
  'manage_template',
]);

export interface PkiTemplateToolContext {
  templatesService: TemplatesService;
  ensureToolScope(user: User, scope: string): void;
  ensureToolScopeForResource(user: User, baseScope: string, resourceId: string): void;
}

/** Template fields accepted by the template routes; `type` and `extendedKeyUsage` are the tool's older aliases. */
function templateFields(a: Record<string, any>) {
  return {
    name: a.name,
    description: a.description,
    certType: a.certType ?? a.type,
    keyAlgorithm: a.keyAlgorithm,
    validityDays: a.validityDays,
    keyUsage: a.keyUsage,
    extKeyUsage: a.extKeyUsage ?? a.extendedKeyUsage,
    requireSans: a.requireSans,
    sanTypes: a.sanTypes,
    subjectDnFields: a.subjectDnFields,
    crlDistributionPoints: a.crlDistributionPoints,
    authorityInfoAccess: a.authorityInfoAccess,
    certificatePolicies: a.certificatePolicies,
    customExtensions: a.customExtensions,
  };
}

function definedFields<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

export async function executePkiTemplateTool(
  context: PkiTemplateToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;

  // The template routes use broad requireScope checks, never per-template grants.
  switch (toolName) {
    case 'list_templates':
      context.ensureToolScope(user, 'pki:templates:view');
      return context.templatesService.listTemplates();
    case 'create_template':
      context.ensureToolScope(user, 'pki:templates:create');
      return context.templatesService.createTemplate(
        CreateTemplateSchema.parse({ keyUsage: [], extKeyUsage: [], ...definedFields(templateFields(a)) }),
        user.id
      );
    case 'delete_template':
      context.ensureToolScope(user, 'pki:templates:delete');
      await context.templatesService.deleteTemplate(a.templateId);
      return { success: true };
    case 'manage_template':
      if (a.operation === 'get') {
        context.ensureToolScope(user, 'pki:templates:view');
        const template = await context.templatesService.getTemplate(a.templateId);
        if (!template) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
        return template;
      }
      if (a.operation === 'update') {
        context.ensureToolScope(user, 'pki:templates:edit');
        return context.templatesService.updateTemplate(
          a.templateId,
          UpdateTemplateSchema.parse(definedFields(templateFields(a)))
        );
      }
      throw new Error(`Unsupported PKI template operation: ${String(a.operation)}`);
    default:
      throw new Error(`Unsupported PKI template tool: ${toolName}`);
  }
}
