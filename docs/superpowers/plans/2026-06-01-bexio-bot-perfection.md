# Bexio-Bot „Perfektionierung" — Implementierungsplan

**Datum:** 2026-06-01
**Status:** genehmigt zur Umsetzung (Entscheidungen bestätigt)
**Vorarbeit:** Discovery-Workflow (7 Agenten) + Live-Probe (read-only, Prod) — siehe „Befunde".

---

## Ziel

Den Bot perfektionieren entlang dreier Achsen:
1. **Smarter Order-Import** — manuell (Einzel-Auftrag) + automatisch-regelmäßig (Hybrid-Sync), entkoppelt vom Billing-Lauf.
2. **Vollständige, korrekte Rechnungs-Generierung** für jeden Wiederholungs-Zyklus.
3. **Settings-Seite** im SvelteKit-Web mit sinnvollen, im Gesamtkontext editierbaren Einstellungen.

Validierung über die „IT Service Martin"-Testaufträge (#13 daily, #14 weekly/Di, #15 monthly/fixed_day).

---

## Bestätigte Entscheidungen

| # | Thema | Entscheidung |
|---|-------|--------------|
| 1 | Import-Opt-in | Per-Import-Checkbox „sofort aktivieren", Default **AUS**. Auto-Discovery (Sync) landet **immer** `enabled=false`. |
| 2 | Subscription-Pipeline | **Abschaffen** (Live: 0 Subscriptions je angelegt → risikofrei). Alles läuft über die Order-Pipeline. |
| 3 | Inkrementell-Sync | **Hybrid**: Voll-Scan 1×/Tag (Sicherheitsnetz + Orphan-Cleanup) + Inkrement alle ~2h via `POST /kb_order/search` auf `updated_at`, **client-seitig** `is_recurring` filtern. |
| 4 | Adress-Drift | **Erkennen & flaggen** (Auftrags-Adresse vs. Live-Kontakt vergleichen, bei Abweichung in Discord melden), **nicht** auto-ändern. |

## Harte Live-Fakten (Probe 2026-06-01)

