# Bexio-Bot — Audit-Fixplan: Bugs, Sicherheitslücken & Edge Cases

> **Datum:** 2026-06-10 · **Branch:** main · **Methode:** Multi-Agent-Audit (10 parallele Finder
> nach Subsystem → adversariale Verifikation jedes Fundes → Completeness-Critic) mit anschliessender
> manueller Synthese. Roh-Evidenz (alle verifizierten Findings inkl. Verify-Begründung):
> `docs/superpowers/plans/_audit-confirmed-findings.json`.

**Hinweis zum Lauf:** Der Synthese-Schritt des Workflows blieb hängen (ein einzelner schema-gebundener
Agent geriet beim Erzeugen des grossen Structured-Output in eine Endlosschleife). Die teure Arbeit —
Finden **und** adversariales Verifizieren — war zu diesem Zeitpunkt vollständig abgeschlossen; die
29 bestätigten Findings wurden aus dem Lauf gerettet und hier von Hand konsolidiert.

**Scope:** Nur Code, der nach dem letzten 21-Bug-Audit (Commits `936c384`…`cc5c3ac`, F-1…F-12 / N-1…N-11,
alle gemerged) noch fehlerhaft oder *neu* riskant ist. Die bereits gefixten Punkte wurden den Findern
explizit bekanntgegeben und nur dann gemeldet, wenn eine **neue Lücke im Fix** gefunden wurde.

**Severity-Kalibrierung (Produktions-Billing-Bot, sendet echte Rechnungen):**
P0 = Geldverlust / Doppel- oder Fehl-Rechnung / falscher Empfänger / Secret-Leak / Auth-Bypass auf
geldbewegendem Endpoint. P1 = stiller Nicht-Versand / blockierter Folge-Billing-Zustand / Cache-Datenverlust /
exploitbar-aber-gated. P2 = falsch-aber-recoverbar / fehlende Validierung. P3 = Härtung / Defense-in-Depth / kleiner Edge-Case.

**Ergebnis:** 29 bestätigte Findings → **21 distinkte** nach Dedup. **1× P0, 5× P1, 5× P2, 10× P3.**

---

## Übersicht

