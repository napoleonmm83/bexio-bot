import { expect, test } from 'bun:test';
import { isAllowedBexioPath } from './bexio-path.ts';

test('allows versioned bexio API paths', () => {
  for (const p of ['/2.0/kb_invoice', '/3.0/accounting/journal', '/2.0/contact/123', '/4.0/purchase/bills']) {
    expect(isAllowedBexioPath(p)).toBe(true);
  }
});

test('rejects traversal, foreign hosts, unversioned and odd paths', () => {
  for (const p of [
    '/2.0/../auth', '/2.0/a/../../x', 'https://evil.example/2.0/x', '//evil.example/2.0', '/auth',
    '/kb_invoice', '/5.0/x', '/2.0/', '/2.0//x', '/2.0/x?y=1', '/2.0/x#y', '2.0/kb_invoice',
  ]) {
    expect(isAllowedBexioPath(p)).toBe(false);
  }
});
