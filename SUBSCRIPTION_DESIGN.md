# Design: Subscription-Layer im bexio-bot

Erstellt: 2026-05-11 (via /office-hours)
Finalisiert: 2026-05-13 (Scope-Entscheid + UX-Klärung)
Branch: main
Repo: napoleonmm83/bexio-bot
Status: APPROVED — bereit für /writing-plans
Mode: Intrapreneurship

## Problem Statement

Bexio's "Wiederkehrende Aufträge" haben zwei Architekturprobleme:

1. **Adress-Drift**: Auftrag cached die Kundenadresse zum Erstellungszeitpunkt.
   Wird der Kontakt nachträglich aktualisiert, läuft der Auftrag mit veralteter
   Adresse weiter. Manueller Sync pro Auftrag nötig, wird vergessen. Akuter
   Vorfall am 11.05.2026.

2. **API-Trigger fehlt** (entdeckt 12.05.2026 via Live-Probe gegen AU-00013):
   `POST /kb_order/{id}/invoice` ist eine Pull-Methode an `amount_open` der
   Order-Position — NICHT der Recurring-Trigger. Nach der ersten Rechnung ist
   die Position erschöpft und bexio antwortet `422 "order is fully invoiced"`.
   Daily-Recurring im Bot ist damit grundsätzlich unmöglich. Monthly/Yearly
   funktioniert "zufällig" weil bexio's UI-Wizard die Position bei jeder
   Recurrence neu auflädt — diesen Wizard exponiert bexio NICHT via Public-API
   (context7-Recherche 12.05.2026 bestätigt).

## Demand Evidence

- Akuter Adress-Drift-Vorfall am 11.05.2026 mit Bestandskunden.
- AU-00013 (daily-canary) schlägt seit Setup fehl — beweist das API-Trigger-Problem.
- Wachstumspfad: martini.digital Hosting skaliert auf "ganz ganz viele" Kunden.
  Bei 50 Kunden mit jährlichen Adressänderungen ist manueller Sync Vollzeit.
- Operator-Pain ist selbst-validiert — Marcus ist Kunde + Betreiber.

## MVP-Scope

**Nur neue Abos im Bot.** Bestehende `AU-00xxx` Recurring-Aufträge bleiben in
bexio's Recurring-Engine. Marcus migriert manuell wenn er Lust hat (kein
Migrations-Skript). AU-00013 (das kaputte daily) rechnet Marcus manuell ab
oder löscht den Recurring-Teil.

Begründung: schneller fertig, kleineres Risiko, beide Systeme dürfen erstmal
parallel laufen. Discord + Dashboard trennen die zwei Welten klar.

**Im MVP NICHT enthalten** (bewusst out-of-scope):

- Migrations-Skript für bestehende bexio-Recurring
- Proration / Mid-Cycle-Wechsel
- Trial-Phase
- Self-Service-Portal (Kunde wählt selbst Plan)
- Card-Payment / Stripe
- Twenty CRM Integration
- Multi-Currency (CHF-only)
- daily / weekly / quarterly Intervalle (nur **monthly + yearly**)
- Free-Form Positionen (nur bexio-Produkte aus Katalog)
- Email-Override pro Subscription (nur bexio-Kontakt-Email)

## Constraints

- Bexio bleibt Source of Truth für Rechnungen + CH-Buchhaltung.
- Kein Card-Payment, nur Rechnungsversand per Email via bexio.
- Bot läuft auf Coolify, daily cron `0 6 * * *` UTC (08:00 CH).
- Postgres + Drizzle ORM + SvelteKit-Dashboard existieren.
- Kein neuer 3rd-Party-Service.
- Idempotenz via `(subscription_id, scheduled_for)` UNIQUE.
- Status `partial` + `open` zählen weiter als billable (siehe `mapBexioStatus`).

## Architektur

**Parallel-Betrieb, kein Replace.**

```
runDaily()
  ├─ syncRecurringOrders()        ← bestehend, bleibt
  ├─ reconcileInFlightSends()     ← bestehend, bleibt
  ├─ retryIssuedRows()            ← bestehend, bleibt
  ├─ processOrder() ×N            ← bestehend, für AU-XXX
  └─ processSubscriptions() ×M    ← NEU
```