| # | ID | Sev | Kategorie | Datei | Titel |
|---|----|-----|-----------|-------|-------|
| 1 | BUG-1 | **P0** | bug | `worker/lib/run.ts:96-98` | Dry-Run sendet trotzdem echte Rechnungen |
| 2 | SEC-1 | **P1** | security | `web/hooks.server.ts` (+ alle page actions) | Kein Origin-seitiger CF-Access-Check für Seiten & Form-Actions |
| 3 | BUG-2 | **P1** | bug | `worker/lib/state-machine.ts:560-574` | Crash vor `/send` wird als „sent" verbucht → Geld nicht eingezogen |
| 4 | BUG-3 | **P1** | bug | `worker/lib/state-machine.ts:636-644` | `retryIssuedRows` mailt bereits versandte Rechnung erneut |
| 5 | BUG-4 | **P1** | bug | `bexio-client/auth.ts:63-108` | Token-Refresh hält pg-Advisory-Lock + Pool-Connection über ungetimten `fetch` |
| 6 | EDGE-1 | **P1** | edge-case | `worker/lib/sync.ts` + `bexio-client/orders.ts` | Orphan-Cleanup löscht alle Orders jenseits des stillen 5000-Cap |
| 7 | BUG-5 | P2 | bug | `worker/lib/subscriptions.ts:376-395` | `runSubscriptionNow` ohne Fälligkeits-Gate → Vorab-/Doppel-Billing |
| 8 | EDGE-2 | P2 | edge-case | `worker/lib/sync.ts:183-250` | Ein einziger malformer Order bricht den ganzen Sync (+ Daily-Run) ab |
| 9 | EDGE-3 | P2 | edge-case | `bexio-client/invoices.ts:107-144` | Order/Snapshot-Pfad erzeugt still CHF-0-Rechnungspositionen |
| 10 | EDGE-4 | P2 | edge-case | `worker/lib/state-machine.ts:551-594` | Transienter `getInvoice`-Fehler markiert In-Flight-Rechnung dauerhaft `failed` |
| 11 | EDGE-5 | P2 | edge-case | `worker/lib/run.ts:75-87` | Cron-Daily-Run ohne In-Flight-Guard → parallel zum Cowork-Run |
| 12 | BUG-6 | P3 | bug | `bexio-client/http.ts:82-90` | `Retry-After` wird geparst, aber nie aufs Pacing angewandt |
| 13 | BUG-7 | P3 | bug | `worker/lib/state-machine.ts:575-589` | Unerreichbare Branches in `reconcileInFlightSends` (Dead Code) |
| 14 | BUG-8 | P3 | bug | `bexio-client/auth.ts:94-97` | Token-Endpoint-Fehler hart auf `errorClass:'auth'` → 429/500 maskiert |
| 15 | SEC-2 | P3 | security | `bexio-client/auth.ts:94-97` | Token-Refresh-Error-Body (evtl. Token) wandert verbatim in `error_jsonb` |
| 16 | SEC-3 | P3 | security | `web/routes/health/+server.ts:38-43` | `/health` leakt interne DB-Fehlerstrings unauthentifiziert |
| 17 | SEC-4 | P3 | security | `web/routes/settings/+page.server.ts:107-113` | `discord_webhook_url` ohne Host-Allowlist → SSRF |
| 18 | EDGE-6 | P3 | edge-case | `web/routes/+page.server.ts:19-23` | Dashboard-„heute" rechnet Tagesgrenze in UTC statt Europe/Zurich |
| 19 | EDGE-7 | P3 | edge-case | `web/routes/+page.server.ts:19-30` | Loader mit unbegrenzten SELECTs (fehlender `billing_runs`-Index) |
| 20 | EDGE-8 | P3 | edge-case | `worker/lib/run.ts:94,165-200` | `unsupportedOrders` aus dem Sync werden nie sichtbar gemacht |
| 21 | EDGE-9 / EDGE-10 | P3 | edge-case | `worker/lib/subscriptions.ts:76-84` · `settings` | Legitime CHF-0/Gutschrift-Positionen abgelehnt · `order_due_window_days` unbeschränkt |

---

# Phase 1 — Money-Loss & Auth Stop-the-Bleed

**Ziel:** Die zwei Dinge, die *heute* Geld kosten bzw. Kontrolle verlieren lassen.
Jede Phase endet mit `commit → push → BEIDE Coolify-Apps deployen (Worker + Web) → manuell verifizieren`.

### BUG-1 (P0) — Dry-Run sendet trotzdem echte Rechnungen
**Datei:** `apps/worker/src/lib/run.ts:96-98` → `state-machine.ts:606-669` (`retryIssuedRows`), `reconcileInFlightSends`
**Confidence:** 0.95

`runDaily` ruft die beiden Crash-Recovery-Stufen `reconcileInFlightSends` (Z. 97) und `retryIssuedRows`
(Z. 98) **bedingungslos und vor** dem Dry-Run-Gate (Z. 107) auf — ohne `dryRun`-Argument.
`retryIssuedRows` ruft bei jeder Zeile in `status='issued'` `sendInvoice()` (state-machine.ts:639) auf →
echtes PDF-Mail an echten Kunden, danach Transition auf `sent`. Nur die `processOrder`-Schleife (Z. 107)
und `syncRecurringOrders` (Z. 94) respektieren `options.dryRun`.

**Trigger (realistisch, nicht theoretisch):** Jede `invoice_runs`-Zeile in `status='issued'` — genau der
Zustand, in den **F-2 absichtlich zurückrollt**, wenn ein Send fehlschlägt — plus ein Aufruf mit
`dryRun=true` (`WORKER_DRY_RUN=true`, `bun run worker:dry`, oder `POST /api/trigger-run {"dryRun":true}`
via Cowork). Der „sichere Probelauf" mailt dann die geparkte Rechnung.

**Fix:**
1. `dryRun` als Parameter durch `reconcileInFlightSends` und `retryIssuedRows` durchreichen.
2. Bei `dryRun=true`: keinen `sendInvoice`/`issueInvoice`-Aufruf, keine terminale Zustandsmutation —
   nur loggen, was *gesendet würde*.
