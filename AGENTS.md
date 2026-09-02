# AGENTS.md — owenrenn/.github

GitHub's user-level default community-health repo, and — since #469 — the home of
the fleet's **reusable workflows**.

## What lives here and why

| Path | Purpose |
|---|---|
| `SECURITY.md` | Default security policy inherited by every `owenrenn/*` repo (#251). |
| `.github/workflows/card-shark-sync.yml` | **Reusable**. Keeps Card Shark membership in sync with `pm:*` labels across the fleet. |
| `scripts/card-shark-sync/` | Pure decision logic for the above, plus its `node --test` suite. |
| `.github/workflows/autoclose-guard.yml` | **Reusable**. Warns when a PR's stated closing set and GitHub's computed one disagree — in either direction. Advisory; never blocks. |
| `scripts/autoclose-guard/` | Pure decision logic for the above, plus its `node --test` suite. |
| `.github/workflows/tests.yml` | This repo's CI: the `node --test` suite, plus the structural check that every workflow here parses and every job carries `timeout-minutes` (#587). |

## Calling the auto-close guard

Drop this in a consuming repo as `.github/workflows/autoclose-guard.yml`:

```yaml
name: auto-close guard
on:
  pull_request:
    # `edited` catches a body change that adds a closing keyword — that is most
    # of this guard's value, not a multiplier to trim.
    types: [opened, edited, reopened, ready_for_review]

# ⚠️ REQUIRED, and the easiest thing to leave out. A called workflow cannot
# exceed the CALLING workflow's token permissions, and these repos default that
# token to READ-ONLY. Omit this block and the guard parses, runs, and dies at the
# comment write — green in every structural check, silent in production.
permissions:
  pull-requests: write
  issues: read
  contents: read

jobs:
  guard:
    uses: owenrenn/.github/.github/workflows/autoclose-guard.yml@main
```

Nothing else is needed — no vendored script, no secret. The guard uses the
caller's own `GITHUB_TOKEN`.

⚠️ **Verify it live rather than trusting the merge.** A workflow can parse, pass
every structural check, merge green and never run correctly. The PR that adds the
stub is itself a `pull_request` event, so it exercises the guard on arrival —
check that run before assuming the wiring holds.

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
is not a file. So the rules above apply to a commit subject and a PR title verbatim, and
**when you rename what this repo is, check the description too** — it is the surface a
visitor reads first and the one no diff will ever show you.

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
- ⚠️ **No fleet scanner watches this repo.** ⚠️ **Not because it is absent from the
  operations repo's fleet manifest — it is listed there.** The manifest is *declared*; what
  scanners walk is *derived* from it, and the derivation drops the user- and org-level
  community-health repos as infrastructure before anything else is read. So the manifest row
  exists and is inert, including the audience it declares: none of the audience semantics
  described above ever run against this repo. Adding or editing that row changes nothing —
  the filter is a layer below it. Tracked as #473.
- Run `node --test scripts/card-shark-sync/*.test.js` before pushing.
- ⚠️ **A bound set here is the fleet's only bound.** A caller job that invokes a
  reusable workflow with `uses:` cannot carry `timeout-minutes` — GitHub permits only
  `name`/`uses`/`with`/`secrets`/`needs`/`if`/`permissions` on it — so every stub in the
  fleet inherits its ceiling from the job in `card-shark-sync.yml`. The operations repo's
  own workflow guard walks its own directory and **cannot see this one**, which is why the
  assertion lives in `tests.yml` here instead (#587). Don't move it back.
- Bare `#N` issue references in this repo point to the private operations repo — an
  authenticated reader with access to that repo can resolve them to find full canon.
