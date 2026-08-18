import { describe, expect, it } from 'vitest';
import { PageLabelTemplateSchema, UpdatePageProfileSchema } from './page-profile.schemas.js';
import { renderPageHostname } from './page-profile.service.js';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('Pages preview label templates', () => {
  it.each(['{hash}', 'preview-{hash}', '{project}-{hash}'])('accepts %s', (template) => {
    expect(PageLabelTemplateSchema.parse(template)).toBe(template);
  });

  it.each([
    'preview.example-{hash}',
    'preview',
    '{hash}-{hash}',
    'Preview-{hash}',
    '{branch}-{hash}',
    '-{hash}',
    '{hash}-',
  ])('rejects %s', (template) => {
    expect(PageLabelTemplateSchema.safeParse(template).success).toBe(false);
  });

  it('defaults the enabled profile template and acknowledgement safely', () => {
    expect(
      UpdatePageProfileSchema.parse({
        enabled: true,
        domainId: UUID,
        nodeId: UUID,
        certificateId: UUID,
      })
    ).toMatchObject({ labelTemplate: '{hash}', acknowledgeSameRegistrableDomain: false });
  });

  it('renders exactly one label below the configured domain', () => {
    expect(renderPageHostname('{project}-{hash}', 'abc123', 'docs', '*.pages.example.com')).toBe(
      'docs-abc123.pages.example.com'
    );
  });

  it('rejects a template that exceeds the DNS label limit for a concrete Project', () => {
    expect(() =>
      renderPageHostname('{project}-{hash}', 'abcdefghijklmnop', 'a'.repeat(60), 'pages.example.com')
    ).toThrowError(expect.objectContaining({ code: 'PAGES_PREVIEW_LABEL_INVALID' }));
  });
});
