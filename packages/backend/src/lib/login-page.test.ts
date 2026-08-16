import { describe, expect, it } from 'vitest';
import { injectLoginAuthMethods, LOGIN_AUTH_METHODS_PLACEHOLDER } from './login-page.js';

describe('injectLoginAuthMethods', () => {
  it('embeds public auth methods in an HTML attribute without executable markup', () => {
    const html = `<meta name="gateway-auth-methods" content="${LOGIN_AUTH_METHODS_PLACEHOLDER}">`;
    const rendered = injectLoginAuthMethods(html, {
      oidc: true,
      password: true,
      emailOtp: false,
      passkeyLogin: false,
    });

    expect(rendered).toContain(
      'content="{&quot;oidc&quot;:true,&quot;password&quot;:true,&quot;emailOtp&quot;:false,&quot;passkeyLogin&quot;:false}"'
    );
    expect(rendered).not.toContain(LOGIN_AUTH_METHODS_PLACEHOLDER);
    expect(rendered).not.toContain('<script');
  });

  it('leaves an empty bootstrap when methods are temporarily unavailable', () => {
    expect(injectLoginAuthMethods(LOGIN_AUTH_METHODS_PLACEHOLDER, null)).toBe('');
  });
});
