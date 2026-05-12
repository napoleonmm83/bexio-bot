// Create-subscription form. Preloads all bexio contacts + articles server-side
// (Marcus has <50 of each so client-side filter is fine).

import { fail, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types.ts';
import { getDb, subscriptions, subscriptionItems } from '@bexio-bot/db';
import { getValidAccessToken, listContacts, listArticles } from '@bexio-bot/bexio-client';

export const load: PageServerLoad = async () => {
  const db = getDb();
  const accessToken = await getValidAccessToken(db);

  const [contacts, articles] = await Promise.all([
    listContacts(accessToken).catch(() => []),
    listArticles(accessToken).catch(() => []),
  ]);

  return {
    contacts: contacts.map((c) => ({
      id: c.id,
      name: c.name_2 ? `${c.name_2} ${c.name_1}`.trim() : c.name_1,
      email: c.mail ?? null,
    })),
    articles: articles.map((a) => ({
      id: a.id,
      code: a.intern_code,
      name: a.intern_name,
      price: a.sale_price ?? '0',
    })),
  };
};

export const actions: Actions = {
  default: async ({ request }) => {
    const form = await request.formData();
    const bexioContactId = Number(form.get('bexio_contact_id'));
    const name = String(form.get('name') ?? '').trim();
    const interval = String(form.get('interval') ?? '');
    const startDateStr = String(form.get('start_date') ?? '');
    const endDateStr = String(form.get('end_date') ?? '');
    const autoSend = form.get('auto_send') === 'on';
    const articleIds = form.getAll('item_article_id').map(Number);
    const qtys = form.getAll('item_qty').map(String);

    if (!Number.isFinite(bexioContactId) || bexioContactId <= 0) return fail(400, { error: 'Kontakt fehlt' });
    if (!name) return fail(400, { error: 'Name fehlt' });
    if (interval !== 'monthly' && interval !== 'yearly') return fail(400, { error: 'Intervall ungültig' });
    if (!startDateStr) return fail(400, { error: 'Startdatum fehlt' });
    if (articleIds.length === 0) return fail(400, { error: 'Mindestens eine Position nötig' });
    if (articleIds.length !== qtys.length) return fail(400, { error: 'Positionen inkonsistent' });
    if (articleIds.some((id) => !Number.isFinite(id) || id <= 0)) return fail(400, { error: 'Ungültige Produkt-ID' });

    const startDate = new Date(startDateStr + 'T00:00:00Z');
    const endDate = endDateStr ? new Date(endDateStr + 'T00:00:00Z') : null;

    const db = getDb();
    const [sub] = await db
      .insert(subscriptions)
      .values({
        bexioContactId,
        name,
        interval: interval as 'monthly' | 'yearly',
        startDate,
        endDate,
        nextBillingDate: startDate,
        status: 'active',
        autoSend,
      })
      .returning();

    if (!sub) return fail(500, { error: 'DB insert failed' });

    await db.insert(subscriptionItems).values(
      articleIds.map((articleId, idx) => ({
        subscriptionId: sub.id,
        bexioArticleId: articleId,
        qty: qtys[idx]!,
        positionOrder: idx,
      })),
    );

    throw redirect(303, `/subscriptions/${sub.id}`);
  },
};
