# AGENTS.md — owenrenn/.github

GitHub's user-level default community-health repo, and — since
[owen-ops#469](https://github.com/owenrenn/owen-ops/issues/469) — the home of the
fleet's **reusable workflows**.

## What lives here and why

| Path | Purpose |
|---|---|
| `SECURITY.md` | Default security policy inherited by every `owenrenn/*` repo ([owen-ops#251](https://github.com/owenrenn/owen-ops/issues/251)). |
| `.github/workflows/card-shark-sync.yml` | **Reusable**. Keeps Card Shark membership in sync with `pm:*` labels for all 20 fleet repos. |
| `scripts/card-shark-sync/` | Pure decision logic for the above, plus its `node --test` suite. |

## The constraint that shapes everything here

**This repo is public; the fleet canon is not.** `owen-ops/.github/labels.json` and
`fleet.json` are unreachable from here. So no code here may derive its rules from canon —
where a rule must be duplicated, duplicate it in the **wider** direction (e.g. a `pm:`
prefix test rather than an enumerated label set) and name the divergence in a comment.

Never put a credential here. The project ID in `card-shark-sync.yml` is an identifier,
not a secret; the PAT arrives via the caller's `secrets: inherit`.

## Working here

- Branch `feat/issue-NNN-*` / `fix/issue-NNN-*`; PR to `main`; never commit to `main`.
- Issues are filed in **owen-ops**, not here — this repo is not on the Card Shark roster.
- ⚠️ **No fleet scanner watches this repo** — it is not in `owen-ops/.github/fleet.json`.
  Tracked as [owen-ops#473](https://github.com/owenrenn/owen-ops/issues/473).
- Run `node --test scripts/card-shark-sync/*.test.js` before pushing.
