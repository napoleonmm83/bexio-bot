// GET /api/runs/[id] — return the current status of a single bot run as JSON.
// Used by Cowork (or any HTTP caller) to poll until finished_at is set.
//
// status field semantics:
//   'running'   — finished_at IS NULL, started_at < STALE_MS ago
//   'completed' — finished_at IS NOT NULL, no errors
//   'failed'    — finished_at IS NOT NULL, errors_jsonb is non-empty
//   'stale'     — finished_at IS NULL but started_at older than STALE_MS

import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types.ts';
import { getDb, botRuns } from '@bexio-bot/db';
import { verifyCfAccess, CfAccessError } from '$lib/server/cf-access.ts';

const STALE_MS = 30 * 60 * 1000;

export const GET: RequestHandler = async ({ request, params }) => {
  try {
    await verifyCfAccess(request);

    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return json(400, { error: 'invalid-id', message: 'run id must be a positive integer' });
    }

    const db = getDb();
    const rows = await db.select().from(botRuns).where(eq(botRuns.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      return json(404, { error: 'not-found', message: `no run with id ${id}` });
    }

    const errorsArray = Array.isArray(row.errorsJsonb)
      ? (row.errorsJsonb as Array<{ stage?: string; message?: string }>)
      : [];

    let status: 'running' | 'completed' | 'failed' | 'stale';
    if (row.finishedAt) {
      status = errorsArray.length > 0 ? 'failed' : 'completed';
    } else {
      const age = Date.now() - new Date(row.startedAt).getTime();
      status = age > STALE_MS ? 'stale' : 'running';
    }

    return json(200, {
      runId: row.id,
      status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      triggerSource: row.triggerSource,
      createdInvoicesCount: row.createdInvoicesCount,
      sentInvoicesCount: row.sentInvoicesCount,
      errors: errorsArray,
      notes: row.notes,
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
