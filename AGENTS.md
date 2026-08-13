# AGENTS.md — owenrenn/.github

GitHub's user-level default community-health repo, and — since #469 — the home of
the fleet's **reusable workflows**.

## What lives here and why

| Path | Purpose |
|---|---|
| `SECURITY.md` | Default security policy inherited by every `owenrenn/*` repo (#251). |
| `.github/workflows/card-shark-sync.yml` | **Reusable**. Keeps Card Shark membership in sync with `pm:*` labels across the fleet. |
| `scripts/card-shark-sync/` | Pure decision logic for the above, plus its `node --test` suite. |

## The constraint that shapes everything here

**This repo is public; the fleet canon is not.** The operations repo's `labels.json`
and `fleet.json` are unreachable from here. So no code here may derive its rules from
canon — where a rule must be duplicated, duplicate it in the **wider** direction (e.g. a
`pm:` prefix test rather than an enumerated label set) and name the divergence in a
comment.

Never put a credential here. The project ID in `card-shark-sync.yml` is an identifier,
not a secret; the PAT arrives via the caller's `secrets: inherit`.

## Working here

- Branch `feat/issue-NNN-*` / `fix/issue-NNN-*`; PR to `main`; never commit to `main`.
- Issues are filed in **the operations repo**, not here — this repo is not on the Card
  Shark roster.
- ⚠️ **No fleet scanner watches this repo** — it is not in the operations repo's fleet
  manifest. Tracked as #473.
- Run `node --test scripts/card-shark-sync/*.test.js` before pushing.
- Bare `#N` issue references in this repo point to the private operations repo — an
  authenticated reader with access to that repo can resolve them to find full canon.
