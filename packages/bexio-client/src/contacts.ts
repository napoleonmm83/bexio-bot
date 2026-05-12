// contact endpoints. Used to resolve a recurring order's contact_id into a display name.
// Bexio orders don't carry the contact name inline — we look it up.

import { callBexio } from './http.ts';
import type { BexioContact } from './types.ts';

export async function getContact(accessToken: string, contactId: number): Promise<BexioContact> {
  return callBexio<BexioContact>(`/contact/${contactId}`, { accessToken });
}

const CONTACTS_PAGE_LIMIT = 200;

/**
 * List all contacts. Pages until exhausted. Used by the dashboard contact-picker.
 * Marcus is expected to have <50 contacts so a single page usually suffices.
 */
export async function listContacts(accessToken: string): Promise<BexioContact[]> {
  const all: BexioContact[] = [];
  let offset = 0;

  while (true) {
    const page = await callBexio<BexioContact[]>('/contact', {
      accessToken,
      query: { limit: CONTACTS_PAGE_LIMIT, offset },
    });
    all.push(...page);
    if (page.length < CONTACTS_PAGE_LIMIT) break;
    offset += CONTACTS_PAGE_LIMIT;
    if (offset > 5000) throw new Error('listContacts: >5000 contacts, refusing to page further');
  }

  return all;
}