3. `onlyOrderId` ebenfalls in beide Stufen durchreichen (sonst reprocessiert ein Einzel-Order-Dry-Run
   org-weit alle `issued`-Zeilen).
4. Test: `runDaily({dryRun:true})` mit einer geparkten `issued`-Zeile darf `sendInvoice` **nie** aufrufen
   (Mock-Spy assert 0 calls).

### SEC-1 (P1) — Kein Origin-seitiger CF-Access-Check für Seiten & Form-Actions
**Dateien:** `apps/web/src/hooks.server.ts` (nur `handleError`, **kein** `handle`-Hook), plus alle
`+page.server.ts` load/actions: `/` toggle (`+page.server.ts:50-67`), `/settings`
(`settings/+page.server.ts:92-164`), `/orders/import` (`orders/import/+page.server.ts:36-70`),
`/subscriptions/[id]` `runNow|resume|pause|cancel` (`subscriptions/[id]/+page.server.ts:58-102`),
`/billing-runs` retry (`billing-runs/+page.server.ts:30-41`).
**Confidence:** 0.85-0.90 · *(merge aus 5 deckungsgleichen Findern)*

`verifyCfAccess` wird **nur** in den drei JSON-Endpoints (`/api/trigger-run`, `/api/sync`,
`/api/runs/[id]`) aufgerufen. Es gibt kein globales `handle`-Hook und kein `+layout.server.ts`.
Alle Seiten-Loader (geben sämtliche Kunden-/Order-/Run-Daten aus) **und** alle Form-Actions
(darunter `runNow`/retry, die echte Rechnungen erstellen & versenden; `toggle`, das `enabled` schaltet;
settings, die `auto_send_invoices`/Mail-Template/`order_due_window_days`/Discord-Webhook umschreiben)
laufen Origin-seitig **ungeprüft**. `cf-access.ts:8-11` und `DEPLOYMENT.md:214-220` halten ausdrücklich
fest, dass die Hetzner-Origin-Lock-Firewall noch **aussteht** und „anyone who learns the origin IP can
bypass CF Access by hitting it directly."

**Trigger:** Origin-IP wird bekannt (Shodan / Cert-Transparency / DNS-History) → direkter POST an
`https://<origin>/subscriptions/<id>?/runNow` ohne CF-JWT erzeugt & mailt eine echte Rechnung;
`?/toggle` / settings manipulieren das Geldverhalten des nächsten Runs.

**Fix (eine Stelle schliesst alles):** Ein `export const handle` in `apps/web/src/hooks.server.ts`, das
`verifyCfAccess(event.request)` für **jede nicht-öffentliche Route** aufruft und bei `CfAccessError`
401 liefert. Ausnahmen nur: `/health` (Coolify-Canary) und der bexio-OAuth-`callback`/`auth/bexio`
(muss für den Redirect erreichbar bleiben — dort State/PKCE prüfen statt JWT). Identity in `event.locals`
ablegen, damit die Endpoints den doppelten Check sparen können. Verifizieren, dass Cowork-Trigger und
`/health`-Bootstrap weiter funktionieren.
*(Begleitend zu Phase 5: die geplante Hetzner-Firewall-IP-Allowlist als zweite Schicht.)*

---

# Phase 2 — Send-Pfad-Korrektheit (Issue/Send/Reconcile-State-Machine)

**Ziel:** Den Versand-Zustandsautomaten gegen stillen Nicht-Versand und Doppel-Mail härten.
Alle drei Findings berühren dieselbe Funktion → gemeinsam fixen, ein Test-Durchlauf.

### BUG-2 (P1) — Crash vor `/send` wird als „sent" verbucht
**Datei:** `apps/worker/src/lib/state-machine.ts:560-574` (+ Claim `:219`, Transition `:422`)
**Confidence:** 0.82

