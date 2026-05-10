// Probe /kb_order/{id}/repetition for every recurring order — confirm the type/interval shape.

import { getDb, closeDb } from '@bexio-bot/db';
import { getValidAccessToken, listRecurringOrders, BexioApiError } from '@bexio-bot/bexio-client';

const db = getDb();

try {
  const token = await getValidAccessToken(db);
  const orders = await listRecurringOrders(token);

  console.log('Repetition config per order:');
  console.log('');
  for (const o of orders) {
    const res = await fetch(`https://api.bexio.com/2.0/kb_order/${o.id}/repetition`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      console.log(`  ${o.document_nr.padEnd(10)} status=${res.status}  (no repetition config)`);
      continue;
    }
    const body = (await res.json()) as {
      start?: string;
      end?: string | null;
      repetition?: { type: string; interval: number; schedule?: string } | null;
    };
    const r = body.repetition;
    if (!r) {
      console.log(`  ${o.document_nr.padEnd(10)} (no repetition object)`);
      continue;
    }
    console.log(
      `  ${o.document_nr.padEnd(10)} type=${r.type.padEnd(10)} interval=${r.interval}  schedule=${r.schedule ?? '-'}  start=${body.start ?? '-'}`,
    );
  }
} catch (err) {
  if (err instanceof BexioApiError) {
    console.error(`FAIL — BexioApiError ${err.status} (${err.errorClass}):`, err.body.slice(0, 300));
  } else {
    console.error('FAIL —', err instanceof Error ? err.message : String(err));
  }
  process.exitCode = 1;
} finally {
  await closeDb();
}
