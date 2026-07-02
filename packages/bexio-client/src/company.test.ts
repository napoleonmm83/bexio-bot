import { describe, expect, test } from 'bun:test';
import { isAllowedBexioCompany, type BexioCompanyProfile } from './company.ts';

const profile = (over: Partial<BexioCompanyProfile> = {}): BexioCompanyProfile => ({
  id: 1,
  name: 'Martini Digital',
  mail: 'info@martini.digital',
  mwst_nr: 'CHE-123.456.789 MWST',
  ust_id_nr: null,
  ...over,
});

describe('isAllowedBexioCompany — OAuth rebind guard', () => {
  test('unset/empty allowlist → fail-OPEN (never lock out re-auth before it is configured)', () => {
    expect(isAllowedBexioCompany(profile(), undefined)).toBe(true);
    expect(isAllowedBexioCompany(profile(), '')).toBe(true);
    expect(isAllowedBexioCompany(profile(), '   ')).toBe(true);
    expect(isAllowedBexioCompany(null, undefined)).toBe(true);
  });

  test('configured + matches VAT (case/space-insensitive) → allowed', () => {
    expect(isAllowedBexioCompany(profile(), 'CHE-123.456.789 MWST')).toBe(true);
    expect(isAllowedBexioCompany(profile(), '  che-123.456.789 mwst ')).toBe(true);
  });

  test('configured + matches name or mail → allowed', () => {
    expect(isAllowedBexioCompany(profile(), 'martini digital')).toBe(true);
    expect(isAllowedBexioCompany(profile(), 'info@martini.digital')).toBe(true);
  });

  test('configured + no match → rejected (attacker org)', () => {
    expect(isAllowedBexioCompany(profile({ name: 'Attacker AG', mail: 'x@evil.com', mwst_nr: 'CHE-999.999.999 MWST' }), 'martini digital')).toBe(false);
  });

  test('configured but org could not be identified (null profile) → rejected (fail-closed)', () => {
    expect(isAllowedBexioCompany(null, 'martini digital')).toBe(false);
  });

  test('does not match on empty/blank profile fields', () => {
    // allowlist set to empty-ish must not accidentally match a blank field
    expect(isAllowedBexioCompany(profile({ mwst_nr: '', ust_id_nr: '' }), 'CHE-000')).toBe(false);
  });
});
