# bexio-bot pipeline audit (2026-07-02) — fix plan

Adversarial audit after the 2026-07 billing fixes (crash-recovery + N-2 removal, commit e2cf0aa).
6 finder dimensions → per-finding adversarial verify. 11 CONFIRMED (2 duplicates → **10 distinct**).
Raw evidence: workflow `wf_2571c732-87a`. Each fix is TDD; per phase: commit + deploy BOTH Coolify apps
([[project_dual_app_deploy]]); typecheck (my files) clean.

## Phase 1 — P1

### A1. retryIssuedRows: bump `attempts` before send, not at batch-claim
`apps/worker/src/lib/state-machine.ts` (retryIssuedRows). The batch claim UPDATE sets
`attempts = attempts+1` for all rows at once, then sends sequentially. A crash mid-loop leaves
un-sent rows at `status='sending', attempts>0` → next run's `classifyStuckSendingRow` returns
`assumed-sent` → marked 'sent', never emailed (silent non-delivery). Reintroduces the BUG-2 class
417e47c fixed in processOrder. **Fix:** drop `attempts+1` from the claim UPDATE (keep
`status='sending'`+lock+`WHERE attempts<MAX` for the atomic claim/concurrency), bump `attempts`
with a per-row UPDATE immediately before `sendInvoice` (mirror processOrder). Catch's terminal
check becomes `(row.attempts+1) >= MAX_ATTEMPTS` (RETURNING now carries pre-send value).
**Test:** pure helper already exists (classifyStuckSendingRow). Add a focused test that a crash
before send leaves attempts=0 → 'retry' not 'assumed-sent'. (integration-style via the processOrder
test harness / or assert the claim UPDATE no longer sets attempts.)

### A2. /callback: authorize the connecting bexio org
`apps/web/src/routes/callback/+server.ts`. state+PKCE only defend CSRF, not *which* org connects;
an attacker can drive their own bexio OAuth to the public /callback and clobber the shared
`secrets` tokens → bot binds to a foreign org, real customers silently unbilled. **Fix:** after
`exchangeCode`, fetch the connecting org id (e.g. `/2.0/company_profile` or `/3.0/users/me`) and
`error(403)` unless it matches `BEXIO_ALLOWED_COMPANY_ID` (new env). Also drop `/auth/bexio` from
PUBLIC_PREFIXES is NOT sufficient alone (cookies are attacker-set) — the org check in /callback is
load-bearing. **Test:** unit — a company id not on the allowlist → reject; matching → bind.
**Pre-req:** set `BEXIO_ALLOWED_COMPANY_ID` env on the web app (get the real company id first;
fail-open ONLY if env unset, to avoid locking out re-auth — decide during impl).

### A3. runDaily: guard stages 2–6 so a throw can't silently kill the run
`apps/worker/src/lib/run.ts`. Stages 2–6 are unguarded; a throw (revoked token, DB/bexio blip)
skips the bot_runs close + notifyAll → open row, no errorsJsonb, no Discord, multi-day silent
outage (cron path lacks the trigger-run `.catch`). **Fix:** wrap stages after runId is set in
try/catch: on throw push a `runDaily` error, close the row with errorsJsonb, `notifyAll` a failure
report (load settings early / fall back to env webhook), then rethrow (keep exitCode=1). **Test:**
inject a throwing stage → assert row closed + notify called + rethrow.

## Phase 2 — P2

### B1. Alert on stale `created` drafts (auto_send on)
`apps/worker/src/lib/state-machine.ts` + `run.ts`. A crash between the `created` write and
`issuing` leaves a draft no stage recovers, read as `skipped_duplicate` next run → silent miss.
**Fix (alert only, NOT auto-send — preserves the OFF→ON no-mail invariant):** thread `autoSend`
into `reconcileStuckPreSendRows`, additionally SELECT `status='created' AND updatedAt<cutoff AND
invoiceId IS NOT NULL`; when `autoSend` is currently on, push a `crash-recovery` run error naming
the order/invoice. **Test:** classify/scan returns the stale-created row; run.ts surfaces it.

### B2. pickStatus must factor errors[]
`packages/notify/src/discord.ts`. Green "Lauf erfolgreich" headline when `errors[]` is non-empty
but any order sent (thrown processOrder + reclaim errors land in errors[] only). **Fix:** in
pickStatus, `hasErrors && sent>0 → 'partial'`, `hasErrors → 'failed'`. **Test:** pure — errors +
one sent → 'partial'.

