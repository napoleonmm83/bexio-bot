# Hand-off: bexio Recurring Invoice Bot (für Claude Code)

> **2026-05-11 Status update — Phase 1 ist LIVE auf Coolify.**
>
> Das untenstehende Dokument war der ursprüngliche Plan vom 2026-05-10. Die meisten
> "Schritte für Claude Code" sind erledigt:
>
> - ✅ Repo `napoleonmm83/bexio-bot` (private GitHub) — gebaut via SSH-Deploy-Key
> - ✅ Web-App + Worker auf Coolify, hinter Cloudflare Access (OTP zu Marcus' Gmail)
> - ✅ OAuth-Flow web-basiert auf `https://bexio-bot.martini.digital/callback`
> - ✅ Worker als Coolify Scheduled Task, daily 06:00 UTC (= 08:00 CH Sommer)
> - ✅ Idempotenz-Lock + Pipeline live-verifiziert (`fb99666 feat(send): real bexio email send pipeline live-verified`)
> - ✅ Daily-Test-Canary: täglich-wiederkehrender bexio-Auftrag "IT Service Martini" testet die Pipeline jeden Morgen 08:00 CH end-to-end
> - 🟡 Verbleibende Phase-1-Items: 30-Tage-Live-Acceptance, automatisierter Restore-Test in CI, Cloudflare-Origin-Lock auf Hetzner-Firewall
>
> Tagesgeschäft + API-Patterns: siehe **`DEPLOYMENT.md`** (Operational Runbooks)
> und Project-Memory `project_coolify_resource_map.md` für UUIDs.

---

**Stand:** 2026-05-10. Alles davor ist abgeschlossene Buchhaltungs-Migration. Dieses Dokument beschreibt das **neue Projekt** — einen professionellen Recurring-Invoice-Bot, deployt auf Marcus' Coolify-Server.

---

## Wer ist Marcus?

- Schweizer/Liechtensteinischer Selbstständiger (Video, Webhosting, Multimedia)
- Buchhaltung in **bexio** (bexio.com — er schreibt es manchmal als „Baxio")
- Coolify-Server vorhanden
- Notion, Discord/Telegram, E-Mail als Kommunikationskanäle

---

## Ziel

Einen **professionellen Bot** bauen, der Marcus' wiederkehrende bexio-Rechnungen automatisch erstellt — sodass nichts vergessen geht.

**Marcus' Wunsch:** Er pflegt die wiederkehrenden Rechnungen in der **bexio-UI** (im Aufträge-Modul, mit Wiederholungs-Einstellung). Der Bot soll diese Aufträge per API lesen, prüfen welche heute fällig sind, und daraus automatisch Rechnungen erstellen.

**Bot-Tiefe:** Auto-Erstellung **+ Auto-Festschreiben** (issue) + Reminder für Versand. Marcus versendet immer manuell.

---

## 🚨 KRITISCHE SICHERHEITS-REGEL — Idempotenz statt Send-Verbot

**Aktualisiert 2026-05-10 (Office-Hours-Session):** Die ursprüngliche Regel "niemals senden" wurde aufgehoben. Begründung: damals lief eine parallele manuelle Migration, die zu Doppel-Sends geführt hätte. Heute ist der Bot die **einzige Quelle** für Recurring-Rechnungen, deshalb ist Doppel-Send technisch verhinderbar.

**Neue Regel: Bot darf senden — aber nur durch einen Idempotenz-Lock geschützt.**

**Erlaubte Endpoints für den Bot:**
- `POST /2.0/kb_invoice` (erstellen)
- `POST /2.0/kb_invoice/{id}/issue` (festschreiben)
- `POST /2.0/kb_invoice/{id}/send` (senden) — **NUR mit Idempotenz-Lock**
- `POST /2.0/kb_invoice/{id}/mark_as_sent` (intern markieren)

**Idempotenz-Lock — verpflichtend vor jedem `/send`:**

Bevor der Bot `/send` aufruft, prüft er einen lokalen State (z.B. `~/.bot-state/sent-{order_id}-{billing_period}.json` oder SQLite-Tabelle):
- Wenn Eintrag für `(order_id, billing_period)` existiert → STOP, log "already sent", überspringen.
- Wenn nicht → senden, dann State schreiben (atomic write).

**Der Idempotenz-State ist der eigentliche Schutz, nicht die API-Sperre.**

**Was bleibt absolut tabu:**
- Manuelles Senden derselben Rechnung neben dem Bot — der Bot ist die einzige Send-Quelle für wiederkehrende Rechnungen.
- Send für Erst-Rechnungen aus Nicht-Recurring-Aufträgen — Bot fasst nur Recurring an.

**Mahnungen dürfen ebenfalls gesendet werden** (siehe Schicht-2-Features unten).

Bei jedem API-Fehler: Stop, Status reporten, Marcus entscheiden lassen.

---

## Architektur-Vorgabe (mit Marcus abgestimmt)

```
Coolify Server
└── bexio-recurring-bot/
    ├── Repo auf GitHub/GitLab (Marcus deployt via Git-Push)
    ├── Cron-Schedule (täglich 08:00 lokal)
    ├── Multi-Channel-Notifications:
    │   - E-Mail an marcusmartini83@gmail.com
    │   - Notion-Task (Buchhaltungs-Inbox-DB)
    │   - Discord/Telegram (Quick-Glance)
    │   - Cowork-Chat-Webhook (falls möglich)
    └── Idempotenz: keine Doppel-Erstellung
```

**Workflow pro Lauf:**

1. bexio-Token refreshen (Refresh-Token-Flow)
2. `GET /2.0/kb_order` → alle Aufträge inkl. Wiederkehr-Flags
3. Pro fälligem Auftrag:
   - **Idempotenz-Lock prüfen:** existiert State für `(order_id, billing_period)`? Wenn ja → skip.
   - `POST /2.0/kb_invoice` (Rechnung aus Auftrag erstellen)
   - `POST /2.0/kb_invoice/{id}/issue` (festschreiben)
   - `POST /2.0/kb_invoice/{id}/send` (senden — geschützt durch Lock)
   - **State schreiben** (atomic): `(order_id, billing_period) → (invoice_id, sent_at)`
4. Notifications senden
5. Schicht-2-Features (Anomalien, Mahnwesen, Dashboard)

---

## Was bereits vorhanden ist

### bexio OAuth-Setup — WICHTIG: Eigener API-Key für den Bot

**Marcus erstellt für den Bot einen NEUEN, separaten OAuth-Client auf https://developer.bexio.com** — nicht den bestehenden Cowork-Client wiederverwenden!

Begründung:
- Trennung von Cowork-Migration und Coolify-Bot (Scope-Minimierung, Sicherheit)
- Bei Token-Leak ist nur ein Service betroffen
- bexio's API-Logs unterscheiden die zwei Clients

**Setup für den Bot-Client:**

1. Auf https://developer.bexio.com einen neuen App-Registrierung anlegen — Name z.B. „Recurring Invoice Bot (Coolify)"
2. **Redirect-URI**: muss zur Coolify-Domain passen, z.B. `https://bexio-bot.deine-domain.tld/oauth/callback` (oder lokal `http://localhost:8080/callback` für initialen Setup-Flow auf Marcus' Laptop)
3. **Scopes**, die der Bot braucht:
   - `openid` (Pflicht)
   - `offline_access` (Pflicht für langlebigen Refresh-Token)
   - `kb_order_show` (wiederkehrende Aufträge lesen)
   - `kb_invoice_edit` (Rechnungen erstellen + festschreiben + senden)
   - `contact_show` (Kunden-Kontaktdaten für Mahn-E-Mails — read-only)
   - **NICHT** `contact_edit`, `accounting`, etc. — minimal halten!

**Initialer OAuth-Flow** (einmalig, lokal auf Marcus' Maschine):

1. Authorize-URL bauen:
   ```
   https://auth.bexio.com/realms/bexio/protocol/openid-connect/auth
     ?response_type=code
     &client_id={NEW_BOT_CLIENT_ID}
     &redirect_uri={NEW_BOT_REDIRECT_URI}
     &scope=openid+offline_access+kb_order_show+kb_invoice_edit
     &state={zufällig}
   ```
2. Marcus klickt → meldet sich an → Callback-Code abfangen
3. Code gegen Access-Token + Refresh-Token tauschen (Token-Endpoint)
4. **Refresh-Token** in Coolify-Secrets ablegen (NICHT im Repo!)

Token-Endpoint: `https://auth.bexio.com/realms/bexio/protocol/openid-connect/token`

**Coolify-Secrets** (Environment Variables in der Coolify-UI einrichten):
```
BEXIO_BOT_CLIENT_ID
BEXIO_BOT_CLIENT_SECRET
BEXIO_BOT_REDIRECT_URI
BEXIO_BOT_REFRESH_TOKEN     ← rotiert bei jedem Refresh, irgendwo persistieren
```

Access-Token nicht als Secret — wird zur Laufzeit aus dem Refresh-Token frisch geholt (Cache im Container z.B. mit Ablaufzeit).

**❌ Nicht vom Cowork-Setup übernehmen:**

Die Werte in `E:\Dropbox\Buchhaltung\.env` (BEXIO_CLIENT_ID, BEXIO_CLIENT_SECRET, BEXIO_REFRESH_TOKEN) gehören dem Cowork-Buchhaltungs-Setup und sollen **nicht** im Bot landen. Die Datei kann der Bot ignorieren.

Authorize-URL-Template (Marcus muss klicken):
```
https://auth.bexio.com/realms/bexio/protocol/openid-connect/auth
  ?response_type=code
  &client_id={BEXIO_CLIENT_ID}
  &redirect_uri={BEXIO_REDIRECT_URI}
  &scope=openid+profile+offline_access+accounting+kb_invoice_edit+kb_bill_show+kb_order_show+contact_show
  &state={zufällig}
```

Token-Endpoint: `https://auth.bexio.com/realms/bexio/protocol/openid-connect/token`

### bexio API Konstanten

- API-Base: `https://api.bexio.com`
- user_id: 1 (Marcus)
- bank_account_id: 1 (UBS)
- currency_id: 1 (CHF)
- payment_type_id: 4
- mwst_type: 2 (Saldosteuer-Variante)
- mwst_is_net: true
- tax_id: 3 (UEX 0% — funktioniert bei POST kb_invoice; tax_id=null gibt 422)
- unit_id: 1 (Stk)

### bexio Konto-IDs (häufig genutzt)

| Konto-Nr | Name | API-ID |
|---|---|---|
| 1000 | UBS | 116 |
| 1002 | Kreditkarte (Aktiv) | 118 |
| 1100 | Forderungen | 113 |
| 1500 | Maschinen und Apparate | 131 |
| 2000 | Verbindlichkeiten | 107 |
| 2190 | Kreditkarte (Verbindlichkeit, **standardmässig genutzt**) | 135 |
| 2850 | Privatbezüge | 146 |
| 3200 | Hosting Ertrag | 101 |
| 3400 | Dienstleistungserlös | 148 |
| 4000 | Hosting-Aufwand | 153 |
| 6500 | Büromaterial | 185 |
| 6513 | Porti | 188 |
| 6600 | Werbeinserate | 192 |
| 6940 | Bankspesen | 197 |
| 6950 | Erträge Bankguthaben | 198 |

### Wichtige Kontakt-IDs

- 221 → Restaurant Vivid Anstalt Heiko Krüger
- 250 → Rolf Jeitziner
- 77 → Chiang Mai Thai Massage
- 546 → TV Rheintal GmbH
- 560 → Mordznacht
- 554 → AK Digital Media

### Hilfs-Skript für Token-Refresh

Liegt in `E:\Dropbox\Buchhaltung\migration\bexio_token.py` — kann als Vorlage für `bexio_client.py` im neuen Repo dienen. Implementiert:
- `.env` lesen mit CRLF-Bereinigung
- Token-Expiry prüfen (Safety-Margin 60s)
- Refresh-Token-Flow inkl. Refresh-Token-Rotation

### Migration-Doku (Kontext)

In `E:\Dropbox\Buchhaltung\migration\`:

- `MIGRATION_ABSCHLUSSBERICHT.md` — was bei der Infinity→bexio-Migration gemacht wurde
- `konto_mapping.md` — Konten-Übersicht
- `kreditkarten_2025/ABSCHLUSSBERICHT_KK2025.md` — 12 Monate Kreditkartenabrechnungen, 176 Buchungen
- `offene_klaerungen.md` — bekannte bexio-Anomalien (RE-00207 Doppel-Payment, RE-00208 Konto-Zuordnung, etc.)

---

## Offene Punkte / erste Schritte für Claude Code

1. **Stack klären mit Marcus** — was läuft schon auf Coolify? Welche Sprache bevorzugt? (Python wäre naheliegend wegen vorhandenem `bexio_token.py`, Node.js auch fine)
2. **Repo aufsetzen** auf GitHub/GitLab (Marcus deployt per Git-Push)
3. **OAuth-Scope erweitern** — Authorize-URL mit `kb_order_show` generieren, Marcus autorisiert einmal
4. **bexio kb_order Datenmodell erkunden** — Marcus legt einen Test-Wiederkehr-Auftrag in der bexio-UI an, dann via API lesen und schauen welche Felder bexio für Wiederholung verwendet (`is_recurring`, `repetition_unit`, `next_due_date`, etc. — bisher unklar)
5. **Engine-Logik** bauen: Recurrence-Pattern interpretieren, Fälligkeit prüfen, kb_invoice POST mit `kb_position_custom`-Items
6. **Notification-Service** — Discord/Telegram-Webhooks, SMTP-Mail, Notion API, Cowork-Webhook
7. **Idempotenz** über State-Datei oder Datenbank
8. **Coolify-Cron** einrichten — täglich 08:00 lokal
9. **Logging** strukturiert (JSON-Lines z.B.) für Coolify-Logs
10. **Health-Check-Endpoint** falls Coolify das erwartet

---

## Bekannte bexio-Eigenheiten

Aus Migrations-Erfahrung:

- **POST kb_invoice** verwirft `unit_name` und `is_optional` als Felder bei Positionen → weglassen!
- **`tax_id: null`** wird abgelehnt → immer `tax_id: 3` (UEX 0%) für Marcus' Saldosteuer
- **`reference_nr`** beim Payment-POST nicht erlaubt → weglassen
- Datums-Format: nur `YYYY-MM-DD`, niemals `DD.MM.YYYY` oder `YYYY.MM.DD`
- bexio-`/2.0/kb_invoice?ids=X` filtert nicht — gibt immer Element 1 zurück. Stattdessen alle holen und client-side filtern.
- Refresh-Token rotiert bei jedem Refresh — neuer Token muss zurück in .env/Vault.
- `mark_as_sent` setzt nur den Status, sendet nichts. `send` würde tatsächlich senden — TABU.

---

## Ziel-Notifications-Templates (Inspiration)

```
📋 bexio Recurring — Lauf YYYY-MM-DD

✅ Erstellt + festgeschrieben:
  • RE-XXXXX | Restaurant Vivid | Resmio Mai 2026 | 189,00 CHF
  • RE-XXXXX | Hotel Schatzmann | Hosting Q2 | 350,00 CHF

📅 Erinnerung (manuell):
  • TV Rheintal: Beiträge im April zählen → Sammelrechnung erstellen

⚠️ Versand fällig:
  • RE-XXXXX (siehe oben) — bitte in bexio versenden
```

---

Dieses Dokument ist live, falls du Sachen ergänzen willst.
