// Company profile — used as the OAuth rebind guard (which org just connected?).

import { callBexio } from './http.ts';

export type BexioCompanyProfile = {
  id: number;
  name: string;
  mail?: string | null;
  mwst_nr?: string | null;
  ust_id_nr?: string | null;
};

/**
 * GET /2.0/company_profile — the connected org's profile. bexio accounts have
 * exactly one; we return the first (or null if the list is unexpectedly empty).
 */
export async function getCompanyProfile(accessToken: string): Promise<BexioCompanyProfile | null> {
  const list = await callBexio<BexioCompanyProfile[]>('/company_profile', { accessToken });
  return list[0] ?? null;
}

/**
 * OAuth rebind guard: is the connected bexio org authorized? `allowed` is one
 * configured identifier (env BEXIO_ALLOWED_COMPANY) — set it to the org's VAT
 * (mwst_nr / ust_id_nr; strongest, unforgeable) or its exact name / mail.
 *
 * Fail-OPEN when `allowed` is empty/unset so re-auth is never locked out before
 * the allowlist is configured; once set, a mismatch (or an org that could not be
 * identified) is rejected. Match is case-insensitive/trimmed against the VAT
 * numbers (mwst_nr / ust_id_nr — strongest, globally unique, recommended), and
 * name / mail as weaker convenience fallbacks. company_profile.id is deliberately
 * NOT a candidate: it is NOT globally unique (every account's profile is id=1), so
 * matching on it would let any org pass. Prefer setting the VAT number.
 */
export function isAllowedBexioCompany(
  profile: BexioCompanyProfile | null,
  allowed: string | undefined | null,
): boolean {
  const want = (allowed ?? '').trim().toLowerCase();
  if (!want) return true; // fail-open: allowlist not configured yet
  if (!profile) return false; // configured, but the org could not be identified
  const candidates = [profile.mwst_nr, profile.ust_id_nr, profile.name, profile.mail]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim().toLowerCase());
  return candidates.includes(want);
}