Discord-Embed wird ergänzt um eine Sektion "Subscriptions" neben "bexio-Recurring".

## Datenmodell

Drei neue Tabellen in der bestehenden Postgres via Drizzle-Migration.

```sql
subscriptions
  id                  serial PK
  bexio_contact_id    int       NOT NULL
  name                text      NOT NULL  -- z.B. "Hosting Basic — IT Service Martin"
  interval            text      NOT NULL CHECK (interval IN ('monthly','yearly'))
  start_date          date      NOT NULL
  end_date            date      NULL      -- optional, NULL = unbefristet
  next_billing_date   date      NOT NULL
  status              text      NOT NULL CHECK (status IN ('active','paused','cancelled'))
  auto_send           boolean   NOT NULL DEFAULT true
  notes               text      NULL
  created_at          timestamptz NOT NULL DEFAULT now()
  updated_at          timestamptz NOT NULL DEFAULT now()

subscription_items
  id                  serial PK
  subscription_id     int       NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE
  bexio_article_id    int       NOT NULL
  qty                 numeric(10,3) NOT NULL DEFAULT 1
  position_order      int       NOT NULL DEFAULT 0
  created_at          timestamptz NOT NULL DEFAULT now()
  -- Preis + MWST werden zum Billing-Zeitpunkt live aus bexio gezogen
  -- Keine Custom-Positionen (out-of-scope)

billing_runs
  id                  serial PK
  subscription_id     int       NOT NULL REFERENCES subscriptions(id)
  scheduled_for       date      NOT NULL
  executed_at         timestamptz NULL
  bexio_invoice_id    int       NULL
  status              text      NOT NULL CHECK (status IN ('pending','success','failed','skipped'))
  error_jsonb         jsonb     NULL
  created_at          timestamptz NOT NULL DEFAULT now()
  UNIQUE (subscription_id, scheduled_for)
```

`billing_runs.UNIQUE(subscription_id, scheduled_for)` ist der Idempotenz-Lock —
analog zu `invoice_runs.UNIQUE(order_id, billing_period)` in der alten Pipeline.

## Cron-Flow

Nach dem bestehenden `processOrder`-Loop neuer Block in `runDaily()`:

```ts
async function processSubscriptions(db, accessToken, today) {
  const due = await db.select().from(subscriptions).where(and(
    eq(subscriptions.status, 'active'),
    lte(subscriptions.nextBillingDate, today),
    or(isNull(subscriptions.endDate), gte(subscriptions.endDate, today)),
  ));

  const results = [];
  for (const sub of due) {
    results.push(await processOneSubscription(db, accessToken, sub, today));
  }
  return results;
}

async function processOneSubscription(db, accessToken, sub, today) {
  // 1. Idempotenz-Lock
  const inserted = await db.insert(billingRuns).values({
    subscriptionId: sub.id,
    scheduledFor: today,
    status: 'pending',
  }).onConflictDoNothing({ target: [billingRuns.subscriptionId, billingRuns.scheduledFor] })
    .returning();
  if (inserted.length === 0) return { kind: 'skipped_duplicate', subId: sub.id };

  try {
    // 2. Live-Daten holen
    const contact = await getContact(accessToken, sub.bexioContactId);
    const items = await db.select().from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, sub.id))
      .orderBy(subscriptionItems.positionOrder);
    const articles = await Promise.all(items.map(i => getArticle(accessToken, i.bexioArticleId)));

    // 3. Rechnung erzeugen
    const invoice = await createInvoice(accessToken, {
      contact_id: contact.id,
      title: sub.name,
      is_valid_from: today,
      mwst_type: articles[0]?.mwst_type ?? 0,
      positions: items.map((item, idx) => ({
        type: 'KbPositionArticle',
        article_id: item.bexioArticleId,
        amount: item.qty,
        unit_price: articles[idx].sale_price,
        tax_id: articles[idx].tax_id,
      })),
    });

    // 4. Issue + optional send
    await issueInvoice(accessToken, invoice.id);
    if (sub.autoSend && contact.mail) {
      await sendInvoice(accessToken, invoice.id, { recipientEmail: contact.mail, ... });
    }

    // 5. Status + next_billing_date
    await db.update(billingRuns).set({
      status: 'success',
      bexioInvoiceId: invoice.id,
      executedAt: new Date(),
    }).where(eq(billingRuns.id, inserted[0].id));

    await db.update(subscriptions).set({
      nextBillingDate: addInterval(sub.nextBillingDate, sub.interval),
      updatedAt: new Date(),
    }).where(eq(subscriptions.id, sub.id));

    return { kind: 'sent', invoiceId: invoice.id, amount: invoice.total };
  } catch (err) {
    await db.update(billingRuns).set({
      status: 'failed',
      errorJsonb: serializeError(err),
      executedAt: new Date(),
    }).where(eq(billingRuns.id, inserted[0].id));
    return { kind: 'failed', reason: String(err) };
  }
}
```

