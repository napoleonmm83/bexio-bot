# Crash recovery for stale pre-send invoice_runs states

**Date:** 2026-07-02
**Status:** approved (direction), decisions taken as recommended (user stepped away mid-clarification)
**Area:** `apps/worker` — invoice state machine crash recovery

## Problem

The `invoice_runs` state machine is:

```
creating → created → issuing → issued → sending → sent (terminal)
   ↓          ↓         ↓          all errors → failed (terminal)
```

Crash recovery today reconciles only two states:

- `reconcileInFlightSends` → stale **`sending`** rows (staleness via `lock_acquired_at`).
- `retryIssuedRows` → **`issued`** rows.

If the worker process dies mid-pipeline (deploy during a run, OOM, a bexio call
hanging past the container task timeout), a row can be parked in **`creating`**,
**`created`**, or **`issuing`** — none of which any recovery stage touches. Two
distinct failure modes result:

| Stale state | `invoice_id` | Next run's behaviour | Severity |
|---|---|---|---|
| `creating` | `null` (invariant — only set at the `created` transition) | `processOrder` re-claims the same `(order, period)` → `onConflictDoNothing` returns no row → `interpretClaimResult` sees `invoice_id = null` → **`concurrent-in-flight`** → `not_due` **without `wasDue`**. `collectBillingAnomalies` does **not** flag it. The order **never bills that period, silently, forever.** | **HARD wedge** |
| `created` / `issuing` | set | Re-claim conflict → `invoice_id ≠ null` → **`skipped_duplicate`**. The invoice exists in bexio as an un-sent draft and is **never issued/sent**. | Orphan (medium) |

`created` with `auto_send = off` is the **intentional** resting state
(`created_unsent`) and must NOT be reconciled.

## Approach (chosen: A)

A single new pre-send reconciler that routes stale pre-send rows back into the
**existing** send lanes rather than re-implementing send logic.

