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

### The content rule — "no credentials" is not the whole of it

Never put a credential here. That much is obvious, and it is **not the rule that actually
binds.** This repo is public *by necessity* — a reusable workflow must be public to be
callable from another organization — so everything committed here is published, including
comments, test fixtures, and prose that would be unremarkable in a private repo.

**Do not publish what the platform withholds.** GitHub returns `404` for a private
repository to an anonymous caller: it will not even confirm the repo exists. Naming those
repositories here does better than that, and defeats it. So:

- Name **roles**, not repositories — "an agent-zone repo", "the operations repo", "a
  caller". Never the actual name.
- Keep the **mechanism**, drop the **incident**. *"`secrets: inherit` does not traverse
  organizations"* is the durable lesson and belongs in the comment. *Which* repo it was
  measured on is incidental, and is the part that leaks.
- Test fixtures use synthetic names (`example-org`, `example-repo`). A fixture is
  arbitrary data, so real names buy nothing and disclose an inventory.
- Quote magnitudes, not counts. "Several hundred board items", not the exact figure.
- Issue references are bare `#N` and point at the private operations repo. A reader with
  access can follow them; a reader without learns nothing from the number.

**The publish surface is not only the files.** The repo **description**, commit messages,
branch names and PR titles are all served to an anonymous visitor, and a scrub of file
contents cannot see any of them — which is exactly how they were missed. PR #3 cleaned
every tracked file and held; a 2026-08-15 sweep still found the operations repo named in
both `.github` repos' descriptions and in eleven of sixteen commit messages — two of them
being the scrub commits themselves, which name it while describing why it should not be
named. That is the trap in miniature: the pass was scoped to files, and a commit message
is not a file. So the rules above
apply to a commit subject and a PR title verbatim, and **when you rename what this repo
is, check the description too** — it is the surface a visitor reads first and the one no
diff will ever show you.

Commit history is the one place the rule is applied going *forward* only: rewriting it
means force-pushing `main`, which every fleet caller resolves `card-shark-sync.yml@main`
against. Not worth it to scrub a name already disclosed elsewhere. Write the next subject
correctly instead.

**The one deliberate exception** is the project ID in `card-shark-sync.yml`. It is a
handle, not a key — verified 2026-08-13: an unauthenticated GraphQL request carrying it
returns `403`, and an authenticated one still requires authorization on the project
itself. It stays because the workflow cannot resolve the board without it. If that ever
becomes removable at reasonable cost, remove it: it is the last thing here that confirms
a private surface exists.

The PAT is forwarded explicitly by each caller, never via `secrets: inherit` — see the
stub comment for why.

## Working here

- Branch `feat/issue-NNN-*` / `fix/issue-NNN-*`; PR to `main`; never commit to `main`.
- Issues are filed in **the operations repo**, not here — this repo is not on the Card
  Shark roster.
- ⚠️ **No fleet scanner watches this repo** — it is not in the operations repo's fleet
  manifest. Tracked as #473.
- Run `node --test scripts/card-shark-sync/*.test.js` before pushing.
- Bare `#N` issue references in this repo point to the private operations repo — an
  authenticated reader with access to that repo can resolve them to find full canon.
