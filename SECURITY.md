# Security

## Register

Every security finding is a GitHub issue with the label `security`.
Accepted risks are closed with the additional label `risk-accepted` and a
written reason — so the next audit does not rediscover them as new.

Each issue states: severity, how to verify it (command/probe), deadline.

## Severity and deadlines

| Severity | Deadline |
|---|---|
| critical | same day (hotfix) |
| high | 7 days |
| moderate | 30 days or next release |
| low | collected, fixed with the next major upgrade |

## Automation

- CI (`.github/workflows/ci.yml`) fails on any **high/critical** `bun audit` advisory.
- Dependabot opens weekly update PRs (minor/patch grouped).

## Cadence

- Quarterly follow-up audit, starting from the open `security` issues.
- Targeted review before any larger change to auth, OAuth (`/callback`) or `/mcp`.
