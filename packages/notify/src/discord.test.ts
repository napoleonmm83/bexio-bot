import { expect, test, describe } from 'bun:test';
import { isAllowedDiscordWebhook, pickStatus } from './discord.ts';

// Minimal DiscordRunReport for pickStatus (only errors/results/subscriptionResults matter).
const report = (over: Record<string, unknown> = {}) => ({
  runId: 1, startedAt: new Date(), finishedAt: new Date(),
  enabledOrders: 0, newOrders: [], driftWarnings: [], unsupportedOrders: [],
  errors: [], results: [], subscriptionResults: [], ...over,
});

describe('pickStatus — run-level errors[] must not be masked by a green headline (B2)', () => {
  test('errors + at least one sent → partial (was mis-reported success)', () => {
    expect(pickStatus(report({ errors: [{ stage: 'processOrder(5)', message: 'boom' }], results: [{ kind: 'sent' }] }) as never)).toBe('partial');
  });
  test('errors + no results → failed', () => {
    expect(pickStatus(report({ errors: [{ stage: 'crash-recovery', message: 'reclaimed' }] }) as never)).toBe('failed');
  });
  test('no errors + a sent order → success', () => {
    expect(pickStatus(report({ results: [{ kind: 'sent' }] }) as never)).toBe('success');
  });
  test('a failed result → failed; failed + sent → partial (unchanged)', () => {
    expect(pickStatus(report({ results: [{ kind: 'failed' }] }) as never)).toBe('failed');
    expect(pickStatus(report({ results: [{ kind: 'failed' }, { kind: 'sent' }] }) as never)).toBe('partial');
  });
  test('nothing sent, no errors → no-due', () => {
    expect(pickStatus(report() as never)).toBe('no-due');
  });
});

describe('isAllowedDiscordWebhook — webhook host allowlist blocks SSRF (SEC-4)', () => {
  test('official Discord hosts over https are allowed', () => {
    for (const u of [
      'https://discord.com/api/webhooks/1/abc',
      'https://canary.discord.com/api/webhooks/1/abc',
      'https://ptb.discord.com/api/webhooks/1/abc',
      'https://discordapp.com/api/webhooks/1/abc',
    ]) {
      expect(isAllowedDiscordWebhook(u)).toBe(true);
    }
  });

  test('non-Discord, lookalike, internal, and non-https hosts are rejected', () => {
    for (const u of [
      'https://evil.com/api/webhooks/1/abc',
      'https://discord.com.evil.com/x',
      'https://notdiscord.com/x',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/x',
      'http://discord.com/api/webhooks/1/abc',
      'not a url',
      '',
    ]) {
      expect(isAllowedDiscordWebhook(u)).toBe(false);
    }
  });
});
