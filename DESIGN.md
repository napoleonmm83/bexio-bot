# DESIGN.md — bexio-bot

Internal solo-user tool. Calm surface hierarchy, App-UI not marketing page.
Reference mockup: `~/.gstack/projects/bexiobot/designs/dashboard-phase1-20260510/mockup.html`.

## Voice

Utility language only. German UI labels. No marketing copy, no branding,
no logo, no mood statements. Headlines describe state or action: "Heute
erstellt", "Letzter Lauf erfolgreich vor 4 Stunden", "Fällig diese Woche".

## Color Tokens

```css
/* Dark (default) */
--bg:        #0b0d10;
--surface:   #11141a;
--surface-2: #161a22;
--border:    #1f2530;
--text:      #e8ebf0;
--text-2:    #98a2b3;
--text-3:    #6b7484;

/* Accent (one only) */
--accent:    #4f8cff;

/* Semantic status */
--ok:    #22c55e;
--warn:  #f59e0b;
--err:   #ef4444;

/* Light variant via prefers-color-scheme:
   --bg: #fafbfc; --surface: #ffffff; --surface-2: #f4f6f8;
   --border: #e3e7ed; --text: #0b1320; --text-2: #4a5568;
   --text-3: #8b95a4; --accent: #1f5cd8; */
```

Rules:
- One accent. Never use accent for body text.
- Never purple/violet/indigo. Never gradients on backgrounds.
- Status indicators always use --ok / --warn / --err with a faint glow halo
  (`box-shadow: 0 0 0 4px rgba(<color>, 0.12)`).

## Typography

```css
--sans: 'Inter', system-ui, sans-serif;
--mono: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace;
```

- Body 14px / 1.5
- Status text 17px (the one slightly larger thing)
- Section labels 12px UPPERCASE letterspacing 0.08em color --text-3
- Tables 14px
- Meta-rows 12px in --mono
- Amounts always in --mono with `font-variant-numeric: tabular-nums`

Never `system-ui` as primary. Inter is required.

## Spacing Scale

Multiples of 4: 4, 8, 12, 16, 20, 24, 28, 32, 40.

- Page max-width 1080px, padding 28px 32px 40px
- Section gap 32px (sidebyside) / 40px (vertical)
- Table cell padding 12px 0
- Avoid uniform large border-radius. Only the status indicator (50%) uses radius.

## Components

### Status indicator

```html
<span class="indicator ok"></span>
```

- 10px circle, 50% radius
- Halo `box-shadow: 0 0 0 4px rgba(<color>, 0.12)`
- Variants: `.ok`, `.warn`, `.err`

### Status row

Single line: `<indicator> + bold text + secondary muted text`. Visible
in 1 second. Always answer "did the run succeed?".

### Data table

- No outer border. Header row has `border-bottom: 1px solid --border`.
- Each row has `border-bottom: 1px solid --border`. Last row no border.
- Headers 12px in --text-3 lowercase weight 400.
- Right-align `<th>` and `<td>` for amounts and time-ago columns.
- Hover state on rows: `background: var(--surface-2)`, cursor pointer when clickable.
- Meta-rows beneath the primary cell value, in --mono 12px --text-3.
- No card-mosaic. No `border-left: 3px solid <accent>` cards.

### Badge

Inline tag for status info inside meta-rows. Format: small dot + label.
Variants: default (ok), `.warn`. Color follows semantic status.

### Disclosure section

Collapsible block with summary header and counter, expanded body.
Used for "Auftrags-Verwaltung" (admin tasks shown rarely, not in scan path).

```html
<details class="disclosure">
  <summary>
    <span class="label">Verfügbar in bexio</span>
    <span class="counter">2</span>
  </summary>
  <table>...</table>
</details>
```

- Summary uses --text-3, 12px UPPERCASE 0.08em letterspacing
- Counter is --mono, --accent on hover
- Closed-state height: 32px; expansion is no animation
- Body table follows the standard data-table component
- Default state: collapsed. The user opts in to seeing admin lists.

### Toggle button

Inline action button in admin tables. Replaces row-click navigation for
mutation actions.

```html
<button class="toggle activate">Aktivieren</button>
<button class="toggle pause">Pausieren</button>
```

- 28px height, 12px horizontal padding, 4px radius (the only small radius in the system)
- Border 1px solid --border, background transparent
- `.activate` hover: border-color --accent, color --accent
- `.pause` hover: border-color --warn, color --warn
- Disabled state during in-flight POST: opacity 0.5, cursor not-allowed
- After successful toggle: row fades out of source table, fades into destination table
  (no full page reload — use SvelteKit `enhance` action for progressive enhancement)
- POST endpoint: `/orders/:id/toggle` with `{ "enabled": true|false }`
- Form has hidden `<input type="hidden" name="csrf" value="{{ token }}">` for SvelteKit's CSRF check

### Footer

Plain horizontal list separated by middle dots. --mono 12px. Used for
sub-actions and runtime info (Coolify health, version, sync time).

## Hard No

- Cards in any decorative role. Cards only when a card IS the interaction.
- Emoji anywhere in production UI (warm Empty-States use plain text).
- 3-column feature grid as a layout pattern.
- system-ui as primary font.
- Purple/violet/indigo gradients. Single-color flat backgrounds with no
  composition above them.
- Centered alignment as default. Tables left-align labels, right-align numbers.
- Icons in colored circles ("SaaS starter template look").
- Decorative blobs, floating shapes, wavy SVG dividers.
- Generic hero copy ("Welcome to bexio-bot", "Unlock the power of...").

## Responsive

Single breakpoint at 720px. Below it:
- Two-column data section collapses to single column with 24px gap
- Footer wraps with `flex-wrap: wrap`
- Page padding reduces to 20px 16px

Touch targets minimum 44px when row is clickable (mobile UA detection).

## Accessibility

- Body text contrast minimum 4.5:1 against --bg
- All interactive elements keyboard-focusable; focus ring uses `--accent` outline 2px offset 2px
- Status conveyed not just by color: "Letzter Lauf erfolgreich" / "Letzter Lauf failed" — text describes state
- ARIA landmarks: `<header>`, `<main>`, `<footer>`. Tables get `<caption>` (visually hidden) describing what they show.
- HTTP-Basic-Auth handled by Coolify proxy: this app trusts the upstream user.
