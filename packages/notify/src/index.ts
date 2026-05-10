// Notification adapters. Phase 1 = Discord only. Phase 2 adds email + Notion.
// Pattern: each adapter exports an async send() that returns Promise<Result>.
// Worker uses Promise.allSettled so a failing channel never blocks the run.

export type NotifyResult =
  | { ok: true; channel: string }
  | { ok: false; channel: string; error: string };

export type RunReport = {
  status: 'success' | 'failed' | 'partial' | 'no-due';
  runId: number;
  startedAt: Date;
  finishedAt: Date;
  createdInvoices: Array<{
    customer: string;
    amount: string;
    bexioInvoiceId: number;
    status: 'sent' | 'failed';
    errorMessage?: string;
  }>;
  newOrdersAvailable?: Array<{ customer: string; interval: string; expectedAmount: string }>;
};

// Phase 1 placeholder. Discord adapter lands in step 8 of Phase 1.
export async function notifyAll(_report: RunReport): Promise<NotifyResult[]> {
  return [];
}
