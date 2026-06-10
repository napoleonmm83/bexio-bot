// Notification adapters. Phase 1 = Discord only. Phase 2 adds email + Notion.
// Pattern: each adapter returns Promise<DiscordSendResult> (channel-tagged in notifyAll).
// Worker uses Promise.allSettled so a failing channel never blocks the run.

export {
  sendRunReport as sendDiscordRunReport,
  sendMessage as sendDiscordMessage,
  isAllowedDiscordWebhook,
  type DiscordRunReport,
  type DiscordSendResult,
} from './discord.ts';

import { sendRunReport, type DiscordRunReport, type DiscordSendResult } from './discord.ts';

export type ChannelResult = (DiscordSendResult & { channel: 'discord' });

/** Extended report shape accepted by notifyAll. Subscription results are now
 *  part of DiscordRunReport directly, so NotifyAllReport is just an alias. */
export type NotifyAllReport = DiscordRunReport;

/** Runtime notification config. All optional → falls back to env / skips. */
export type NotifyConfig = {
  /** Master switch. When false, no channels are notified. Default: on. */
  enabled?: boolean;
  /** Discord webhook URL. Falls back to DISCORD_WEBHOOK_URL env when absent. */
  discordWebhookUrl?: string;
  /** Deep-link base for embeds. Falls back to DASHBOARD_URL env when absent. */
  dashboardUrl?: string;
};

/**
 * Fan-out the daily run report to all configured channels.
 * Currently only Discord. Phase 2 adds email + Notion in parallel.
 *
 * Config resolves DB-backed settings → env. If a channel isn't configured (or
 * notifications are disabled), it's skipped silently.
 */
export async function notifyAll(
  report: NotifyAllReport,
  config: NotifyConfig = {},
): Promise<ChannelResult[]> {
  if (config.enabled === false) return [];

  const tasks: Array<Promise<ChannelResult>> = [];

  const discordUrl = config.discordWebhookUrl ?? process.env.DISCORD_WEBHOOK_URL;
  if (discordUrl) {
    tasks.push(
      sendRunReport(discordUrl, report, config.dashboardUrl).then((r) => ({ ...r, channel: 'discord' as const })),
    );
  }

  const settled = await Promise.allSettled(tasks);
  return settled.map((s) =>
    s.status === 'fulfilled'
      ? s.value
      : { ok: false, channel: 'discord', error: String(s.reason) } as ChannelResult,
  );
}
