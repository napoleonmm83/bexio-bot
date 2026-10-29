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
  test('lists the five TV-Rheintal tools plus read-only bexio_get; send requires confirm=true', async () => {
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
      'bexio_get',
      'tvr_add_beitrag',
      'tvr_billing_status',
      'tvr_remove_beitrag',
      'tvr_rename_beitrag',
      'tvr_send_invoice',
    ]);
    // Annotations per bug report §5C — no tool addresses a target by an internal id except send.
    const ann = Object.fromEntries(
      (tools as unknown as { name: string; annotations: Record<string, boolean> }[]).map((t) => [t.name, t.annotations]),
    );
    expect(ann.tvr_billing_status).toMatchObject({ readOnlyHint: true });
    expect(ann.bexio_get).toMatchObject({ readOnlyHint: true });
    expect(ann.tvr_add_beitrag).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(ann.tvr_rename_beitrag).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(ann.tvr_remove_beitrag).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(ann.tvr_send_invoice).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const remove = tools.find((t) => t.name === 'tvr_remove_beitrag')!;
    expect(Object.keys(remove.inputSchema.properties).sort()).toEqual(['dry_run', 'title']);
    const send = tools.find((t) => t.name === 'tvr_send_invoice')!;
    // Addressed by the number the user sees on the invoice, never by an internal id.
    expect(send.inputSchema.required?.sort()).toEqual(['confirm', 'invoice_nr']);
    expect(send.inputSchema.properties.invoice_nr).toMatchObject({ type: 'string' });
    expect(send.inputSchema.properties.confirm).toMatchObject({ const: true });
  });

  test('send with confirm=false is rejected by schema validation (before any handler code runs)', async () => {
    delete process.env.TVR_CONTACT_ID; // a handler run would fail differently ("TVR_CONTACT_ID missing")
    const res = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'tvr_send_invoice', arguments: { invoice_nr: 'RE-00284', confirm: false } },
    });
    const text = JSON.stringify(res.json);
    expect(text).toContain('confirm');
    expect(text).toMatch(/invalid|expected/i);
    expect(text).not.toContain('TVR_CONTACT_ID');
  });

  test('send rejects a malformed invoice number by schema (no bexio call)', async () => {
    delete process.env.TVR_CONTACT_ID;
    const res = await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'tvr_send_invoice', arguments: { invoice_nr: '284', confirm: true } },
    });
    const text = JSON.stringify(res.json);
    expect(text).toContain('invoice_nr');
    expect(text).not.toContain('TVR_CONTACT_ID');
  });
});
