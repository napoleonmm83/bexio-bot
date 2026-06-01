// POST /api/sync — import bexio orders WITHOUT running a billing cycle.
// Cloudflare-Access protected (same boundary as /api/trigger-run). Two modes:
//   { mode: 'full' | 'incremental' }   → sync the recurring-order cache
//   { orderId: number, enable?: bool } → import exactly one order on demand
//
// This NEVER creates or sends invoices — it only refreshes recurring_orders.
// A separate every-2h Coolify task hits this with mode='incremental' so new
// bexio orders surface within hours instead of waiting for the daily run.

import type { RequestHandler } from './$types.ts';
import { getDb, getSetting } from '@bexio-bot/db';
import { getValidAccessToken } from '@bexio-bot/bexio-client';
import { syncRecurringOrders, importOrderById, type SyncMode } from '@bexio-bot/worker/sync';
import { verifyCfAccess, CfAccessError } from '$lib/server/cf-access.ts';

export const POST: RequestHandler = async ({ request }) => {
  try {
    await verifyCfAccess(request);

    const body: { mode?: SyncMode; orderId?: number; enable?: boolean } =
      await request.json().catch(() => ({}));

    const db = getDb();

    // Single-order import takes precedence when an orderId is supplied.
    if (Number.isInteger(body.orderId) && body.orderId! > 0) {
      const accessToken = await getValidAccessToken(db);
      // Explicit `enable` wins; otherwise fall back to the import_auto_enable setting.
      const enable = typeof body.enable === 'boolean'
        ? body.enable
        : (await getSetting(db, 'import_auto_enable')) === 'true';
      const result = await importOrderById(db, accessToken, body.orderId!, { enable });
      const status = result.kind === 'imported' ? 200
        : result.kind === 'not_found' ? 404
        : result.kind === 'not_recurring' ? 422
        : 500;
      return json(status, result);
    }

    const mode: SyncMode = body.mode === 'full' ? 'full' : 'incremental';
    // The every-2h incremental sync can be switched off via /settings. The daily
    // full scan (safety net + orphan cleanup) always runs regardless.
    if (mode === 'incremental' && (await getSetting(db, 'incremental_sync_enabled', 'true')) === 'false') {
      return json(200, { mode, skipped: true, reason: 'incremental_sync_enabled=false' });
    }
    const accessToken = await getValidAccessToken(db);
    const result = await syncRecurringOrders(db, accessToken, { mode });
    return json(200, { mode, ...result });
  } catch (err) {
    if (err instanceof CfAccessError) {
      const status = err.code === 'server-misconfigured' ? 500 : 401;
      return json(status, { error: err.code, message: err.message });
    }
    return json(500, { error: 'internal', message: err instanceof Error ? err.message : String(err) });
  }
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
