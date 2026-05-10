// contact endpoints. Used to resolve a recurring order's contact_id into a display name.
// Bexio orders don't carry the contact name inline — we look it up.

import { callBexio } from './http.ts';
import type { BexioContact } from './types.ts';

export async function getContact(accessToken: string, contactId: number): Promise<BexioContact> {
  return callBexio<BexioContact>(`/contact/${contactId}`, { accessToken });
}
