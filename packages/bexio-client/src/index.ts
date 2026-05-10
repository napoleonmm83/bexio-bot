// bexio API client. Phase 1: kb_order list, kb_invoice CRUD, OAuth refresh.
// Pinned API version: 2.0. Monthly drift smoke-test in Phase 1 (see plan doc).

export const BEXIO_API_BASE = 'https://api.bexio.com/2.0' as const;
export const BEXIO_AUTH_BASE = 'https://auth.bexio.com/realms/bexio/protocol/openid-connect' as const;

// Phase 1 placeholders. Real implementation lands in step 7 of Phase 1.
export async function refreshAccessToken(_refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  throw new Error('not implemented yet — Phase 1 step 7');
}

export async function listRecurringOrders(_accessToken: string): Promise<unknown[]> {
  throw new Error('not implemented yet — Phase 1 step 7');
}
