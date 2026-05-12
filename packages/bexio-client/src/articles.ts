// /article endpoints. Used by the subscription layer to build invoice positions
// from a product catalog, and to pull live prices at billing time (no drift).

import { callBexio } from './http.ts';
import type { BexioArticle } from './types.ts';

const PAGE_LIMIT = 200;

/**
 * List all articles. Pages until exhausted. Used by the dashboard product-picker
 * when creating a subscription.
 */
export async function listArticles(accessToken: string): Promise<BexioArticle[]> {
  const all: BexioArticle[] = [];
  let offset = 0;

  while (true) {
    const page = await callBexio<BexioArticle[]>('/article', {
      accessToken,
      query: { limit: PAGE_LIMIT, offset },
    });
    all.push(...page);
    if (page.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
    if (offset > 5000) throw new Error('listArticles: >5000 articles, refusing to page further');
  }

  return all;
}

/**
 * Get a single article. Called at billing time to get the current sale_price + tax_id
 * — pulling live ensures the invoice reflects any price change since the subscription
 * was set up.
 */
export async function getArticle(accessToken: string, articleId: number): Promise<BexioArticle> {
  return callBexio<BexioArticle>(`/article/${articleId}`, { accessToken });
}
