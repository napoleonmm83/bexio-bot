import { expect, test, describe } from 'bun:test';
import { fitLines, isAllowedDiscordWebhook, pickStatus } from './discord.ts';

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
  test('a notice (e.g. TV-Rheintal reminder) never turns the run red', () => {
    expect(pickStatus(report({ notices: ['RE-00284 noch nicht versendet'] }) as never)).toBe('no-due');
  });
  test('overdue invoices never turn the run red', () => {
    expect(pickStatus(report({ overdueInvoices: ['RE-1 · X · CHF 1.00 · 3 Tage überfällig'] }) as never)).toBe('no-due');
  });
});

describe('fitLines — Discord field limit without cutting a line', () => {
  test('everything fits → plain join', () => {
    expect(fitLines(['a', 'b'], 1024)).toBe('a\nb');
  });
  test('overflow keeps whole lines and stays within the limit', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `RE-${String(i).padStart(5, '0')} · Kunde mit langem Namen · CHF 1'000.00 · 12 Tage`);
    const out = fitLines(lines, 1024);
    expect(out.length).toBeLessThanOrEqual(1024);
    const shown = out.split('\n');
    expect(shown.at(-1)).toBe(`… und ${60 - (shown.length - 1)} weitere`);
    expect(lines).toContain(shown[0]!);
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
