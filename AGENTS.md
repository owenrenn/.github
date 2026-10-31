# AGENTS.md — owenrenn/.github

GitHub's user-level default community-health repo, and the home of the fleet's
**reusable workflows** (#469).

## What lives here and why

| Path | Purpose |
|---|---|
| `SECURITY.md` | Default security policy inherited by every `owenrenn/*` repo (#251). |
| `.github/workflows/card-shark-sync.yml` | **Reusable**. Keeps Card Shark membership in sync with `pm:*` labels across the fleet, **and mirrors Track / Priority / Engagement at the same moment** (#849). |
| `scripts/card-shark-sync/` | Pure decision logic for the above (`sync.js` = membership, `fields.js` = field derivation), plus their `node --test` suites. |
| `.github/workflows/autoclose-guard.yml` | **Reusable**. **Fails** when what a PR *declares* it closes differs from what GitHub *registered* — in either direction (#942). A close is declared by a closing keyword on a line of its own (`Closes #N`, `Closes owner/repo#N`) and by nothing else; write nothing and the PR declares it closes nothing. Red, and **never a required check**: it does not block a merge. |
| `scripts/autoclose-guard/` | Pure decision logic for the above, plus its `node --test` suite. |
| `.github/workflows/guard-own-prs.yml` | **This repo's own caller** of the guard above (#911). It uses `uses: ./…` **and passes `logic_ref: github.sha`**, so a PR that changes the guard runs its own version of both halves on itself: the workflow file and the predicate it loads come from the same commit (on `pull_request`, the test-merge commit). Only this repo's two own-PR callers pass `logic_ref`; a fleet caller omits it and runs `main`. |
| `.github/workflows/fleet-checks.yml` | **Reusable**. On a pull request, the **changelog fragment check** and the **dead-path ratchet** (#1561, the D7 and D8 rulings on #1555). |
| `.github/workflows/fleet-checks-own-prs.yml` | **This repo's own caller** of the fleet checks (#1561), the `guard-own-prs.yml` pattern: `uses: ./…` plus `logic_ref: github.sha`, so a PR changing the workflow or its scripts runs both on itself. ⚠️ **So this repo is held to the checks it hosts**: a code PR here adds a fragment or says `Changelog: none — <why>`, and dead paths ratchet against `.github/dead-paths-baseline.json`. `tests.yml` fails if a body with a `logic_ref` input has no such caller. |
| `scripts/fleet-checks/` | The two checks, the changelog generator and their CLI, plus `node --test` suites. ⚠️ **Published here byte for byte from the operations repo's `scripts/fleet-checks/` by its `publish.sh` — never hand-edit them here**: the next publish erases the edit. They live here because this is where they execute. |
| `actions/publish-update-feed/` | **Composite action.** Uploads release payloads + an optional manifest to S3-compatible object storage, then verifies the feed from the public URL a client reads. |
| `.github/workflows/tests.yml` | This repo's CI: the `node --test` suite, plus the structural check that every workflow here parses and every job carries `timeout-minutes` (#587). |

## Universal rules — one hop up

Every rule that applies to all of the fleet's repos (Role, Partnership model, Git,
Multi-Agent Coordination, Code Style, Testing, Security, GitHub Issues, Documentation,
Session Handoff) lives in **one** file, loaded by Claude Code as `~/.claude/CLAUDE.md` and tracked for every other agent in the operations repo at `config/claude/global-CLAUDE.md`.
Read it before working here; this file never restates it. An agent that does not load it
automatically (Codex, Copilot, Cursor) fetches it with its own authenticated `gh`:

```bash
gh api repos/<the operations repo>/contents/config/claude/global-CLAUDE.md --jq .content | base64 -d
```

⚠️ **The operations repo is named by role here, never by slug** — § The content rule. A
reader with access resolves it; an anonymous reader learns nothing. Do not paste the fleet
template's linked form of this section: it carries the private slug.

Fleet standards (changelog, release doc, CI gate, security baseline, git flow) live in the
engineering knowledge base's `conventions/`, starting at `repo-engineering-standards.md`.

## Audience

**`agent-zone`**, as this repo's row in the operations repo's fleet manifest declares, and
**escalation-exempt**: the repo carries no Card Shark stub and has never had an issue, so
none of the audience semantics in the global file § Audience model + Card Shark routing run
against it.

- Issues are filed in **the operations repo**, not here.
- ⚠️ **One fleet scanner reads this repo, and it reads files only.** The conformance scan
  walks the fleet manifest, so it covers this repo, with the stub, `pm:*` label and PAT
  checks skipped for the exemption (#519): its green row says the files are in order and
  nothing more. The fleet-state producer drops the user- and org-level community-health repos
  from its derived roster as infrastructure, so no workflow-health signal watches this repo.
  It would read nothing if one did: a reusable-workflow run is attributed to its **caller**,
  so this repo records no Card Shark sync runs however the fleet's board sync behaves (#473).

## Calling the Card Shark sync

The stub lives in the operations repo's template; only its **interface** is documented here.

| Input | Required | Default | Meaning |
|---|---|---|---|
| `audience` | yes | — | `pm-surface` (every issue auto-flows) or `agent-zone` (escalation only) |
| `track` | no | `Personal` | The board Track for items from this repo — `Work` or `Personal` |
| `runner` | no | `ubuntu-latest` | The runner label the job lands on. Omit it for a GitHub-hosted runner |

⚠️ **`runner` is for a caller with a self-hosted runner of its own, and it is an input so
the choice is visible in the caller's file.** A self-hosted runner belongs to one repository
or one organization, so this body cannot know whether a caller has one. Such a caller passes
its own label, normally through its own fallback expression so that one variable sends it
back to hosted runners. A caller that passes nothing is unaffected. The auto-close guard
takes the same input, with the same default.

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
caller's own `GITHUB_TOKEN`. One optional input for callers, `runner` (default `ubuntu-latest`), is
described under the Card Shark sync above; pass it under `with:` only if the caller has a
self-hosted runner of its own.

⚠️ **Verify it live rather than trusting the merge.** A workflow can parse, pass
every structural check, merge green and never run correctly. The PR that adds the
stub is itself a `pull_request` event, so it exercises the guard on arrival —
check that run before assuming the wiring holds. ⚠️ That arrival run is an
`opened` event, and `closingIssuesReferences` lags a body write, so on `opened` it can
read empty. The guard waits and re-reads (up to 4 × 5s) until the registered set
settles (#916), so an arrival run that says OK can be believed. It takes ~20s longer
than you'd expect when the body really does disagree.

### What a red guard means, and what a caller must not do with it

⚠️ **The guard fails the job when declared and registered disagree (#942)**, so the finding
sits on the status surface, where it is seen, and the PR comment explains it. A verdict that
lived only in a comment beside a green row would go unread.

| The body declares | GitHub registered | Result |
|---|---|---|
| nothing | nothing | pass, with no ceremony |
| nothing | an open issue | **fail** — an accidental close (a mid-sentence keyword, a negation, a sidebar link) |
| `Closes #N` | nothing | **fail** — a close that will not fire, or has not registered yet |
| `Closes #N` | `#N` | pass |
| `Closes #N` | `#N` and another | **fail** — closes more than declared |

- **Do not add it to a caller's required checks.** It is red by design and non-blocking by
  decision: a merge is never held by it. A caller that asserts its own required set should
  assert that this job is absent from it.
- **An "unregistered so far" failure on a well-formed PR is usually lag.** GitHub's registration
  can run behind a body edit, sometimes for hours. The comment says to re-check and then close
  the issue by hand after merge. It does not say the body is wrong, because usually it is not.
- **A red row does not clear by itself.** The guard runs on `opened`, `edited`, `reopened` and
  `ready_for_review`. A registration that arrives late, or a sidebar link being removed, fires
  none of them, so the row stays red until the body is edited or the job is re-run. The comment
  says so.
- **A declared close in ANOTHER repository is judged if the guard can read that issue, and
  only reported if it cannot.** The guard runs on its caller's token. It tries to read each such
  issue: readable, it is compared like a local one; unreadable (another private repository), an
  absent registration may be an invisible one, so it is said in the comment and the row stays
  green. **Measured (#1167): that token never sees a registration in another private
  repository.** It reads an empty registered set where a token with access to both
  repositories reads the registration. So between two private repositories this is
  permanent: the guard always says it cannot verify, and the author confirms with their own
  token. ⚠️ On such a PR the guard also waits out its whole settle window (about 20 seconds),
  because it cannot tell an invisible registration from a late one. Known, and left: telling
  them apart means probing the other repository before the wait, in workflow code no test
  executes.
- **Declared means the line, strictly.** A list chains only on one line (`Closes #1, #2` declares
  both, and fails, because GitHub registers the first). A fenced code block is an example and
  declares nothing. `GH-5` is `#5`. Forms the guard does not read as a declaration (a markdown
  link around the ref, a URL in angle brackets, a ref in parentheses) fail as *undeclared* if
  GitHub registers them, which is the safe direction. An **HTML comment** is an example too and
  declares nothing: **measured (#1167), GitHub registers nothing for a closing keyword inside
  one**, so a PR template may hide an example line with a real number in a comment. Only a
  comment that ends counts: an unclosed `<!--` is read as written, and what GitHub does with one
  is not measured.
- **Not covered:** a closing keyword that arrives in a commit message folded into a squash
  merge. It registers at merge time, after every check has run.

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
jobs:
  checks:
    uses: owenrenn/.github/.github/workflows/fleet-checks.yml@main
```

Node is installed by the shared body, so a repo in any language needs nothing else in CI. Two
files in the caller shape what the checks do, both optional:

| File | What it holds |
|---|---|
| `.github/fleet-checks.json` | Release **streams**, each with a tag prefix and the paths that ship in it (none declared: one stream, `v*`, every path); dead-path **exemptions**, each with a `why`; **`foreignNames`**, the names of other repos the caller's comments cite, so a line naming one is not judged. Unknown keys are refused. |
| `.github/dead-paths-baseline.json` | Each file's dead targets (no line numbers) as the repo had them when it adopted the check. **Write it with the CLI, never by hand**: `node <checkout of this repo>/scripts/fleet-checks/cli.js dead-paths --write-baseline`. |

**A fragment**, one per PR, at `changelog.d/<issue>-<slug>.md`:

```markdown
---
type: fixed          # added | changed | fixed | removed
ships: desktop       # a stream name, a list, `all`, or `both`; required only with two or more streams
---
The panel reconnects after the machine wakes.
```

- **No fragment is ever assembled into a committed file.** A fragment's release, per stream, is
  the first tag *of that stream's prefix* containing the commit that authored the add (merges
  left out), and its PR number is the first `(#N)` or `Merge pull request #N` on the way in:
  the first-parent commit that brought it, the authoring commit, then the merges on the ancestry
  path from it, so a branch that merged `main` still credits `main`'s PR. `cli.js changelog release <tag>`
  renders one release's body (a tag not cut yet renders what would ship); `cli.js changelog
  print` prints the whole changelog. A release with no fragments warns and exits 0.
- **A stable release's notes list everything since the previous stable tag of its stream**,
  including what its pre-releases shipped first: `v1.1.0` lists all that is new since `v1.0.0`,
  not only what changed after `v1.1.0-rc.1`. Only tags the release's own history contains count,
  so a pre-release cut on a maintenance branch never lands in `main`'s notes. A pre-release lists
  only what it shipped first. Versions sort by semver precedence, so `rc.2` comes before `rc.10`.
- **The opt-out is a line in the PR body**, `Changelog: none — <why>`, for a change no user of
  the repo can see. The reason is required, and a literal `<why>` (a PR template's hint line) is
  not one. Docs-only PRs (every path under `docs/` or ending `.md`) and PRs opened by a
  `[bot]` account are not asked for a fragment.
- ⚠️ **The dead-path check is a ratchet, in both directions.** A new dead path fails. A fixed one
  fails too, until the baseline is regenerated in the same PR, so the baseline stays a true
  record rather than a ceiling. It is keyed by target, not by count, so fixing one dead path and
  adding another in the same file still fails; a target repeated in a file is listed once per
  occurrence.
- ⚠️ **`edited` is required in the stub's `types:`**, or adding the opt-out line never re-runs
  the check and the row stays red.

The CLI's exit codes are its contract: **0** clean, **1** findings, **2** could not run (a bad
argument, a bad config, a git failure). A release script reads them the same way CI does.

## Calling the update-feed publisher

A self-updating client's healthy idle state is **silence**, so a feed that was never
published looks exactly like a feed with nothing new — indefinitely. This action exists
to convert each of those silences into a red run: a dead updater otherwise ships release
after release with no symptom.

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
object has — clients then reject every update while the feed looks fully populated. A tag
delete + re-push is enough to start two runs seconds apart. Callers need:

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
contents cannot see any of them. A commit message is not a file, and a scrub commit that
names what it scrubs while explaining why discloses it again. So the rules above apply to a
commit subject and a PR title verbatim, and **when you rename what
this repo is, check the description too** — it is the surface a visitor reads first and the
one no diff will ever show you.

Commit history is the one place the rule is applied going *forward* only: rewriting it
means force-pushing `main`, which every fleet caller resolves `card-shark-sync.yml@main`
against. Not worth it to scrub a name already disclosed elsewhere. Write the next subject
correctly instead.

**The one deliberate exception** is the project ID in `card-shark-sync.yml`. It is a
handle, not a key: an unauthenticated GraphQL request carrying it returns `403`, and an
authenticated one still requires authorization on the project itself. It stays because the workflow cannot resolve the board without it. If that ever
becomes removable at reasonable cost, remove it: it is the last thing here that confirms
a private surface exists.

The PAT is forwarded explicitly by each caller, never via `secrets: inherit` — see the
stub comment for why.

## Working here

- Branch `feat/issue-NNN-*` / `fix/issue-NNN-*`; PR to `main`; never commit to `main`.
- Run `node --test scripts/*/*.test.js` before pushing — every suite `tests.yml` runs.
- ⚠️ **A bound set here is the fleet's only bound.** A caller job that invokes a
  reusable workflow with `uses:` cannot carry `timeout-minutes` — GitHub permits only
  `name`/`uses`/`with`/`secrets`/`needs`/`if`/`permissions` on it — so every stub in the
  fleet inherits its ceiling from the job in `card-shark-sync.yml`. The operations repo's
  own workflow guard walks its own directory and **cannot see this one**, which is why the
  assertion lives in `tests.yml` here instead (#587). Don't move it back.
- Bare `#N` issue references in this repo point to the private operations repo — an
  authenticated reader with access to that repo can resolve them to find full canon.
