import { describe, expect, test } from 'bun:test';

// getDb() is lazy about connecting — a dummy URL lets the server build without a DB.
process.env.DATABASE_URL ??= 'postgres://u:p@127.0.0.1:1/none';
const { POST } = await import('./+server.ts');

const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

async function rpc(body: unknown) {
  const request = new Request('https://bot.test/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await POST({ request, locals: { cfAccess: { subject: 't', sub: 't', email: 't@x' } } } as any);
  return { status: res.status, json: await res.json() };
}

describe('/mcp', () => {
  test('lists exactly the four TV-Rheintal tools; send requires confirm=true', async () => {
    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    expect(init.status).toBe(200);

    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(list.status).toBe(200);
    const tools = list.json.result.tools as { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      'tvr_add_beitrag',
      'tvr_billing_status',
      'tvr_remove_position',
      'tvr_send_invoice',
    ]);
    const send = tools.find((t) => t.name === 'tvr_send_invoice')!;
    expect(send.inputSchema.required?.sort()).toEqual(['confirm', 'invoice_id']);
    expect(send.inputSchema.properties.confirm).toMatchObject({ const: true });
  });

  test('send with confirm=false is rejected by schema validation (before any handler code runs)', async () => {
    delete process.env.TVR_CONTACT_ID; // a handler run would fail differently ("TVR_CONTACT_ID missing")
    const res = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'tvr_send_invoice', arguments: { invoice_id: 284, confirm: false } },
    });
    const text = JSON.stringify(res.json);
    expect(text).toContain('confirm');
    expect(text).toMatch(/invalid|expected/i);
    expect(text).not.toContain('TVR_CONTACT_ID');
  });
});
