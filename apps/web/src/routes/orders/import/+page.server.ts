// Order import page. Two deliberate, billing-free actions:
//   syncNow   — incremental sync (refreshes the cache; new orders land disabled)
//   importOne — pull a single order by id, optionally activating it immediately
// Neither creates or sends invoices. CF-Access protects the page at the edge.

import { fail } from '@sveltejs/kit';
import { desc } from 'drizzle-orm';
import type { PageServerLoad, Actions } from './$types.ts';
import { getDb, recurringOrders, getSetting } from '@bexio-bot/db';
import { getValidAccessToken } from '@bexio-bot/bexio-client';
import { syncRecurringOrders, importOrderById, type ImportOrderResult } from '@bexio-bot/worker/sync';

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

function importErrorText(result: ImportOrderResult): string {
  switch (result.kind) {
    case 'not_found':
      return `Auftrag #${result.bexioOrderId} in bexio nicht gefunden.`;
    case 'not_recurring':
      return `Auftrag #${result.bexioOrderId} (${result.customerName}) ist kein Recurring-Auftrag — nur wiederkehrende Aufträge werden importiert.`;
    default:
      return `Import fehlgeschlagen: ${'message' in result ? result.message : 'unbekannt'}`;
  }
}

export const load: PageServerLoad = async () => {
  const db = getDb();
  const [orders, lastSync, autoEnable] = await Promise.all([
    db.select().from(recurringOrders).orderBy(desc(recurringOrders.syncedAt)),
    getSetting(db, 'last_incremental_sync_at'),
    getSetting(db, 'import_auto_enable'),
  ]);
  return { orders, lastSync: lastSync ?? null, importAutoEnable: autoEnable === 'true' };
};

export const actions: Actions = {
  syncNow: async () => {
    const db = getDb();
    try {
      const token = await getValidAccessToken(db);
      const result = await syncRecurringOrders(db, token, { mode: 'incremental' });
      return { action: 'syncNow', success: true, result };
    } catch (err) {
      return fail(500, { action: 'syncNow', error: msg(err) });
    }
  },

  importOne: async ({ request }) => {
    const db = getDb();
    const data = await request.formData();
    const orderId = Number(String(data.get('orderId') ?? '').trim());
    const enable = data.get('enable') === 'true' || data.get('enable') === 'on';

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return fail(400, { action: 'importOne', error: 'Bitte eine gültige Auftrags-ID (> 0) eingeben.' });
    }

    try {
      const token = await getValidAccessToken(db);
      const result = await importOrderById(db, token, orderId, { enable });
      if (result.kind === 'imported') {
        return { action: 'importOne', success: true, result };
      }
      const status = result.kind === 'not_found' ? 404 : result.kind === 'not_recurring' ? 422 : 500;
      return fail(status, { action: 'importOne', error: importErrorText(result) });
    } catch (err) {
      return fail(500, { action: 'importOne', error: msg(err) });
    }
  },
};
