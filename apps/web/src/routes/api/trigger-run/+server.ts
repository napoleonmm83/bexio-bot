// POST /api/trigger-run — on-demand worker run, triggered by Claude Cowork
// or any caller with a valid Cloudflare Access service token.
//
// Flow:
//   1. Verify Cf-Access-Jwt-Assertion (fail-closed)
//   2. Check for in-flight run started <30min ago → 409 Conflict
//   3. Insert bot_runs row (started_at=now, finished_at=null,
//      trigger_source='cowork')
//   4. Fire-and-forget runDaily() with the pre-inserted runId
//   5. Return 202 + { runId, statusUrl }
//
// Stale-run handling: a row with started_at >30min ago and finished_at=null
// is treated as dead (process likely crashed) and does NOT block new triggers.
// Crash recovery inside runDaily reconciles any in-flight invoice_runs on the
// next run.

import { eq, sql } from 'drizzle-orm';
import type { RequestHandler } from './$types.ts';
import { getDb, botRuns } from '@bexio-bot/db';
import { runDaily } from '@bexio-bot/worker/run';
import { verifyCfAccess, CfAccessError } from '$lib/server/cf-access.ts';

// A real production run can exceed 30 min when many orders × bexio's 1.1s
// rate-limit pacing. Two hours is a defensive upper bound; override via
// WORKER_RUN_STALE_MS env var if the order count grows beyond that. (F-5)
const STALE_MS = Number(process.env.WORKER_RUN_STALE_MS ?? 2 * 60 * 60 * 1000);

export const POST: RequestHandler = async ({ request }) => {
  try {
    const identity = await verifyCfAccess(request);

    const body: { dryRun?: boolean; onlyOrderId?: number } = await request.json().catch(() => ({}));
    const dryRun = body.dryRun === true;
    const onlyOrderId = Number.isInteger(body.onlyOrderId) && body.onlyOrderId! > 0
      ? body.onlyOrderId
      : undefined;

    const db = getDb();

    // Look for any recent run that's still in-flight.
    const inFlight = await db
      .select({ id: botRuns.id, startedAt: botRuns.startedAt })
      .from(botRuns)
      .where(sql`${botRuns.finishedAt} IS NULL`)
      .orderBy(sql`${botRuns.startedAt} DESC`)
      .limit(1);

    if (inFlight.length > 0) {
      const existing = inFlight[0]!;
      const age = Date.now() - new Date(existing.startedAt).getTime();
      if (age < STALE_MS) {
        return json(409, {
          status: 'already-running',
          runId: existing.id,
          startedAt: existing.startedAt,
          statusUrl: `/api/runs/${existing.id}`,
        });
      }
      // Older than STALE_MS → mark dead, then proceed.
      await db
        .update(botRuns)
        .set({
          finishedAt: new Date(),
          errorsJsonb: sql`'[{"stage":"trigger-run","message":"abandoned — superseded by new trigger"}]'::jsonb`,
        })
        .where(eq(botRuns.id, existing.id));
    }

    const startedAt = new Date();
    const [row] = await db
      .insert(botRuns)
      .values({
        startedAt,
        triggerSource: 'cowork',
        notes: `triggered by ${identity.subject}${dryRun ? ' (dry-run)' : ''}${onlyOrderId ? ` order:${onlyOrderId}` : ''}`,
      })
      .returning({ id: botRuns.id });
    const runId = row!.id;

    // Fire-and-forget. runDaily updates the bot_runs row to finishedAt on its
    // own. We attach a catch so unhandled rejections can't crash the process,
    // and so a thrown error still marks the row finished (with the message).
    queueMicrotask(() => {
      runDaily(db, { dryRun, onlyOrderId, triggerSource: 'cowork', existingRunId: runId }).catch(
        async (err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[trigger-run #${runId}] runDaily threw:`, message);
          try {
            await db
              .update(botRuns)
              .set({
                finishedAt: new Date(),
                errorsJsonb: sql`${JSON.stringify([{ stage: 'runDaily', message }])}::jsonb`,
              })
              .where(eq(botRuns.id, runId));
          } catch (innerErr) {
            console.error(`[trigger-run #${runId}] also failed to mark row failed:`, innerErr);
          }
        },
      );
    });

    return json(202, {
      status: 'running',
      runId,
      startedAt,
      statusUrl: `/api/runs/${runId}`,
      triggeredBy: identity.subject,
    });
  } catch (err) {
    if (err instanceof CfAccessError) {
      const status = err.code === 'server-misconfigured' ? 500 : 401;
      return json(status, { error: err.code, message: err.message });
    }
    return json(500, {
      error: 'internal',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