`processOrder` setzt beim Claim `attempts: 1` (Z. 219, Schema-Default ist 0). `transitionTo(...'sending')`
(Z. 422) erhöht `attempts` nie. In `reconcileInFlightSends` ist die Branch-Reihenfolge:
`is_sent` bestätigt (553) → `attempts>=1` **assume-sent** (560) → `attempts>=MAX` (575) → `attempts===0`
retry (578). Da `attempts` schon beim Claim 1 ist, trifft **jede** beim ersten Lauf gecrashte
`sending`-Zeile Branch 560 und wird ohne Mail auf `sent` gezwungen. Der „safe-retry"-Branch (578),
genau für diesen Fall geschrieben, ist tot. Der `(order_id, billing_period)`-PK blockiert danach jeden Retry.

**Trigger:** Worker-Kill (Coolify-Redeploy/OOM/Host-Kill) zwischen dem `sending`-DB-Write (422) und dem
`sendInvoice`-POST (425-430). Auf einem Daily-Cron-Bot ein realer, wiederkehrender Risikofall (Deploys, OOM, bexio-Timeouts).

**Fix:** Send-Versuchszähler von der Claim-Existenz entkoppeln. Claim mit `attempts:0` einfügen und
`attempts` **unmittelbar vor** `sendInvoice` erhöhen — oder (geringerer Eingriff) ein separates
`sendStartedAt`-Timestamp direkt vor Z. 425 setzen und die assume-sent-Logik (560) darauf gaten statt auf
`attempts`. Danach unterscheidet der Reconciler „Crash vor Send" (→ retry) sauber von „bexio-Read-Back-Quirk"
(→ assume-sent, N-5). Snapshot-Reuse (279-291) und `retryIssuedRows` (606-616) auf die neue `attempts`-Semantik prüfen.

### BUG-3 (P1) — `retryIssuedRows` mailt bereits versandte Rechnung erneut
**Datei:** `apps/worker/src/lib/state-machine.ts:636-644`
**Confidence:** 0.85

`retryIssuedRows` ruft `getInvoice` (637) nur für `document_nr` (638) ab und sendet dann
**bedingungslos** erneut (639) — **ohne** `live.is_sent`/`live.mail_sent_at` zu prüfen (Asymmetrie zu
`reconcileInFlightSends`, das genau diesen Guard hat). Die Zeile landet in `issued`, wenn in `processOrder`
`sendInvoice` **erfolgreich** war (Mail raus), aber die direkt folgende `transitionTo('sent')` (432) an
einem transienten DB-Fehler scheitert → `wasIssued=true` → F-2 rollt auf `issued` zurück. Nächster Lauf
mailt dieselbe Rechnung erneut.

**Trigger:** `sendInvoice` ok, aber der unmittelbar folgende `sent`-DB-Write scheitert (transienter
Postgres-/Pool-Fehler) — wahrscheinlich gerade während des 1.1s-getakteten Langlaufs.

**Fix:** In `retryIssuedRows` vor dem Re-Send `live.is_sent || live.mail_sent_at` prüfen (Felder existieren,
`types.ts:219-220`); falls bereits gesendet → direkt `transitionTo('sent')` ohne erneutes Mail. Spiegelt den
Guard, den `reconcileInFlightSends` schon hat.

### BUG-7 (P3, hier mitfixen) — Dead Code in `reconcileInFlightSends`
**Datei:** `apps/worker/src/lib/state-machine.ts:575-589`

`else if attempts>=MAX_ATTEMPTS` (575) und `else if attempts===0` (578-589) sind unerreichbar, weil
`attempts>=1` (560) sie vorher abfängt (Folge desselben Claim-`attempts:1`). Nach BUG-2 ggf. erreichbar —
**daher zusammen entscheiden**: Wird BUG-2 via `sendStartedAt` gelöst, die toten `attempts`-Branches löschen
und kommentieren, dass das Retry-Cap in `retryIssuedRows` (`lt(attempts, MAX_ATTEMPTS)`) sitzt. **Kein**
Re-Send im Reconciler einführen (würde N-5-Duplikatschutz untergraben).

---

# Phase 3 — Resilienz: Token-Refresh & Sync-Robustheit

**Ziel:** Den „Billing stoppt still"-Cluster schliessen — Token-Hang, Cache-Wipe, Sync-Abbruch.