### B3. Order-path create idempotency — REASSESSED (audit overstated as double-bill)
`state-machine.ts`. On my own verification the audit's "double-bill + double-email" is WRONG: a
transient create error (lost response / 20s timeout) routes to `deleteClaim` → `failed` at the
catch-all (`if (!invoice)`), which NEVER reaches issue/send. So a bexio-committed order-path
invoice (#100) stays an **un-issued/un-sent orphan draft**; the next run's snapshot creates+sends
#101. The customer is emailed ONCE (#101); #100 is a stray draft. Real impact = a rare orphan
draft, already surfaced as a `failed` anomaly — P3 cleanup, not a P2 double-bill.
**Decision:** do NOT implement the proposed contact+date search-and-adopt — it fixes a non-problem
and a content match could adopt an unrelated invoice and send the WRONG one. **Fix applied:** append
a cleanup hint to the transient `failed` reason so the possible stray draft is actionable. No test
(message-only change).

## Phase 3 — P3

### C1. Weekly period key → occurrence-anchored day granularity
`apps/worker/src/lib/billing-period.ts`. Multi-weekday weekly (Mon+Thu) collides on the ISO-week
key → second occurrence deduped away (under-bill). **Fix:** weekly returns `YYYY-MM-DD` like daily.
⚠️ **GATE:** key-format change — re-bills existing weekly rows if any exist. **Verify prod
`invoice_runs` has zero weekly rows (and no active weekly orders) BEFORE applying.** **Test:** Mon
and Thu same week → different keys; single-weekday still one key per occurrence.

**Migration & rollback (CR #1).** The change is on branch `fix/audit-c1-weekly-key`, NOT on main.
Deploy order:
1. **Pre-check (blocking):** `SELECT count(*) FROM invoice_runs WHERE billing_period LIKE '%-W%'`
   and `SELECT count(*) FROM recurring_orders WHERE interval='weekly'` — BOTH must be `0`.
2. **If both 0** (expected — prod is daily/monthly only): merge → deploy BOTH apps. No data
   migration needed; no old-format key exists to strand. Rollback = `git revert` + redeploy; safe
   because no `YYYY-MM-DD` weekly row will have been written unless a weekly order was billed
   post-deploy (and then a revert would re-collide only that order — still no double-send, just the
   original under-bill behaviour).
3. **If either is non-zero** (unexpected): do NOT ship this as-is — a leftover `YYYY-Www` row would
   be re-billed. Options: (a) one-off SQL migration rewriting existing `YYYY-Www` keys to the
   occurrence day BEFORE deploy, or (b) a dual-read guard (accept either key format for one release)
   then drop the ISO-week reader once no `-W` rows remain. Given no weekly usage is expected, (a)/(b)
   are documented fallbacks, not built.

### C2. Re-surface a `failed` row instead of silent `skipped_duplicate`
`apps/worker/src/lib/state-machine.ts` (duplicate branch). A `failed` row with invoiceId reads as
`skipped_duplicate` on later runs → alerts once then silent. **Fix:** in the duplicate branch, if
`existingRow.status==='failed'` return `not_due + wasDue` so collectBillingAnomalies keeps flagging.
**Test:** existing failed row → not_due+wasDue; sent row → skipped_duplicate (unchanged).

### C3. importOrderById: coerce total
`apps/worker/src/lib/sync.ts`. importOrderById passes `order.total` raw into a NOT NULL column →
crash on null total (sync path uses `coerceExpectedAmount`; import wasn't updated). **Fix:** use
`coerceExpectedAmount(order.total)` at both import sites. **Test:** covered by existing coerce test;
add import-path assertion if cheap.

### C4. Persist notify delivery failure
`apps/worker/src/lib/run.ts`. `notifyResults` (ok:false on webhook failure) is never written to
bot_runs → failed run + failed webhook = no ping, no DB trace. **Fix:** if all notifyResults failed,
push a `notify` error and re-persist errorsJsonb. **Test:** thin (reuse errorsJsonb channel).

## Out of scope / deferred
- Auto-recovering a crash-created `created` draft (vs. alerting) — can't distinguish from a parked
  draft; B1 alerts instead.
- Removing `/auth/bexio` from PUBLIC_PREFIXES + CF-edge policy change — the /callback org check
  (A2) is the load-bearing fix; edge policy needs CF API access (deferred, note to Marcus).
