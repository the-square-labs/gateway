import { CliError } from './errors.js';
import { type InteractiveSetupSession, runInteractiveInferenceSetup } from './interactive-setup.js';
import type { InteractiveCliUi, InteractiveOption } from './interactive-ui.js';

const SESSION = {
  profile: {
    origin: 'https://gateway.example.com',
    installationId: '11111111-1111-4111-8111-111111111111',
    clientId: 'goc_test',
    createdAt: '2026-07-30T00:00:00Z',
    updatedAt: '2026-07-30T00:00:00Z',
  },
  discovery: {
    schemaVersion: 2 as const,
    enabled: true,
    minimumCliVersion: '0.3.0',
    oauth: {
      resource: 'https://gateway.example.com/api/inference/setup',
      authorizationServer: 'https://gateway.example.com',
    },
    adapters: {
      openai: { baseUrl: 'https://gateway.example.com/api/inference/v1' },
      anthropic: { baseUrl: 'https://gateway.example.com/api/inference' },
    },
  },
  client: {} as InteractiveSetupSession['client'],
} satisfies InteractiveSetupSession;

describe('interactive inference setup', () => {
  it('authorizes an unconfigured profile before selecting and configuring a supported harness', async () => {
    const ui = new FakeUi();
    let authorized = false;
    const authorize = vi.fn(async () => {
      authorized = true;
      return true;
    });
    const configure = vi.fn(async () => ({ progress: 'Configured Codex', summary: 'Ready' }));

    const exitCode = await runInteractiveInferenceSetup({
      profileName: 'work',
      ui,
      session: async () => {
        if (!authorized) throw new CliError('NOT_LOGGED_IN', 'Not logged in');
        return SESSION;
      },
      authorize,
      configure,
    });

    expect(exitCode).toBe(0);
    expect(authorize).toHaveBeenCalledWith('https://gateway.example.com');
    expect(ui.options).toEqual([
      expect.objectContaining({ value: 'codex', label: 'Codex CLI', hint: expect.stringContaining('catalog') }),
      expect.objectContaining({ value: 'claude-code', label: 'Claude Code CLI' }),
    ]);
    expect(configure).toHaveBeenCalledWith('codex', SESSION);
    expect(ui.events).toEqual([
      'intro:Wiolett Gateway Inference · Setup',
      'info:Gateway authorization complete',
      'select',
      'spinner:Configuring Codex CLI...',
      'stop:Configured Codex',
      'outro:Ready',
    ]);
  });

  it('cancels without configuring after an authenticated user closes the harness prompt', async () => {
    const ui = new FakeUi();
    ui.harness = null;
    const configure = vi.fn();

    await expect(
      runInteractiveInferenceSetup({
        profileName: 'default',
        existingOrigin: SESSION.profile.origin,
        ui,
        session: async () => SESSION,
        authorize: vi.fn(),
        configure,
      })
    ).resolves.toBe(0);

    expect(configure).not.toHaveBeenCalled();
    expect(ui.events).toContain('cancel:Setup cancelled.');
  });

  it('offers Claude Code alongside Codex on the single stable prefix', async () => {
    const ui = new FakeUi();
    ui.harness = 'claude-code';
    const configure = vi.fn(async () => ({ progress: 'Configured Claude Code', summary: 'Ready' }));

    await runInteractiveInferenceSetup({
      profileName: 'default',
      ui,
      session: async () => SESSION,
      authorize: vi.fn(),
      configure,
    });

    expect(ui.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'claude-code',
          label: 'Claude Code CLI',
          hint: expect.stringContaining('Anthropic'),
        }),
      ])
    );
    expect(configure).toHaveBeenCalledWith('claude-code', SESSION);
  });
});

class FakeUi implements InteractiveCliUi {
  events: string[] = [];
  options: InteractiveOption[] = [];
  harness: string | null = 'codex';

  intro(title: string) {
    this.events.push(`intro:${title}`);
  }
  info(message: string) {
    this.events.push(`info:${message}`);
  }
  error(message: string) {
    this.events.push(`error:${message}`);
  }
  async gatewayOrigin() {
    return 'https://gateway.example.com';
  }
  async inferenceToken() {
    return 'gwi_test';
  }
  async select(_message: string, options: InteractiveOption[]) {
    this.options = options;
    this.events.push('select');
    return this.harness;
  }
  async confirm() {
    return true;
  }
  spinner(message: string) {
    this.events.push(`spinner:${message}`);
    return {
      stop: (result: string) => this.events.push(`stop:${result}`),
      error: (result: string) => this.events.push(`error:${result}`),
    };
  }
  cancel(message: string) {
    this.events.push(`cancel:${message}`);
  }
  outro(message: string) {
    this.events.push(`outro:${message}`);
  }
}