### BUG-4 (P1) — Token-Refresh hält Advisory-Lock + Pool-Connection über ungetimten `fetch`
**Datei:** `packages/bexio-client/src/auth.ts:63-108` → `http.ts:100-107`
**Confidence:** 0.85

`getValidAccessToken` öffnet eine `db.transaction`, nimmt `pg_advisory_xact_lock(4242001)` (64, xact-scoped),
und ruft dann `callTokenEndpoint` (93) → `http.ts:100-107` macht `await pace()` + nacktes `fetch()` zu
`auth.bexio.com` **ohne** `AbortSignal`/Timeout (Grep: 0 `AbortController`-Nutzung im Repo). Pool ist `max:5`,
ohne `statement_timeout`/`idle_in_transaction_session_timeout`. Hängt der bexio-Auth-Host (TCP-Accept, keine
Antwort), wird der Lock **unbegrenzt** gehalten — Worker **und** Web teilen denselben Lock-Key.

**Trigger:** bexio-Auth-Endpoint nimmt Verbindung an, stallt aber (Incident/Black-Hole) während eines
Refresh-Fensters — also gerade wenn der 08:00-Cron feuert und das Token im 60s-Refresh-Buffer ist.

**Fix:** Harte Timeouts: `signal: AbortSignal.timeout(10_000)` auf `callTokenEndpoint` (102) **und**
`callBexio` (77); resultierende `TimeoutError`/`AbortError` als `transient` klassifizieren (State-Machine
retryt dann). Defense-in-Depth: `statement_timeout` + `idle_in_transaction_session_timeout` in den
`postgres()`-Optionen (`db/index.ts:19-23`).

### EDGE-1 (P1) — Orphan-Cleanup löscht alle Orders jenseits des 5000-Cap
**Dateien:** `apps/worker/src/lib/sync.ts:163-171,254-268` (Konsequenz) · `packages/bexio-client/src/orders.ts:12-38` (Ursache)
**Confidence:** 0.85

`listRecurringOrders` paginiert `/kb_order` und filtert `is_recurring` **client-seitig**, bricht aber bei
`offset > 5000` mit `warn + break` ab → **partielle** Liste, **kein** Throw. FULL-Sync baut `seenIds` nur aus
dieser gekappten Menge und löscht hart `notInArray(bexioOrderId, seenArray)` (263-266). Der F-7-Guard schützt
nur den `length===0`-Fall, **nicht** die gekappt-aber-nichtleere Liste. Der Cap zählt **alle** Orders (inkl.
Einmal-Rechnungen), nicht nur Recurring — Schwelle ist ~5200 **Gesamt**-Orders, über Jahre erreichbar. Re-Sync
heilt nicht: Auto-Discovery re-inserted mit `enabled=false` → Opt-in-Flag dauerhaft verloren → stilles Nicht-Billing.

**Fix:**
1. **Sofort (P1):** Orphan-Cleanup nur ausführen, wenn die Liste *nicht* gekappt wurde. `listRecurringOrders`
   ein Truncation-Signal zurückgeben lassen (z. B. `{ orders, truncated:true }`); bei `truncated` Cleanup
   überspringen + Discord-Warnung (symmetrisch zu F-7).
2. **Tiefer (P3-Ursache):** Nicht still `break`en. Prüfen, ob `POST /kb_order/search` ein `is_recurring`-Kriterium
   akzeptiert (Memory-Notiz) → server-seitig filtern, Cap greift dann auf die kleine Recurring-Teilmenge.
   Sonst per `id`-aufsteigend paginieren und erst bei echt leerer Seite stoppen; `listContacts`/`listArticles`
   werfen bereits bei 5000 — diese Symmetrie herstellen.

### EDGE-2 (P2, hier mitfixen) — Ein malformer Order bricht den ganzen Sync ab
**Datei:** `apps/worker/src/lib/sync.ts:183-250`
**Confidence:** ~0.8

