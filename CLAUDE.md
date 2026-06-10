<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.

## MCP Tools: supermemory (persistent cross-session memory)

This project uses the **supermemory** MCP server for durable memory that survives
across sessions. Scope every project memory with container tag **`bexio-bot`**.
Only two tools are valid: `memory` (action `save` / `forget`) and `recall` — ignore
any other memory/recall variant.

**Recall first.** Before substantive work — planning, debugging, deploying, or
answering a non-trivial question — call `recall` (query + `containerTag: "bexio-bot"`)
to pull prior decisions, constraints, and gotchas. Don't re-derive what's already known.

**Save proactively** with `memory` (`save`, `containerTag: "bexio-bot"`) whenever:
- Marcus states a durable preference, constraint, or decision.
- A non-obvious gotcha or fix surfaces (infra quirk, API trap, deploy step).
- A milestone ships — what changed, the commit SHA, what's verified, what's pending.

Write each memory self-contained (enough context to be useful months later; one
coherent fact or event per save). `recall` before saving to avoid duplicates; use
`forget` when something becomes outdated or wrong. Don't save what the code, git
history, or this CLAUDE.md already records — capture the non-obvious *why* and the
operational knowledge that isn't derivable from the repo.

## Live deployment

**Status: production (since 2026-05-11).**

- **Web**: https://bexio-bot.martini.digital — SvelteKit, behind Cloudflare Access (One-Time-PIN to `marcusmartini83@gmail.com`).
- **Worker**: idle host on Coolify, runs daily via `Scheduled Task` `0 6 * * *` UTC (08:00 CH summer / 07:00 winter).
- **DB**: shared Postgres on Coolify, daily `pg_dumpall` to S3 (verified). DB name `bexiobot`, user `bexiobot`.
- **Build/deploy**: Coolify pulls from `napoleonmm83/bexio-bot` (private GitHub repo) via SSH deploy key. Auto-deploy on push is OFF — trigger manually via API.
- **OAuth**: Production redirect URI is `https://bexio-bot.martini.digital/callback` (single-segment path, multi-segment `/auth/bexio/callback` rejected by bexio's validator). Local dev still uses `http://localhost:8080/callback` via `bun run oauth-setup`.
- **Daily QA canary**: a `daily`-recurring bexio order ("IT Service Martini") triggers a full pipeline run every 08:00 CH. If anything breaks, it surfaces within 24h instead of waiting for a monthly recurring to fire.

Coolify resource UUIDs (web app, worker, postgres, scheduled task, deploy key, CF Access app) live in
project memory under `project_coolify_resource_map.md` — load it before any Coolify API call to skip
the 5+ discovery roundtrips.

API quirks worth knowing before touching Coolify (env-vars dupe on retry, no exec endpoint, scheduled
tasks need a long-running container, server is UTC) are documented in
memory under `reference_coolify_api_quirks.md`.

Coolify API token: `.env.local` → `COOLIFY_API_TOKEN`. Base URL `https://coolify.martini.digital/api/v1/`.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
