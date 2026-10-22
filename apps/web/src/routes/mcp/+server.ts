// /mcp — MCP endpoint (Streamable HTTP, stateless) for the TV-Rheintal billing tools.
//
// Auth: NOT a public route. hooks.server.ts (makeAuthHandle) verifies the
// Cloudflare Access JWT before this handler runs; claude.ai obtains that JWT via
// Access "Managed OAuth" on the bexio-bot Access app. The verified identity is
// on locals.cfAccess and is recorded as caller in tvr_tool_calls.
//
// All business logic lives in @bexio-bot/worker/tvr — this file only maps tools.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { RequestHandler } from './$types.ts';
import { getDb } from '@bexio-bot/db';
import { tvrAdd, tvrRemovePosition, tvrSend, tvrStatus } from '@bexio-bot/worker/tvr';
import type { CfAccessIdentity } from '$lib/server/cf-access.ts';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe('Fertigstellungsdatum des Beitrags (YYYY-MM-DD, Europe/Zurich). Standard: heute.');

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (err) {
    return { ...json({ error: err instanceof Error ? err.message : String(err) }), isError: true };
  }
}

function buildServer(caller: string | undefined) {
  const db = getDb();
  const server = new McpServer({ name: 'bexio-bot-tvr', version: '1.0.0' });

  server.registerTool(
    'tvr_billing_status',
    {
      title: 'TV-Rheintal: Rechnungsstand',
      description:
        'Zeigt die TV-Rheintal-Rechnung des Abrechnungsmonats (Positionen, Total, send_due). Nur lesend.',
      inputSchema: { completion_date: isoDate },
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => tvrStatus(db, args, caller)),
  );

  server.registerTool(
    'tvr_add_beitrag',
    {
      title: 'TV-Rheintal: Beitrag verrechnen',
      description:
        'Fügt einen fertigen Beitrag (330 CHF) der richtigen TV-Rheintal-Rechnung hinzu oder legt sie an. ' +
        'Idempotent innerhalb der letzten 2 Monate: gleicher Titel → status "already_exists". ' +
        'completion_date höchstens 3 Monate zurück, nicht in der Zukunft. Versendet NICHT.',
      inputSchema: {
        title: z.string().min(1).max(200).describe('Kurztitel des Beitrags, z. B. «Kuhrennen»'),
        completion_date: isoDate,
        dry_run: z.boolean().optional().default(false).describe('true = nur zeigen, was passieren würde'),
      },
      annotations: { idempotentHint: true, destructiveHint: false },
    },
    (args) => run(() => tvrAdd(db, args, caller)),
  );

  server.registerTool(
    'tvr_send_invoice',
    {
      title: 'TV-Rheintal: Rechnung versenden',
      description:
        'Stellt eine TV-Rheintal-Entwurfsrechnung aus und versendet sie per bexio-Mail. NICHT umkehrbar. ' +
        'Nur nach ausdrücklicher Freigabe durch Marcus aufrufen; confirm muss true sein.',
      inputSchema: {
        invoice_id: z.number().int().positive(),
        confirm: z.literal(true),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    (args) => run(() => tvrSend(db, args, caller)),
  );

  server.registerTool(
    'tvr_remove_position',
    {
      title: 'TV-Rheintal: Position entfernen',
      description: 'Entfernt eine Position aus einer TV-Rheintal-Rechnung im Entwurfsstatus (Korrektur).',
      inputSchema: {
        invoice_id: z.number().int().positive(),
        position_id: z.number().int().positive(),
      },
      annotations: { destructiveHint: true },
    },
    (args) => run(() => tvrRemovePosition(db, args, caller)),
  );

  return server;
}

const handle: RequestHandler = async ({ request, locals }) => {
  const identity = (locals as { cfAccess?: CfAccessIdentity }).cfAccess;
  // Stateless: a fresh server + transport per request (no session state to leak or collide).
  const server = buildServer(identity?.email ?? identity?.subject);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
};

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