Die Per-Order-Schleife hat **kein** Per-Iteration-`try/catch`. `expectedAmount: o.total` (215/228) geht direkt
in eine `NOT NULL`-Spalte (schema.ts:86); ist `o.total` null/undefined oder der Status unerwartet, wirft das
`await` und propagiert. Da `run.ts:94` `syncRecurringOrders` **ohne** umgebendes `try/catch` aufruft (anders als
die Order-Schleife in `run.ts:116`), bricht der Throw `runDaily` ab, **bevor** irgendein Order abgerechnet wird.

**Fix:** Schleifenkörper (183-250) in `try/catch`; bei Fehler `{bexioOrderId:o.id}` in einen neuen
`failedOrders`-Bucket pushen + `continue`. `o.total` vor Insert coercen (`(o.total ?? '0').toString()` bzw.
Skip-with-Warning). `failedOrders` in die Notification heben. Optional `run.ts:94` umklammern, sodass ein
Sync-Fehler den Run degradiert (gecachte enabled-Orders trotzdem abrechnen) statt ihn abzubrechen.
*(Sync- und Resilienz-Cluster zusammen → ein Deploy.)*

---

# Phase 4 — Billing-Gates & Rechnungs-Gültigkeit

**Ziel:** Falsche/vorzeitige/Null-Rechnungen und Parallel-Runs verhindern.

### BUG-5 (P2) — `runSubscriptionNow` ohne Fälligkeits-Gate
**Datei:** `apps/worker/src/lib/subscriptions.ts:376-395`

`runSubscriptionNow` ruft `processOneSubscription` ohne Check auf `status`/`nextBillingDate <= today`
(anders als die Schleife in 136-140). Erfolg advanced `next_billing_date` um ein volles Intervall; der
`(subscriptionId, scheduledFor)`-Lock dedupliziert nur **dieselbe** Periode. Zweiter Klick rechnet sofort die
**nächste, noch nicht fällige** Periode ab. Über das Dashboard (`subscriptions/[id]?/runNow`,
`billing-runs?/retry`) ohne Bestätigung erreichbar.

**Fix:** In `runSubscriptionNow` vor `processOneSubscription`: (1) `status !== 'active'` → `failed`-Result;
(2) `nextBillingDate > today` (gleiche UTC-Mitternacht-Basis wie sonst) → `not_due`/`skipped` statt abrechnen.
Idempotenz-Lock für Gleich-Perioden-Schutz behalten. Optional `confirm()` auf dem „Jetzt abrechnen"-Button;
das server-seitige Gate ist der tragende Fix. Die `billing-runs`-Retry-Action denselben Guard erben lassen.

### EDGE-3 (P2) — Order/Snapshot-Pfad erzeugt still CHF-0-Positionen
**Datei:** `packages/bexio-client/src/invoices.ts:107-144`

`mapOrderPositionToInvoicePosition` coerced fehlende Geldfelder auf 0 ohne Validierung; `unit_price` fällt auf
`'0'` (140), `amount` auf `'1'`/`'0'` (114). `buildCreateInvoiceInputFromOrder` wirft nur bei
`positions.length===0` (87-89), prüft aber nie, dass der Total > 0 ist. Der Subscription-Pfad hat
`validateSubscriptionInputs`; der Order/Snapshot-Pfad (daily/weekly) hat **keinen** Zero-Guard.

