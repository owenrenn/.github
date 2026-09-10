# AGENTS.md — owenrenn/.github

GitHub's user-level default community-health repo, and — since #469 — the home of
the fleet's **reusable workflows**.

## What lives here and why

| Path | Purpose |
|---|---|
| `SECURITY.md` | Default security policy inherited by every `owenrenn/*` repo (#251). |
| `.github/workflows/card-shark-sync.yml` | **Reusable**. Keeps Card Shark membership in sync with `pm:*` labels across the fleet, **and mirrors Track / Priority / Engagement at the same moment** (#849). |
| `scripts/card-shark-sync/` | Pure decision logic for the above (`sync.js` = membership, `fields.js` = field derivation), plus their `node --test` suites. |
| `.github/workflows/autoclose-guard.yml` | **Reusable**. Warns when a PR's stated closing set and GitHub's computed one disagree — in either direction — or when a close was registered only by a keyword **mid-sentence** rather than a line-leading `Closes #N` (#911). Advisory; never blocks. |
| `scripts/autoclose-guard/` | Pure decision logic for the above, plus its `node --test` suite. |
| `actions/publish-update-feed/` | **Composite action.** Uploads release payloads + an optional manifest to S3-compatible object storage, then verifies the feed from the public URL a client reads. |
| `.github/workflows/tests.yml` | This repo's CI: the `node --test` suite, plus the structural check that every workflow here parses and every job carries `timeout-minutes` (#587). |

## Calling the Card Shark sync

The stub lives in the operations repo's template; only its **interface** is documented here.

| Input | Required | Default | Meaning |
|---|---|---|---|
| `audience` | yes | — | `pm-surface` (every issue auto-flows) or `agent-zone` (escalation only) |
| `track` | no | `Personal` | The board Track for items from this repo — `Work` or `Personal` |

⚠️ **`track` is an input rather than a lookup, and that is a content-policy
consequence, not a preference.** Track follows from which repo an item came from, and
the work-track repositories are private — GitHub returns `404` for those to an anonymous
caller and will not confirm they exist, so a work-repo list in this public repo would
answer a question the platform declines to answer (see § The content rule). The generic
rule lives here; the private datum stays in the private caller's own workflow file.

⚠️ **An unrecognised value is DROPPED, not written.** This repo cannot see the board's
option list, so writing an arbitrary string would fail at the API with "no such option" —
which reads nothing like the real cause, a typo in a caller's workflow input.

⚠️ **The field mirror covers relabelling, not just creation, and needs no extra trigger.**
`decideAction` returns `add` for any `labeled` event on an issue that *currently* carries a
`pm:*` label, so applying a lane label to an item already on the board routes through the
same path — and the add mutation returns the existing item id rather than erroring. That
property is load-bearing; see the `#563` reasoning in `sync.js` for why deciding from
current state rather than the event's label is what makes it hold.

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

## Calling the update-feed publisher

A self-updating client's healthy idle state is **silence**, so a feed that was never
published looks exactly like a feed with nothing new — indefinitely. This action exists
to convert each of those silences into a red run. One product in this fleet shipped a
completely dead updater through eight releases before anyone asked.

⚠️ **It is a composite action, not a reusable workflow — a `steps:` entry, not a
`jobs:` entry.** That is deliberate and not stylistic: the files being published live in
the **calling job's workspace**. A reusable workflow runs as its own job on its own
runner and would need the entire payload — often >100 MB — round-tripped through
workflow artifacts to see them, against a free-tier quota that is easy to exhaust.

```yaml
      # Runs INSIDE the build job, after the artifacts exist and BEFORE any
      # release is published. Ordering matters: publishing a release first would
      # announce a version the feed cannot yet serve.
      - uses: owenrenn/.github/actions/publish-update-feed@main
        with:
          bucket:            example-bucket
          prefix:            example-product/linux/x64
          base-url:          https://cdn.example.test/example-product/linux/x64
          source-dir:        out/dist
          payload-glob:      "*-full.pkg"
          manifest:          MANIFEST          # omit entirely for a plain file drop
          endpoint-url:      https://api.example.test
          access-key-id:     ${{ secrets.STORAGE_ACCESS_KEY_ID }}
          secret-access-key: ${{ secrets.STORAGE_SECRET_ACCESS_KEY }}
```

**Every identifier is a required input with no default, and that is a consequence of the
content rule below, not an ergonomic oversight.** A default here would publish an
inventory of private surfaces to anonymous readers. Do not add one.

### What the caller still owns

⚠️ **Serialize your release runs.** This action cannot protect a feed from a *second
run of itself*. Two release runs that overlap will both upload, and a loser finishing its
manifest after a winner's payload leaves the manifest naming a payload-hash no stored
object has — clients then reject every update while the feed looks fully populated. That
is not theoretical: a tag delete + re-push produced two runs seconds apart on the rollout
that motivated this action. Callers need:

```yaml
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false   # cancelling mid-upload is the one way to tear a feed on purpose
```

⚠️ **Budget one hand-delivered build whenever the endpoint changes.** An installed client
uses the URL compiled into it and cannot be retargeted remotely, so the first build
carrying a new feed address must be installed by hand — the update mechanism is the one
component that cannot fix itself. That build should carry everything else pending.

⚠️ **The bucket name is written in at least three places nothing compares**: this stub,
the bucket itself, and the storage credential's scope. A disagreement surfaces as
`AccessDenied`, which reads as a permissions problem and sends you to the wrong screen.

**Verify it live rather than trusting the merge** — same discipline as the guard above.
The action's own read-back is the check that proves domain, bucket binding and prefix
agree, so a green run of it is real evidence. A green *build* is not.

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