**Catch-up bei Bot-Downtime**: Wenn der Bot mehrere Tage offline war und
`next_billing_date` weit in der Vergangenheit liegt, läuft der Schleife
maximal 12 Iterationen pro Subscription nach (Safety-Cap), erzeugt also bis
zu 12 nachgeholte Rechnungen für ein einzelnes Abo. Bei monthly = 1 Jahr
Catch-up. Sollte in der Praxis nie passieren, ist aber dokumentiert.

## UI-Flow (SvelteKit-Dashboard)

Vier neue Routen unter dem bestehenden Dashboard:

| Route | Funktion |
|---|---|
| `/subscriptions` | Liste: Name, Kunde, Interval, nächste Fälligkeit, Status. Filter (aktiv / pausiert / gekündigt / alle). Spaltensortierung. |
| `/subscriptions/new` | Single-Page-Form zum Anlegen. |
| `/subscriptions/[id]` | Detail-Page mit Edit, Pause, Cancel, "Jetzt manuell abrechnen". History der billing_runs für dieses Abo. |
| `/billing-runs` | History aller Runs übergreifend, mit Retry für `failed`. |

### Anlege-Form (single page, kein Wizard)

```
Kunde         [Kontakt suchen…           ▾]   ← preload alle bexio-contacts client-side (<50 erwartet)
Plan-Name     [Hosting Basic — IT Service…]   ← auto-suggest aus Kunde + Produkt, editierbar
Intervall     (•) monatlich   ( ) jährlich
Startdatum    [____-__-__]                    ← default: heute
Enddatum      [____-__-__] [unbefristet ✓]    ← optional
Auto-send     [✓] Rechnung gleich versenden

Positionen
+ Produkt hinzufügen
  ┌────────────────────────────────────┐
  │ Produkt: [Hosting Basic        ▾]  │
  │          CHF 29.00 · 8.1%          │  ← live aus bexio article
  │ Menge:   [1.00]                    │
  │ [entfernen]                        │
  └────────────────────────────────────┘
+ Produkt hinzufügen

[Anlegen]  [Abbrechen]
```

**Edit**: bearbeitet alles ausser `subscription_id` und billing_run-History.

**Pause**: setzt `status='paused'`. Cron skipt. Kein Rückstau bei Resume —
`next_billing_date` wird beim Resume neu berechnet (auf nächstes Intervall
ab heute).

**Cancel**: setzt `status='cancelled'`, sofort wirksam. Kein "läuft noch bis
Ende des Zyklus". Keine weiteren Rechnungen.

**Manuell abrechnen**: erzeugt einen `billing_runs(scheduled_for=today)` ausserhalb
des Cron-Schedules. Idempotenz-Lock greift — kein Doppel-Lauf am selben Tag.
`next_billing_date` wird NICHT verschoben (bleibt beim regulären Plan).

## Neue bexio-Client-Erweiterungen

| Endpoint | File | Wofür |
|---|---|---|
| `GET /2.0/contact` | `packages/bexio-client/src/contacts.ts` | bereits, Liste-Variante neu |
| `GET /2.0/article` (Liste) | `packages/bexio-client/src/articles.ts` (neu) | Produkt-Picker |
| `GET /2.0/article/{id}` | dito | Live-Preis beim Billing |
| `POST /2.0/kb_invoice` | `packages/bexio-client/src/invoices.ts` (Funktion neu) | Direkt-Rechnung |
| `POST /2.0/kb_invoice/{id}/issue` | bereits |
| `POST /2.0/kb_invoice/{id}/send` | bereits |

