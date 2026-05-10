// Drill down: POST /kb_order/11/invoice exists (returns 415 not 404).
// Find the right body shape.

import { eq } from 'drizzle-orm';
import { getDb, secrets, closeDb } from '@bexio-bot/db';

const db = getDb();

async function getToken(): Promise<string> {
  const rows = await db.select().from(secrets).where(eq(secrets.key, 'bexio_access_token'));
  const token = rows[0]?.value;
  if (!token) throw new Error('No access token');
  return token;
}

const URL = 'https://api.bexio.com/2.0/kb_order/11/invoice';

async function probe(label: string, init: RequestInit): Promise<boolean> {
  console.log(`--- ${label} ---`);
  try {
    const res = await fetch(URL, init);
    console.log(`  status: ${res.status}  body: ${(await res.text()).slice(0, 200)}`);
    if (res.status >= 200 && res.status < 300) {
      console.log('  *** SUCCESS — invoice created ***');
      return true;
    }
  } catch (err) {
    console.log(`  threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  await new Promise((r) => setTimeout(r, 1200));
  return false;
}

try {
  const token = await getToken();
  const auth = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  // V1: POST no body at all (Content-Length might be 0)
  if (await probe('POST no body, no Content-Type', { method: 'POST', headers: auth })) process.exit(0);

  // V2: POST with Content-Length: 0 explicit
  if (await probe('POST Content-Length: 0', {
    method: 'POST', headers: { ...auth, 'Content-Length': '0' },
  })) process.exit(0);

  // V3: POST application/json with null body
  if (await probe('POST {"":""} application/json (non-empty)', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: 'null',
  })) process.exit(0);

  // V4: POST with valid date field (some bexio create-from-source endpoints want is_valid_from)
  if (await probe('POST {is_valid_from: today}', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_valid_from: '2026-05-10' }),
  })) process.exit(0);

  // V5: POST with empty array body (some endpoints want positions[])
  if (await probe('POST []', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: '[]',
  })) process.exit(0);

  // V6: PUT instead of POST
  if (await probe('PUT empty {}', {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: '{}',
  })) process.exit(0);

  // V7: POST with x-www-form-urlencoded empty body
  if (await probe('POST x-www-form-urlencoded empty', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '',
  })) process.exit(0);

  // V8: POST with form-urlencoded id=11 (mimic the bexio web UI)
  if (await probe('POST x-www-form-urlencoded id=11', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'id=11',
  })) process.exit(0);

  console.log('Still no luck. Need to check bexio support docs directly.');
} catch (err) {
  console.error('FAIL —', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await closeDb();
}