**Fix (zwei Schichten):** (1) In `buildCreateInvoiceInputFromOrder` nur für den vollständig client-entscheidbaren
Fall werfen (alle Custom-Positionen `unit_price` null/0 **und** keine Article-Positionen). (2) **Autoritativ** in
`processOrder` **nach** der Erstellung: bexio liefert `invoice.total` (genutzt 290/389/437) — vor `issuing`
bei `Number(invoice.total) <= 0` → `deleteClaim` + `failed`/`not_due` („refusing to issue CHF 0 invoice").
Denselben Post-Create-Guard symmetrisch im Subscription-Pfad.

### EDGE-4 (P2) — Transienter `getInvoice`-Fehler markiert In-Flight-Rechnung dauerhaft `failed`
**Datei:** `apps/worker/src/lib/state-machine.ts:551-594`

In `reconcileInFlightSends` führt der einzige `try/catch` um den bexio-Read-Back bei jedem Throw direkt zu
`markFailed` (592) — kein Retry, kein „in `sending` für nächsten Lauf belassen". Ein erschöpfter
Retry-Throw (bexio-5xx-Fenster, Token-Hiccup) failt damit terminal eine Zeile, deren Rechnung in bexio
evtl. ausgestellt/gesendet ist.

**Fix:** Im Catch (591-593) den Fehler diskriminieren: nur bei **definitiv permanentem 404** `markFailed`;
bei transient/auth/rate-limit/network die Zeile in `sending` **unberührt** lassen (kein `markFailed`, Lock
nicht clearen) → nächster Lauf reconciled erneut. Gegen Endlos-Stuck einen begrenzten Reconcile-Pass-Zähler;
erst nach N Pässen `markFailed('reconcile_readback_unresolved')`. Spiegelt die F-2-Philosophie.

### EDGE-5 (P2) — Cron-Daily-Run ohne In-Flight-Guard
**Datei:** `apps/worker/src/lib/run.ts:75-87`

Der HTTP-Trigger prüft auf eine offene `bot_runs`-Zeile < `STALE_MS` und gibt 409 zurück. Der CLI/Cron-Pfad
in `runDaily` inserted einfach eine frische Zeile (78-86) ohne diesen Check. Läuft ein Cowork-Run (oder ein
zäher Vorlauf) noch, wenn der 06:00-UTC-Cron feuert, laufen **zwei** `runDaily` parallel.

**Fix:** Den ganzen Run in einen Postgres-Session-`pg_try_advisory_lock` (fixer Key, analog F-6) wickeln und
abbrechen, wenn der Lock gehalten wird — echte Mutual-Exclusion über Cron- **und** HTTP-Pfad mit einem
Mechanismus. (Ein blosser SELECT-Guard hätte dieselbe TOCTOU-Race wie der HTTP-Pfad.) Per-Order-Locks
verhindern bereits den Geldschaden; dieser Fix verhindert doppelte API-Last und Interleaving.

---

# Phase 5 — Härtung & Observability (P3, ein Deploy)

### BUG-6 — `Retry-After` geparst, aber nie aufs Pacing angewandt
`bexio-client/http.ts:82-90`. `retryAfterSeconds` wird gesetzt, aber **nirgends** gelesen. Bei 429 mit
`retryAfterSeconds` einmal `sleep min(retryAfterSeconds*1000, 30s)` und denselben (nur diesen, idempotenten)
Call einmal wiederholen, bevor geworfen wird. Reduziert ~24h-Billing-Verzögerung bei Bursts.

### BUG-8 / SEC-2 — Token-Endpoint-Fehlerbehandlung (zwei Aspekte, gleiche Zeilen)
`bexio-client/auth.ts:94-97`.
- **BUG-8:** `errorClass` ist hart `'auth'`, unabhängig vom Status → 429/5xx vom IdP werden als „Token ungültig,
  neu auth'en" fehlinterpretiert. Stattdessen klassifizieren: nur `invalid_grant`/`invalid_client` → `auth`,
  429 → `rate_limit`, 5xx → `transient` (`classifyStatus` aus `http.ts` wiederverwenden).
- **SEC-2:** Der rohe Response-Body wandert verbatim in `BexioApiError` → `bot_runs.errorsJsonb` (run.ts:100-103),
  aufs `/runs`-Dashboard und in den S3-`pg_dumpall`. Nur den OAuth-`error`-Code + redigierten kurzen
  `error_description`-Slice surfacen; rohen Body höchstens in `console`, nie in `BexioApiError.body`.

### SEC-3 — `/health` leakt DB-Fehlerstrings
`web/routes/health/+server.ts:38-43`. Unauth Canary gibt `err.message` im Body zurück (kann Connection-String-/
Host-/Rollen-Fragmente enthalten), Origin-direkt erreichbar. Catch: server-seitig loggen, generischen Body
`{status:'db_error'}` + 503 zurückgeben.

### SEC-4 — `discord_webhook_url` SSRF
`web/routes/settings/+page.server.ts:107-113`. Validierung nur `^https://.+` — kein Host-Constraint. Der Worker
POSTet später an diese URL → interne Adressen (`169.254.169.254`, `localhost`, interne Coolify-Services) möglich.
Host-Allowlist (`discord.com`, `discordapp.com`, `canary./ptb.discord.com`) + Private/Loopback/Link-Local-IP-Literale
ablehnen; denselben Check belt-and-suspenders vor `postWebhook`.

### EDGE-6 — Dashboard-„heute" in UTC statt Europe/Zurich
`web/routes/+page.server.ts:19-23`. `::date = current_date` löst in der DB-Session-TZ (UTC) auf; Geschäft +
`billing_period`-Keys sind Europe/Zurich (schema.ts:102). Zwischen 00:00-02:00 CH zeigt „heute" den Vortag.
Fix: `(sentAt AT TIME ZONE 'Europe/Zurich')::date = (now() AT TIME ZONE 'Europe/Zurich')::date` (analog `updatedAt`).

### EDGE-7 — Unbegrenzte Loader-SELECTs
`web/routes/+page.server.ts:19-30` u. a. Niedrigste Priorität. Statt Refactoring einen Covering-Index
`billing_runs(subscription_id, created_at DESC)` legen, damit das `DISTINCT ON` index-only bleibt, wenn
`billing_runs` wächst. LIMIT/Pagination erst bei Annäherung an die ~1k-Schwelle.

### EDGE-8 — `unsupportedOrders` nie sichtbar
`worker/lib/run.ts:94,165-200`. `syncRecurringOrders` liefert `unsupportedOrders`, aber `runDaily` liest sie nie
(nicht in `bot_runs`, nicht in `notifyAll`). Durchreichen wie `driftWarnings`: Discord-Embed-Feld „⚠ Nicht
unterstützt", `unsupportedOrders` in den `notifyAll`-Payload, `console.log` in `cli.ts --sync`.

### EDGE-9 — `validateSubscriptionInputs` lehnt legitime CHF-0/Gutschrift-Positionen ab
`worker/lib/subscriptions.ts:76-84`. `Number(price)===0` blockt bewusste CHF-0-Positionen (Gratis-Artikel,
100%-Rabatt) und `Number('')===0`. Ersetzen: (1) null/NaN-Guard behalten (echter unkonfigurierter Preis,
N-8-Intent); (2) Gesamt-Total aus Positionen rechnen und nur bei Total ≤ 0 fail-closen. Fehlermeldung
„unkonfigurierter Preis" vs. „Null-Rechnungs-Total" trennen; Test für gemischtes Paid+Free-Abo.

### EDGE-10 — `order_due_window_days` unbeschränkt
`web/routes/settings/+page.server.ts:125-142` + `worker/lib/settings.ts:58-61`. Validierung nur Integer ≥ 0,
**keine** Obergrenze → ein grosser Wert (z. B. 99999) deaktiviert das Due-Gate faktisch und re-introduziert die
„feuert sofort/back-billt"-Lücke (vgl. `project_order_due_gate`). Im Form `due > 31` ablehnen; in
`parseWindowDays` spiegeln: `return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 31) : 3`. Echte Gefahr
ist Back-Billing der jüngsten Vergangenheits-Okkurrenz eines frisch aktivierten Orders, nicht Vorab-Billing.

---

## Deploy-Checkliste pro Phase

Pro Phase: `bun test` grün → commit → `git push origin main` → **beide** Coolify-Apps deployen
(Worker `s8dljxy4nawz52bxcjhar9nm` + Web `vx76yeg463w2ckfndrsbsj8m`, vgl. `project_dual_app_deploy`) →
Deployment-`.status==finished` pollen → Live-Verify (Canary-Order #13 via `POST /api/trigger-run`).
Token aus `.env.local` → `COOLIFY_API_TOKEN`.

## Empfohlene Reihenfolge
**Phase 1 zuerst** (P0 + Auth) — sofort deployen. Danach 2 → 3 → 4 → 5. Phase 1 BUG-1 und SEC-1 sind voneinander
unabhängig und können in einem Commit-Paar zusammen raus. Vor Phase 2 lohnt ein gezielter Test, der den
Crash-vor-Send-Pfad simuliert (Kill zwischen `sending`-Write und `sendInvoice`).
