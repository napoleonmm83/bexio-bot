// Coolify healthcheck endpoint.
// Returns 200 if Postgres is reachable AND last bot run is < 26h old (or no run yet).

import { desc } from 'drizzle-orm';
import type { RequestHandler } from './$types.ts';
import { getDb, botRuns } from '@bexio-bot/db';

const STALE_RUN_MS = 26 * 60 * 60 * 1000;

export const GET: RequestHandler = async () => {
  const db = getDb();

  try {
    const rows = await db.select().from(botRuns).orderBy(desc(botRuns.startedAt)).limit(1);
    const lastRun = rows[0] ?? null;
    const lastRunStartedAt = lastRun?.startedAt ?? null;

    const now = Date.now();
    const lastRunStale = lastRunStartedAt
      ? now - new Date(lastRunStartedAt).getTime() > STALE_RUN_MS
      : false;

    if (lastRunStale) {
      return new Response(
        JSON.stringify({ status: 'stale', lastRun: lastRunStartedAt }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({
        status: 'ok',
        lastRun: lastRunStartedAt,
        lastRunFinished: lastRun?.finishedAt ?? null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    // SEC-3: /health is unauthenticated (Coolify canary). Driver errors can carry
    // connection-string fragments / host / role — log server-side, return generic.
    console.error('[health] db_error:', err);
    return new Response(
      JSON.stringify({ status: 'db_error' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
