// Notification adapters. Phase 1 = Discord only. Phase 2 adds email + Notion.
// Pattern: each adapter returns Promise<DiscordSendResult> (channel-tagged in notifyAll).
// Worker uses Promise.allSettled so a failing channel never blocks the run.

export {
  sendRunReport as sendDiscordRunReport,
  sendMessage as sendDiscordMessage,
  type DiscordRunReport,
  type DiscordSendResult,
} from './discord.ts';

import { sendRunReport, type DiscordRunReport, type DiscordSendResult } from './discord.ts';

export type ChannelResult = (DiscordSendResult & { channel: 'discord' });

/** Extended report shape accepted by notifyAll. Adds optional subscription results that
 *  individual adapters may render (Discord rendering added in Task 9). */
export type NotifyAllReport = DiscordRunReport & {
  subscriptionResults?: Array<{
    kind: string;
    subscriptionId: number;
    [key: string]: unknown;
  }>;
};

/**
 * Fan-out the daily run report to all configured channels.
 * Currently only Discord. Phase 2 adds email + Notion in parallel.
 *
 * Reads channel URLs/keys from env. If a channel isn't configured, it's skipped silently.
 */
export async function notifyAll(report: NotifyAllReport): Promise<ChannelResult[]> {
  const tasks: Array<Promise<ChannelResult>> = [];

  const discordUrl = process.env.DISCORD_WEBHOOK_URL;
  if (discordUrl) {
    tasks.push(
      sendRunReport(discordUrl, report).then((r) => ({ ...r, channel: 'discord' as const })),
    );
  }

  const settled = await Promise.allSettled(tasks);
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { ok: false, channel: 'discord', error: String(s.reason) } as ChannelResult,
  );
}