- `subscriptions`/`billing_runs` = **0 Zeilen** → Subscription-Abschaffung ohne Migration.
- 10 `recurring_orders`, **alle `enabled=false`** → Bot rechnet aktuell nichts ab (seit Mai-30-Incident pausiert). Sicherer Umbau-Zeitpunkt.
- `POST /kb_order/search` mit `is_recurring` → **400** (nicht serverseitig filterbar). Mit `updated_at` → **200 OK**. → Hybrid muss client-seitig `is_recurring` filtern.
- Repetition-Objekt: nur `{start, end?, repetition:{type, interval, schedule?, weekdays?}}`. **Kein** Occurrence-Count-Feld (API liefert es nicht). `schedule` gesehen: `last_day`, **`fixed_day`** (neu).
- Adress-Drift real (Auftrag #1 Adresse ≠ Live-Kontakt #213; `contact_id` evtl. neu belegt → naives Live-Ziehen riskiert Fehl-Zuordnung).
- `POST /kb_invoice/search` auf `api_reference` → **200** (Idempotenz-Guard machbar, nur Snapshot-Pfad setzt eine Referenz).

---

## Phasen (nach Risiko geordnet)

### Phase 1 — Foundation: `app_settings` (additiv, risikoarm)
- `packages/db/src/schema.ts`: neue Tabelle `app_settings(key text PK, value text, updated_at timestamptz)` (separat von `secrets`).
- Migration `0006_app_settings.sql` (Drizzle generate).
- `packages/db`: `getSetting(db, key, fallback?)` + `setSetting(db, key, value)` Helper, exportiert.
- **TDD:** Test für get/set (insert, update, fallback bei fehlender Zeile).

### Phase 2 — Worker liest Config aus DB (mit Env-Fallback)
- `ORDER_DUE_WINDOW_DAYS` (state-machine.ts), Mail-Betreff/-Text (dedup aus state-machine.ts **und** subscriptions.ts → eine Quelle), Auto-Send-Gate, `DISCORD_WEBHOOK_URL` + `notifications_enabled` (packages/notify) → `getSetting` first, Env second.
- **Risiko:** berührt Live-Billing/Notify. Env-Fallback zwingend (fehlende Zeile = nicht fatal). Dry-Run-Canary + Codex-Review.
- **Deploy beider Coolify-Apps** (Worker-Änderung).

### Phase 3 — `/settings`-Seite
- `apps/web/src/routes/settings/+page.server.ts` (load: app_settings + `secrets.expiresAt` für OAuth-Status; 4 Form-Actions) + `+page.svelte` (4 `.section`-Karten, Webhook maskiert, `[Network Link]`-Validierung im Mail-Text).
- Gruppen: (A) Verbindung & Status (read-only OAuth + „bexio neu verbinden"), (B) Benachrichtigungen, (C) Rechnungsstellung, (D) Import & Erweitert.
- Footer-Link. CF-Access-Edge schützt wie das Dashboard.
- Cron-Schedule **read-only** anzeigen (Edit bleibt Coolify).

### Phase 4 — Smarter Import (entkoppelt)
- `packages/bexio-client/src/orders.ts`: `searchOrders(token, criteria)` (POST /kb_order/search) + `listRecurringOrdersSince(token, sinceIso)` (updated_at-Suche + client-seitig is_recurring).
- `apps/worker/src/lib/sync.ts`: `syncRecurringOrders(syncMode: 'full'|'incremental')` (Watermark `last_incremental_sync_at` in app_settings) + `importOrderById(db, token, orderId, {enable})` (nutzt getOrder + getOrderRepetition, upsert einer Zeile).
- `apps/web/src/routes/api/sync/+server.ts` (CF-Access wie trigger-run; body `{mode, orderId?, enable?}`) — **synct ohne abzurechnen**.
- `apps/web/src/routes/orders/import/` UI: Preview (search, kein Persist) + Actions `syncNow` und `importOne` (Checkbox „sofort aktivieren" → `import_auto_enable`).

### Phase 5 — Billing-Korrektheit (geld-erzeugende Pfade → REVIEW-GATE davor)
- (a) `next-billing.ts`: weekly `interval>1` Wochen-Skip-Logik + Tests (interval=2, 1 & 2 weekdays).
- (b) `state-machine.ts`: Snapshot `is_valid_from` = **Vorkommens-Datum** (nicht heute) → Period-Key bleibt auf Schedule.
- (c) API-seitiger Idempotenz-Guard: `POST /kb_invoice/search` auf `api_reference` vor Snapshot-`POST /kb_invoice`.
- (d) `mapRepetitionToInterval`: rohen `interval`-Multiplikator mitführen → ehrliches Label („alle 2 Monate"); Billing-Math unverändert.
- (e) `sync.ts`: null/Fetch-Fehler nicht mehr zu „monthly-due-now" zwingen → `needs_attention`-Markierung + in `unsupportedOrders` surfacen.
- (f) `schedule='fixed_day'` explizit erkennen + Test (Default-Verhalten ist bereits korrekt, aber absichern).
- **TDD** in next-billing.test.ts + invoices.test.ts, Dry-Run-Canary, **Codex adversarial** (wie 21-Fix-Audit).

### Phase 6 — Adress-Drift erkennen & flaggen
- Beim Abrechnen Auftrags-`contact_address` vs. Live-`GET /contact/{id}` vergleichen; bei Abweichung → `driftWarnings[]` in der Run-Summary → Discord-Notification. **Keine** Rechnungs-Änderung.

### Phase 7 — Subscription-Pipeline abschaffen
- `apps/web`: `/subscriptions/new` Form entfernen/deaktivieren; `/subscriptions` als read-only/deprecated markieren.
- `apps/worker/src/lib/run.ts`: `processSubscriptions` + `reconcileInFlightBillingRuns` aus dem Lauf nehmen.
- Tabellen (`subscriptions`/`subscription_items`/`billing_runs`) **vorerst behalten** (leer, kein Drop-Risiko); im Code als deprecated kennzeichnen. `billing-interval.ts`/`subscriptions.ts` entfernen oder als tot markieren.
- Mail-Template-Dedup aus Phase 2 berücksichtigen (subscriptions.ts war zweite Quelle).

### Phase 8 — Infra: 2. Coolify-Scheduled-Task
- Every-2h-Task → `POST /api/sync` mode=incremental (gated `incremental_sync_enabled`). 08:00-Billing-Lauf unverändert. Coolify-Resource-Map + API-Quirks aus Memory beachten. ON-CONFLICT macht Race mit Billing-Sync sicher.

### Phase 9 — Validierung
- Pro Zyklus über #13 (daily) / #14 (weekly/Di) / #15 (monthly/fixed_day): Dry-Run + `POST /api/trigger-run?onlyOrderId`. Idempotenz durch Doppel-Trigger (skipped_duplicate). Settings-Durchstich (Wert in /settings ändern → Worker liest ihn). Adress-Drift-Flag an #1 prüfen. Finale Live-Bestätigung via 08:00-Canary.

---

## Einstellungen auf `/settings` (Phase 3)

| key | Label | Typ | Default | Gruppe |
|-----|-------|-----|---------|--------|
| `oauth_status` | bexio Verbindung | status (read-only) | — | A |
| `notifications_enabled` | Benachrichtigungen aktiv | boolean | true | B |
| `discord_webhook_url` | Discord Webhook URL | secret (maskiert) | (env) | B |
| `dashboard_url` | Dashboard-Link | url | https://bexio-bot.martini.digital | B |
| `auto_send_invoices` | Rechnungen automatisch versenden | boolean | true | C |
| `invoice_mail_subject` | Rechnungs-E-Mail Betreff | text | `Rechnung {document_nr}` | C |
| `invoice_mail_message` | Rechnungs-E-Mail Text | textarea | (DE-Text, `[Network Link]` Pflicht) | C |
| `order_due_window_days` | Fälligkeits-Toleranz (Tage) | number | 3 | C |
| `import_auto_enable` | Neu importierte Aufträge auto-aktivieren | boolean | false | D |
| `incremental_sync_enabled` | Häufige Auftrags-Synchronisation | boolean | true | D |
| `run_stale_minutes` | Lauf gilt als hängen nach (Min) | number | 120 | D |

**Bleiben Deploy-Zeit-Env (nie exponiert):** DATABASE_URL, BEXIO_CLIENT_ID/SECRET, BEXIO_REDIRECT_URI, CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, POSTGRES_PASSWORD, COOLIFY_API_TOKEN.

---

## Querschnitt / Regeln
- **TDD** für jede Logik-Änderung; **Env-Fallback** überall, wo Worker auf DB-Settings umstellt.
- **Worker-Änderungen → beide Coolify-Apps deployen** (Web lädt runDaily inline).
- **Review-Gate** vor Phase 5/6/7 (geld-/Pipeline-Pfade): Codex adversarial + Dry-Run-Canary.
- Reihenfolge: 1→2→3 (additiv) ohne Gate; 4 additiv; **5/6/7 hinter Review-Gate**; 8/9 zum Schluss.
