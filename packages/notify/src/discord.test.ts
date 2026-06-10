import { expect, test, describe } from 'bun:test';
import { isAllowedDiscordWebhook } from './discord.ts';

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
