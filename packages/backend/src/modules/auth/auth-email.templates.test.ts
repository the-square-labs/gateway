import { describe, expect, it } from 'vitest';
import { createAuthEmail, GATEWAY_EMAIL_LOGO_URL } from './auth-email.templates.js';

describe('authentication email templates', () => {
  it('renders a branded password setup email with a safe action URL', () => {
    const message = createAuthEmail({
      kind: 'password_setup',
      actionUrl: 'https://gateway.example/reset-password?token=<test-token>',
    });

    expect(message.subject).toBe('Gateway: set your password');
    expect(message.text).toContain('https://gateway.example/reset-password?token=<test-token>');
    expect(message.html).toContain(GATEWAY_EMAIL_LOGO_URL);
    expect(message.html).toContain('Wiolett Gateway');
    expect(message.html).toContain('Set password');
    expect(message.html).toContain('token=&lt;test-token&gt;');
    expect(message.html).toContain('Powered by Wiolett Industries');
  });

  it('renders the OTP code without a sign-in link', () => {
    const message = createAuthEmail({ kind: 'email_otp', code: '428916' });

    expect(message.subject).toBe('Your Gateway sign-in code');
    expect(message.text).toContain('428916');
    expect(message.html).toContain('428916');
    expect(message.html).not.toContain('Reset password');
    expect(message.html).not.toContain('Set password');
  });

  it('renders a non-actionable SMTP configuration test', () => {
    const message = createAuthEmail({ kind: 'smtp_configuration' });

    expect(message.subject).toBe('Gateway SMTP test');
    expect(message.text).toContain('No action is required');
    expect(message.html).toContain('SMTP test');
    expect(message.html).not.toContain('reset-password?token=');
  });
});