- **`creating` (invoice_id null)** → `deleteClaim`. The next `processOrder` in
  the same run re-bills the period cleanly. In the rare case bexio *did* create a
  draft via the order path before the crash (no `api_reference` on that path, so
  it can't be looked up), the re-run's `POST /kb_order/{id}/invoice` returns 422
  order-exhausted → snapshot fallback creates a fresh invoice. The orphaned draft
  stays un-issued/un-sent in bexio (**no double-send possible**) and is
  `console.warn`-logged + counted for manual cleanup.
- **`issuing` (invoice_id set)** → `issueInvoice` (tolerant of an "already
  issued" error, mirroring the `reusedUnsent` path) → set status `issued`. The
  existing `retryIssuedRows`, which runs immediately after, sends it — inheriting
  its BUG-3 already-sent guard, attempt limit, and email lookup. `issuing` is
  reached only past the `auto_send` gate, and once an invoice is
  festgeschrieben it must complete to sent regardless of the current `auto_send`
  setting (consistent with `retryIssuedRows` not checking `auto_send`).
- **`created` (invoice_id set)** → **leave, always.** `created` is a *reversible*
  draft and, per `processOrder`, the stable resting state that is deliberately
  never auto-sent later. Auto-sending it on recovery would let an `auto_send`
  OFF→ON flip festschreiben + mail every parked draft (adversarial finding,
  2026-07-02). A rare crash-created `created` draft is left for manual handling;
  it never wedges (an invoice_id-set row is read as `duplicate` by
  `interpretClaimResult`). Recovery therefore has no `auto_send` dependency, and
  the scan is narrowed to `('creating','issuing')` — matching the
  `idx_invoice_runs_status_lock` partial index.

**Staleness signal:** `updated_at < now() - LOCK_STALE_MS` (5 min). `creating`/
`created`/`issuing` never set `lock_acquired_at`, and `updated_at` is written on
the claim insert (`defaultNow()`) and every transition. The 5-min cutoff
guarantees the current run's own in-progress rows (seconds old) are never
touched; the advisory-lock + `isAnotherRunInFlight` guard already prevents a
genuinely concurrent run, so a stale pre-send row is always a crashed prior run.

### Rejected alternatives

- **B — alert-only / `markFailed`:** insufficient. `interpretClaimResult` keys
  on `invoice_id`, so a `failed` row with `invoice_id = null` still reads as
  `concurrent-in-flight` — `markFailed` would not even un-wedge `creating`.
- **C — fold into `reconcileInFlightSends`:** mixes two staleness signals
  (`lock_acquired_at` vs `updated_at`) in one function; worse to test. The
  existing code favours one small function per concern.

## Contracts

Pure decision function (unit-tested, mirrors `classifyStuckSendingRow`):

```ts
export function classifyStuckPreSendRow(input: {
  status: string;
  invoiceId: number | null;
}): 'reclaim' | 'resume' | 'leave';
```

- `creating` + `invoiceId == null` → `reclaim`
- `issuing` + `invoiceId != null` → `resume`
- anything else (`created`, or impossible-in-practice combinations) → `leave`
  (defensive; no destructive action, no auto-send of a reversible draft)

Reconciler (side-effect loop, mirrors `reconcileInFlightSends`):

```ts
export async function reconcileStuckPreSendRows(
  db, accessToken, dryRun = false,
): Promise<{ reclaimed: number; resumed: number; leftDraft: number }>;
```

- `dryRun` → returns all-zero without DB access (BUG-1 parity; guarded by the
  existing dry-run proxy test).
- `resume`: call `issueInvoice`, then transition to `issued`.
  - `issueInvoice` succeeds → `issued`.
  - throws a `BexioApiError` → assume already festgeschrieben (mirror
    `processOrder`'s `reusedUnsent` path), `console.warn`, still transition to
    `issued`. If it truly was not issued, the send lane self-corrects: an
    un-issued invoice fails `sendInvoice`, `retryIssuedRows` rolls it back and
    eventually `markFailed`s at the attempt limit — no wedge, no double-send.
  - throws a non-`BexioApiError` (network/unexpected) → leave the row untouched
    so the next run's reconciler retries (consistent with EDGE-4 transient
    handling in `reconcileInFlightSends`).
- Returns counts for the run summary; `reclaimed` (orphan-draft risk) is also
  `console.warn`-logged.

## Wiring (`run.ts`)

Insert between the two existing recovery calls, before `retryIssuedRows` (which
consumes the `issued` rows this stage produces):

```ts
const reconcile   = await reconcileInFlightSends(db, accessToken, options.dryRun);
const preSend     = await reconcileStuckPreSendRows(db, accessToken, options.dryRun);
const retriedFromIssued = await retryIssuedRows(db, accessToken, settings, options.dryRun);
```

Add `reconciledReclaimed` (stale claims deleted; orphan-draft risk) and
`reconciledResumed` (stuck rows re-issued into the send lane) to `RunSummary`
(reset in `buildSkippedSummary`, assigned at close) and print them in `cli.ts`
alongside the other crash-recovery counters — `reconciledReclaimed` with a ⚠
"check bexio for orphan draft" note. The reconciler also returns a `leftDraft`
count (benign intentional/leave rows), not surfaced in the summary. Discord does
not surface the sibling reconcile counters, so it is left untouched.

## Testing

- `classifyStuckPreSendRow`: full unit coverage of the six branches above.
- `reconcileStuckPreSendRows`: dry-run test via the existing `guardDb` proxy
  (returns zeros, no DB access) — matches the established convention for the
  side-effecting reconcilers.

## Decisions taken (recommended defaults; user away)

1. **Orphan draft:** accept delete-and-rerun; log + count the stray draft. No
   bexio-side search-and-reuse (speculative complexity for a rare crash).
2. **Scope:** heal the three stale states only. Do **not** expand
   `collectBillingAnomalies` in this change.

## Adversarial verification (5 skeptics + verify pass)

A workflow ran five independent skeptics against the implemented change. Two
findings survived verification:

- **Finding 2 (data-loss, CONFIRMED) — fixed here.** The `reclaim` branch dropped
  a period with only a `console.warn`; for a daily order (the prod canary!) the
  occurrence advances daily, so `processOrder` never back-bills the crashed
  period and `collectBillingAnomalies` saw the fresh period's `sent` → Discord
  reported success. Fix: `run.ts` now pushes a `crash-recovery` run error when
  `preSend.reclaimed > 0`, so a possible dropped period reaches
  `bot_runs.errors_jsonb` + Discord.

- **Finding 1 (double-send, CONFIRMED) — pre-existing, fixed here by decision.**
  Root cause is the N-2 period-key migration in `processOrder`
  (`state-machine.ts`): after creating an invoice it rewrote the
  `(order_id, billing_period)` PK from the occurrence-anchored key to one derived
  from bexio's `invoice.is_valid_from`. For a monthly/yearly **first** invoice
  (order path, no `api_reference`) whose `is_valid_from` bexio set to a later
  period, the key migrated (e.g. `2026-06 → 2026-07`), freeing the occurrence key;
  a later run inside the catch-up window recomputed `2026-06`, found no row, and
  billed the same occurrence again → duplicate invoice + email. This existed
  **without** the crash-recovery change (my `resume` path only added a crash
  variant). Marcus chose to fix the root cause now: the migration is removed and
  the key stays occurrence-anchored (`is_valid_from` is a bexio display detail;
  the schedule-anchored key is authoritative for dedup, and is also the more
  correct label — the migration mislabeled a June occurrence as July). daily/
  weekly were immune (occurrence advances each run); snapshot-path rebills were
  immune (`api_reference` + occurrence-anchored `is_valid_from`). Regression test:
  `state-machine.processorder.test.ts` drives `processOrder` end-to-end (bexio
  client mocked, tiny fake db) and asserts the returned/persisted `billing_period`
  stays occurrence-anchored; it fails if the migration is reintroduced.

The other three modes (wedge, staleness-race, dry-run/issue-tolerance) were
REFUTED with named guards.

## Out of scope

- Recovering a rare crash-created `created` draft (auto_send on, crash between
  the `created` and `issuing` writes). Left as an unsent draft for manual
  handling — auto-sending it would resurrect the OFF→ON footgun and it can't be
  distinguished from an intentionally-parked draft.
- The vestigial `pending` enum value (never written by the code).
