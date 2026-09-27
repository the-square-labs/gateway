import { describe, expect, it } from 'vitest';
import { createAuthEmail } from './auth-email.templates.js';

describe('account invitation email', () => {
  const base = {
    kind: 'account_invitation' as const,
    actionUrl: 'https://gateway.example.com/login',
    email: 'new.user@example.com',
  };

  it('tells the user an account was created and links to the Gateway sign-in page', () => {
    const message = createAuthEmail({ ...base, signIn: 'oidc' });

    expect(message.subject).toBe('Gateway: an account was created for you');
    expect(message.text).toContain('An administrator created a Gateway account for new.user@example.com.');
    expect(message.text).toContain('https://gateway.example.com/login');
    expect(message.html).toContain('href="https://gateway.example.com/login"');
    expect(message.html).toContain('Sign in to Gateway');
  });

  it('explains the sign-in step for each sign-in method', () => {
    expect(createAuthEmail({ ...base, signIn: 'oidc' }).text).toContain('single sign-on (SSO) provider');
    expect(createAuthEmail({ ...base, signIn: 'email_otp' }).text).toContain('one-time code');
    const password = createAuthEmail({ ...base, signIn: 'password' }).text;
    expect(password).toContain('A separate email contains a link to set your password');
  });

  it('escapes the recipient address in the HTML body', () => {
    const message = createAuthEmail({ ...base, email: '<x>@example.com', signIn: 'oidc' });

    expect(message.html).toContain('&lt;x&gt;@example.com');
    expect(message.html).not.toContain('<x>@example.com');
  });
});
