# AGENTS.md — owenrenn/.github

GitHub's user-level default community-health repo, and the home of the fleet's
**reusable workflows** (#469).

## What lives here and why

Each workflow, action and script opens with a header comment that carries its design and
reasons; read it before changing the file. This table is only the map.

| Path | Purpose |
|---|---|
| `SECURITY.md` | Default security policy inherited by every `owenrenn/*` repo (#251). |
| `.github/workflows/card-shark-sync.yml` + `scripts/card-shark-sync/` | **Reusable.** Keeps Card Shark membership in sync with `pm:*` labels and mirrors Track / Priority / Engagement (#849). |
| `.github/workflows/autoclose-guard.yml` + `scripts/autoclose-guard/` | **Reusable.** Fails when what a PR *declares* it closes differs from what GitHub *registered* (#942). **Never a required check.** |
| `.github/workflows/fleet-checks.yml` + `scripts/fleet-checks/` | **Reusable.** The changelog fragment check and the dead-path ratchet (#1561). ⚠️ **The scripts are published here byte for byte from the operations repo by its `publish.sh`. Never hand-edit them here**: the next publish erases the edit. |
| `.github/workflows/dependabot-merge.yml` + `scripts/dependabot-merge/` | **Reusable.** Merges a Dependabot patch or minor update once its required checks pass and the autonomy switch (issue #40 here) reads clear (#1685). Nothing is armed: no repo turns on native auto-merge. |
| `guard-own-prs.yml`, `fleet-checks-own-prs.yml` | **This repo's own callers** (#911, #1561): `uses: ./…` plus `logic_ref: github.sha`, so a PR that changes a check runs its own workflow and logic on itself. A fleet caller omits `logic_ref` and runs `main`. |
| `actions/publish-update-feed/` | **Composite action.** Uploads release payloads and an optional manifest to S3-compatible storage, then verifies the feed from the URL a client reads. |
| `.github/workflows/tests.yml` | This repo's CI: the suites, every workflow parses, every job is bounded (#587), every `logic_ref` body has an own-PR caller. |

## Universal rules — one hop up

Every rule that applies to the whole fleet lives in **one** file, loaded by Claude Code as
`~/.claude/CLAUDE.md` and tracked in the operations repo at `config/claude/global-CLAUDE.md`.
Read it before working here; this file never restates it. Another agent (Codex, Copilot,
Cursor) fetches it with its own authenticated `gh`:

```bash
gh api repos/<the operations repo>/contents/config/claude/global-CLAUDE.md --jq .content | base64 -d
```

⚠️ **The operations repo is named by role here, never by slug** (§ The content rule). Do not
paste the fleet template's linked form of this section: it carries the private slug.

Fleet standards (changelog, release doc, CI gate, security baseline, git flow) live in the
engineering knowledge base's `conventions/`, starting at `repo-engineering-standards.md`.

## Audience

**`agent-zone`**, as this repo's row in the operations repo's fleet manifest declares, and
**escalation-exempt**: it carries no Card Shark stub and takes no issues, so the global file
§ Audience model + Card Shark routing does not run against it. **File issues in the
operations repo.**

⚠️ **One fleet scanner reads this repo, and it reads files only.** The conformance scan
covers it with the stub, `pm:*` label and PAT checks skipped (#519), so its green row says
the files are in order and nothing more. No workflow-health signal watches this repo, and
none could: a reusable-workflow run is attributed to its **caller** (#473).

## Session plan

This repo's next-session plan is `handoff/next.md` on its own `handoff` branch: `git fetch origin handoff && git show origin/handoff:handoff/next.md` (a missing branch means no plan yet). It is published with the operations repo's `scripts/handoff/publish.sh <file> -m "close-out …" --repo owenrenn/.github`.

## Calling the Card Shark sync

The stub lives in the operations repo's template; only its **interface** is documented here.

| Input | Required | Default | Meaning |
|---|---|---|---|
| `audience` | yes | — | `pm-surface` (every issue auto-flows) or `agent-zone` (escalation only) |
| `track` | no | `Personal` | The board Track for items from this repo — `Work` or `Personal` |
| `runner` | no | `ubuntu-latest` | The runner label the job lands on. Omit it for a GitHub-hosted runner |

- ⚠️ **`runner` is for a caller with a self-hosted runner of its own**, an input so the choice
  is visible in the caller's file. Passing nothing changes nothing. The guard and the fleet
  checks take the same input.
- ⚠️ **`track` is an input, not a lookup, because of the content rule**: the work-track repos
  are private, so their list stays in the private caller's own file.
- ⚠️ **An unrecognised value is DROPPED, not written**: this repo cannot see the board's option
  list, and "no such option" would hide the real cause, a typo in the caller.
- ⚠️ **The field mirror covers relabelling with no extra trigger**, because `decideAction`
  decides from the issue's *current* labels. Load-bearing; the reasoning is in `sync.js` (#563).
- The PAT is forwarded explicitly by each caller, never via `secrets: inherit`; the stub's
  comment says why.

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

Nothing else is needed: no vendored script, no secret. The guard uses the caller's own
`GITHUB_TOKEN`. Pass `runner` under `with:` only for a self-hosted runner.

⚠️ **Verify it live rather than trusting the merge**: the PR that adds the stub runs the guard
on arrival, so check that run. ⚠️ That is an `opened` run, when `closingIssuesReferences` can
still read empty; the guard re-reads until it settles (#916), so an OK there can be believed,
and a body that really disagrees takes ~20s longer.

### What a red guard means, and what a caller must not do with it

⚠️ **The guard fails the job when declared and registered disagree (#942)**, so the finding
sits on the status surface; the PR comment explains it.

| The body declares | GitHub registered | Result |
|---|---|---|
| nothing | nothing | pass, with no ceremony |
| nothing | an open issue | **fail** — an accidental close (a mid-sentence keyword, a negation, a sidebar link) |
| `Closes #N` | nothing | **fail** — a close that will not fire, or has not registered yet |
| `Closes #N` | `#N` | pass |
| `Closes #N` | `#N` and another | **fail** — closes more than declared |

- **Do not add it to a caller's required checks.** It never holds a merge; a caller that
  asserts its required set should assert this job is absent from it.
- **An "unregistered so far" failure on a well-formed PR is usually lag**, sometimes for hours.
  Re-check, and close the issue by hand after merge if it did not fire.
- **A red row does not clear by itself**: a late registration or a removed sidebar link fires
  no event the guard runs on. Edit the body or re-run the job.
- **A close declared in ANOTHER repository is judged if the guard can read that issue, and
  only reported if not.** Its caller's token never sees a registration in another private
  repository (measured, #1167), so there the author confirms with their own token. ⚠️ Such a
  PR also waits out the whole settle window.
- **Declared means a closing keyword on a line of its own, and nothing else.** A list chains
  only on one line (`Closes #1, #2` declares both and fails: GitHub registers the first). A
  fenced block or a closed HTML comment is an example; GitHub registers nothing in an HTML
  comment (measured, #1167). An unread form that GitHub registers fails as *undeclared*, the
  safe direction. Full grammar: `predicate.js`.
- **Not covered:** a closing keyword in a commit message folded into a squash merge, which
  registers after every check has run.

## Calling the fleet checks

Drop this in a consuming repo as `.github/workflows/fleet-checks.yml`:

```yaml
name: fleet checks
on:
  pull_request:
    # `edited` is what re-runs the check when a `Changelog: none` line is added to the body.
    types: [opened, edited, synchronize, reopened, ready_for_review]
permissions:
  contents: read
# A newer run for the same PR cancels this whole run, not only its `checks` job (#1666).
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  checks:
    uses: owenrenn/.github/.github/workflows/fleet-checks.yml@main
```

⚠️ **Keep the stub's `concurrency:` block, above all in a caller with its own gate job** (one
reading `needs.checks.result` under `if: always()`): opening a PR and editing its body starts
two runs on one SHA, and without it the older run's gate reads `cancelled` and fails red beside
the newer green one (#1666). The group name must differ from the shared job's
(`fleet-checks-<repo>-<PR>`); the same name at both levels deadlocks the run.

⚠️ **`edited` is required in the stub's `types:`**, or adding the opt-out line never re-runs
the check.

The shared body installs Node, so a repo in any language needs nothing else. Two optional
files in the caller shape the checks:

- `.github/fleet-checks.json`: release **streams** (none declared: one stream, `v*`, every
  path), dead-path **exemptions** with a `why`, and **`foreignNames`**. Unknown keys are
  refused. Schema: the header of `config.js`.
- `.github/dead-paths-baseline.json`: each file's dead targets at adoption. **Write it with the
  CLI, never by hand**: `node <checkout of this repo>/scripts/fleet-checks/cli.js dead-paths --write-baseline`.

**A fragment**, one per PR, at `changelog.d/<issue>-<slug>.md`:

```markdown
---
type: fixed          # added | changed | fixed | removed
ships: desktop       # a stream name, a list, `all`, or `both`; required only with two or more streams
---
The panel reconnects after the machine wakes.
```

- **No fragment is ever assembled into a committed file.** Its release is the first tag of each
  stream's prefix containing the commit that added it. `cli.js changelog release <tag>` renders
  one release (an uncut tag renders what would ship); `cli.js changelog print`, the whole
  changelog. How releases, pre-releases and PR numbers resolve: `changelog.js`.
- **The opt-out is a line in the PR body**, `Changelog: none — <why>`, for a change no user of
  the repo can see. The reason is required, and a literal `<why>` is not one. Docs-only PRs
  (every path under `docs/` or ending `.md`) and `[bot]` PRs are not asked for a fragment.
- ⚠️ **The dead-path check is a ratchet, in both directions.** A new dead path fails, and so
  does a fixed one until the baseline is regenerated in the same PR, so the baseline stays a
  true record. It is keyed by target, not count.

The CLI's exit codes are its contract: **0** clean, **1** findings, **2** could not run. A
release script reads them the same way CI does.

## Calling the Dependabot merge

Drop this in a pilot repo as `.github/workflows/dependabot-merge.yml`:

```yaml
name: dependabot merge
on:
  workflow_run:
    # EVERY workflow that produces a required check, by its `name:`. The PR is decided when the
    # last of them finishes; one left out can finish after the decision, and the PR then waits.
    workflows: [ci, fleet checks]
    types: [completed]
# ⚠️ REQUIRED: a called workflow cannot exceed the caller's token.
permissions:
  contents: write
  pull-requests: write
  checks: read
  statuses: read
jobs:
  merge:
    uses: owenrenn/.github/.github/workflows/dependabot-merge.yml@main
```

What it merges, and everything it refuses: the header of `scripts/dependabot-merge/decide.js`.
How each outcome shows on the run: the header of `run.js`.

- ⚠️ **Never add the stub to a control-plane repo.** The body refuses this repo by name; the
  other control-plane repos are private, so the content rule keeps them out of the code, and
  the stub's absence is their only exclusion.
- ⚠️ **A repo whose default branch requires no check besides `fleet-checks-gate` is never
  merged**: that check judges changelog and paths, not code. Deleting a repo's CI ruleset stops
  its merges with no other change.
- ⚠️ **The autonomy switch is read immediately before each merge**, and an unreadable switch
  fails the job. Add `autonomy:paused` to issue #40 and the next merge anywhere does not happen.
- **Verify it live**: the first Dependabot PR after the stub lands is the first real run. Read
  that run's notice, not the merge alone.

## Calling the update-feed publisher

A self-updating client's healthy idle state is silence, so a feed never published looks like
one with nothing new; this action turns each such silence into a red run. ⚠️ **It is a
composite action — a `steps:` entry, not a `jobs:` entry** — because its files live in the
calling job's workspace. The reasons: its `action.yml` header.

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

**Every identifier is a required input with no default**, because of the content rule: a
default would publish an inventory of private surfaces. Do not add one.

### What the caller still owns

- ⚠️ **Serialize your release runs.** Two overlapping runs can leave the manifest naming a
  payload hash no stored object has: clients reject every update while the feed looks
  populated. A tag delete and re-push starts two. Callers need:

  ```yaml
  concurrency:
    group: release-${{ github.ref }}
    cancel-in-progress: false   # cancelling mid-upload is the one way to tear a feed on purpose
  ```

- ⚠️ **Budget one hand-delivered build whenever the endpoint changes.** A client reads the URL
  compiled into it, so the first build with a new address is installed by hand; let it carry
  everything else pending.
- ⚠️ **The bucket name lives in three places nothing compares** (the stub, the bucket, the
  credential's scope). A mismatch reads as `AccessDenied`, a misleading permissions error.
- **Verify it live.** The action's read-back proves domain, bucket binding and prefix agree, so
  a green run of it is evidence. A green *build* is not.

## The constraint that shapes everything here

**This repo is public; the fleet canon is not.** The operations repo's `labels.json` and
`fleet.json` are unreachable from here, so no code here may derive its rules from canon.
Where a rule must be duplicated, duplicate it in the **wider** direction (a `pm:` prefix test
rather than an enumerated label set) and name the divergence in a comment.

### The content rule — "no credentials" is not the whole of it

Never put a credential here; that is **not the rule that actually binds.** This repo is public
*by necessity* (a reusable workflow must be public to be callable from another organization),
so everything committed here is published: comments, fixtures, prose.

**Do not publish what the platform withholds.** GitHub returns `404` for a private repository
to an anonymous caller and will not confirm it exists; naming it here defeats that. So:

- Name **roles**, not repositories: "an agent-zone repo", "the operations repo", "a caller".
- Keep the **mechanism**, drop the **incident**. *"`secrets: inherit` does not traverse
  organizations"* belongs in the comment; *which* repo it was measured on is the part that leaks.
- Test fixtures use synthetic names (`example-org`, `example-repo`).
- Quote magnitudes, not counts: "several hundred board items", not the exact figure.
- Issue references are bare `#N` and point at the private operations repo. A reader with
  access can follow them; a reader without learns nothing from the number.

**The publish surface is not only the files.** The repo **description**, commit messages,
branch names and PR titles are served to an anonymous visitor too, and the rules above apply to
them verbatim. A scrub commit that names what it scrubs discloses it again. When you rename
what this repo is, check the description: no diff will ever show it.

In commit history the rule applies *forward* only: rewriting it means force-pushing `main`,
which every fleet caller resolves `@main` against. Write the next subject correctly instead.

**The one deliberate exception** is the project ID in `card-shark-sync.yml`: a handle, not a
key (an unauthenticated request with it gets `403`; an authenticated one still needs access to
the project), kept because the workflow cannot resolve the board without it. If it becomes
removable at reasonable cost, remove it: it is the last thing here confirming a private
surface exists.

## Working here

- Branch `feat/issue-NNN-*` / `fix/issue-NNN-*`; PR to `main`; never commit to `main`.
- Run `node --test scripts/*/*.test.js` before pushing — every suite `tests.yml` runs.
- ⚠️ **This repo is held to the checks it hosts**: a code PR adds a fragment or says
  `Changelog: none — <why>`, and dead paths ratchet against `.github/dead-paths-baseline.json`.
- ⚠️ **A bound set here is the fleet's only bound.** A caller job that invokes a reusable
  workflow with `uses:` cannot carry `timeout-minutes`, so every stub inherits its ceiling from
  the job here. The operations repo's own workflow guard cannot see this directory, which is
  why the assertion lives in `tests.yml` here (#587). Don't move it back.
