// Subscription creation is RETIRED (2026-06-01). The bot-native subscription
// layer is deprecated in favour of bexio orders (see /orders/import), which cover
// every billing cycle. This route now only renders a notice — it no longer
// preloads bexio contacts/articles and cannot create subscriptions.

import type { PageServerLoad } from './$types.ts';

export const load: PageServerLoad = async () => {
  return {};
};