## Failure-Modes

| Szenario | Verhalten |
|---|---|
| bexio `GET /contact` 404 | billing_runs.status=failed, Discord-Alert, weiter mit nächster Subscription |
| bexio `GET /article` 404 | dito |
| `POST /kb_invoice` 422 | Body in error_jsonb, Discord-Alert mit Klartext, weiter |
| Crash zwischen INSERT billing_runs + POST /kb_invoice | `pending` Row bleibt. Nächster Lauf: reconcile-Logik prüft pending älter als 5min, fragt bexio ob Rechnung mit `api_reference` existiert (api_reference=`sub:{id}:run:{billingRunId}`), markiert success/failed |
| `next_billing_date` weit in Vergangenheit (Bot offline gewesen) | Catch-up bis 12 Iterationen pro Subscription, danach skipped + Alert |
| Subscription cancelled während laufendem Billing | next_billing_date wird trotzdem aktualisiert; status='cancelled' verhindert nächsten Lauf |

## Idempotenz-Pattern

Analog zur bestehenden Pipeline (Pattern aus
`feedback_bexio_invoices_send_with_idempotency`):

1. **Pre-flight INSERT** mit UNIQUE-Constraint vor jedem API-Call
2. **api_reference** auf der bexio-Rechnung: `sub:{subId}:run:{runId}` —
   erlaubt reconcile bei Crash zwischen DB + API
3. **Niemals** bestehende billing_runs-Row überschreiben — nur ergänzen

## Discord-Notification

Bestehendes Embed (`buildRunEmbed`) wird erweitert:

```
Lauf erfolgreich · 2/3 Rechnungen

bexio-Recurring (1)
✓ Kunde A      CHF 99 · bexio #1234

Subscriptions (2)
✓ Kunde B      CHF 29 · bexio #1235
✗ Kunde C      bexio 422: article not found
```

## Success Criteria

- Marcus kann im Dashboard ein neues monthly/yearly Abo in unter 60 Sekunden anlegen
- Adress-Update am bexio-Kontakt erfordert KEINE weitere Aktion am Bot/Abo
- Idempotenz: kein Doppel-Lauf bei mehreren Cron-Ticks am gleichen Tag (z.B. Cowork + 08:00-Cron)
- Pause / Cancel / Resume funktionieren ohne Datenverlust
- Discord trennt klar "bexio-Recurring" von "Subscriptions"
- Bestehende AU-XXX-Pipeline läuft unverändert weiter

## Dependencies

- bexio API (Contacts, Articles, Invoices) — teilweise integriert, Erweiterung nötig
- Coolify Daily Cron — bereits vorhanden
- Discord Webhook — bereits vorhanden
- Postgres + Drizzle Migrations — bereits vorhanden (Migration 0003 wird neu)

## Offene Klärungen für Implementations-Plan

1. **bexio article tax_id Mapping** — wie wird MWST-Satz von bexio zurückgegeben? Pro Artikel `tax_id` → wir reichen 1:1 durch.
2. **Preis-Snapshot vs. Live** — Design entschieden: live. Falls Marcus später Snapshot will, ist `price_at_creation` auf `subscription_items` ein einzeiliger Schema-Patch.
3. **Cron-Sequenz** — Reihenfolge im `runDaily()`: existing recurring zuerst, dann subscriptions. Begründung: existierende kunden-impact zuerst behandeln, neue Pipeline ist optional.
4. **api_reference Schema** — Format `sub:{id}:run:{billingRunId}` für reconcile. Eindeutig + sucht-bar via bexio API.

## What I noticed about how you think (carried over)

- Du hast den akuten Drift-Vorfall sofort als Skalierungsproblem reframt.
- Du widerstehst dem "großes Ding bauen"-Reflex — Self-Service kommt später, jetzt nur Operator-Tooling.
- Du fragst nach Alternativen vor Commitment.
- Pragmatischer MVP-Scope: nur monthly+yearly, kein Migration-Big-Bang, kein Custom-Positions-Bloat.
