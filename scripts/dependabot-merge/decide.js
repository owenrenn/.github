// Decision logic for the Dependabot merge on green (#1685, track F). Pure functions only: the
// workflow's I/O lives in run.js, so every rule below is tested without executing a workflow.
//
// A Dependabot PR is merged only when EVERY one of these holds, and anything this file cannot
// read answers "no merge":
//   - the PR is open, not a draft, from `dependabot[bot]`, on a `dependabot/` branch of the
//     same repo, against the default branch, free of conflicts, and its head is the commit the
//     triggering run tested;
//   - every commit on it is authored by `dependabot[bot]` with a verified signature, so a commit
//     pushed onto the branch by anyone else stops the merge;
//   - every dependency it updates is `version-update:semver-patch` or `-minor`, read from the
//     metadata block Dependabot writes into its commit message, or, for a one-dependency block
//     with no `update-type`, from the versions its message names (updateTypeFromMessage);
//   - the ecosystem is not `github_actions`, and neither its metadata nor its diff names a
//     dependency the caller's `hold` globs match;
//   - the default branch requires at least one status check besides `fleet-checks-gate`: that
//     one judges changelog and paths, not code, so a repo requiring nothing else is out;
//   - the branch rules ask for nothing this job cannot give (an approval, a non-squash merge, a
//     merge queue, a rule type it does not know): those read as "no merge", not a refused merge;
//   - every required check's latest run on the head passed, and no other check or status failed;
//   - no breaking bump lands below 1.0 (a 0.y minor, a 0.0.z patch), and every update names its version;
//   - the kill switch reads clear (switch.js), read last, immediately before the merge.
//
// WHY the metadata is parsed here rather than by `dependabot/fetch-metadata`: that action reads
// the PR from a `pull_request` event payload, and this workflow runs on `workflow_run`, whose
// payload has none. It applies the same checks as that action (author, commit author, verified
// signature) and reads the same block. Dependabot leaves `update-type` out of a security update's
// block (and of a version update it cannot classify), so a one-dependency block without one takes
// its step from the old and new versions the message names, as the action infers a step from
// version strings, but stricter: the subject and the body's `Bumps` line must both name the
// block's own dependency and version and agree on the old one, and both versions must be plain
// `x.y.z`.

const DEPENDABOT = "dependabot[bot]";
const MERGEABLE_UPDATES = new Set(["version-update:semver-patch", "version-update:semver-minor"]);
const EXCLUDED_ECOSYSTEMS = new Set(["github_actions"]);
// This repo is control plane (#1685): every fleet caller runs its `main`. The other control-plane
// repos are private, so the content rule keeps their names out of this file; they are excluded by
// never carrying the stub.
const SELF = "owenrenn/.github";
// Judges changelog fragments and dead paths, never code (#1685 § 5.1).
const NOT_A_CODE_CHECK = "fleet-checks-gate";
// Stricter than GitHub, which also counts `neutral` and `skipped` as passing: a required check
// that skipped proved nothing about this commit.
const PASSED = new Set(["success"]);
const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure", "stale"]);

/** A YAML scalar from Dependabot's block: quotes stripped, nothing else interpreted. */
function scalar(raw) {
  const v = raw.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  return v;
}

/**
 * The `updated-dependencies` list from a Dependabot commit message, as
 * [{ name, version, updateType, dependencyType }] (a field Dependabot left out is null), or null
 * when the block is missing or malformed. The block sits between a `---` line and a `...` line.
 */
function parseUpdates(message) {
  if (typeof message !== "string") return null;
  // Anchored on the key, and the LAST such opening: Dependabot writes its own block at the end, and
  // text above it, copied from the dependency's release notes, could carry one of its own,
  // terminated or not.
  const text = `\n${message.replace(/\r\n/g, "\n")}`;
  const OPEN = "\n---\nupdated-dependencies:\n";
  const start = text.lastIndexOf(OPEN);
  if (start < 0) return null;
  const body = text.slice(start + OPEN.length);
  const end = body.search(/^\.\.\.$/m);
  if (end < 0) return null;
  const deps = [];
  for (const line of body.slice(0, end).split("\n")) {
    if (!line.trim()) continue;
    const item = line.match(/^- ([a-z-]+):(.*)$/);
    const field = line.match(/^ {2}([a-z-]+):(.*)$/);
    if (item) deps.push({ [item[1]]: scalar(item[2]) });
    else if (field && deps.length) deps[deps.length - 1][field[1]] = scalar(field[2]);
    // A top-level key after the list (`dependency-group:` and the like) ends nothing and adds nothing.
    else if (!/^[a-z-]+:/.test(line)) return null;
  }
  if (!deps.length) return null;
  return deps.map((d) => ({ name: d["dependency-name"] ?? null, version: d["dependency-version"] ?? null, updateType: d["update-type"] ?? null, dependencyType: d["dependency-type"] ?? null }));
}

/** `{ parts: [major, minor, patch], pre }` from `1.2.3`, `v1.2.3` or `1.2.3-rc.1+build`, or null. */
function parseVersion(v) {
  const m = String(v ?? "").match(/^v?(\d+)\.(\d+)\.(\d+)([-+]\S*)?$/);
  return m ? { parts: m.slice(1, 4).map(Number), pre: m[4] != null } : null;
}

// Dependabot's subject, after whatever prefix the repo configures (`chore(deps): `, `[deps] `):
// `bump <name> from <old> to <new>[ in <dir>]`.
const SUBJECT = /(?:^|\s)[Bb]ump (\S+) from (\S+) to (\S+)(?: in \S+)?$/;
// Dependabot's first body line, which no prefix changes: `Bumps [<name>](<url>) from <old> to <new>.`
const BUMPS = /^Bumps (?:\[([^\]\n]+)\]\([^)\n]*\)|(\S+)) from (\S+) to (\S+)\.$/gm;

/**
 * The semver step of a one-dependency update whose block has no `update-type`, read from the
 * versions its commit message names: `{ type }`, or `{ type: null, why }`, which is refused. The
 * subject and every `Bumps` line must name the block's own dependency and version and agree on
 * the old version, so a lockfile holding the dependency at two versions refuses; both versions
 * must be plain `x.y.z`, and the step must go up.
 */
function updateTypeFromMessage(message, { name, version }) {
  const text = String(message ?? "").replace(/\r\n/g, "\n");
  const s = text.split("\n", 1)[0].match(SUBJECT);
  if (!s || s[1] !== name || s[3] !== version) return { type: null, why: `the subject does not name ${name} ${version}` };
  const bumps = [...text.matchAll(BUMPS)];
  if (!bumps.length) return { type: null, why: "the body has no Bumps line" };
  if (bumps.some((b) => (b[1] ?? b[2]) !== name || b[3] !== s[2] || b[4] !== version)) {
    return { type: null, why: "the body's Bumps line disagrees with the subject" };
  }
  const [from, to] = [parseVersion(s[2]), parseVersion(version)];
  if (!from || !to || from.pre || to.pre) return { type: null, why: `${s[2]} to ${version} is not a plain x.y.z step` };
  const i = from.parts.findIndex((n, k) => n !== to.parts[k]);
  if (i < 0 || to.parts[i] < from.parts[i]) return { type: null, why: `${s[2]} to ${version} is not a step up` };
  return { type: `version-update:semver-${["major", "minor", "patch"][i]}` };
}

// Name globs, not path globs: `*` crosses `/` (an npm scope) and `:` (a Maven group), which the
// fleet checks' path globs do not, so the two compilers stay separate.
const HOLD_GLOB = /^[A-Za-z0-9@._/:*-]+$/;
// Case-blind, with `-`, `_` and `.` one character, as PyPI compares names: any error is toward holding.
const normalName = (name) => String(name).toLowerCase().replace(/[-_.]+/g, "-");

/**
 * The caller's `hold` input as a matcher: globs separated by commas or newlines, `*` the only
 * wildcard, matched against whole names. Empty holds nothing. An entry that is not a name glob
 * (a YAML list dash, a quote) THROWS: a hold that silently matches nothing fails open.
 * The matcher carries its globs, so the run can say what it holds.
 */
function holdMatcher(input) {
  const globs = String(input ?? "").split(/[,\n]/).map((g) => g.trim()).filter(Boolean);
  const bad = globs.filter((g) => !HOLD_GLOB.test(g));
  if (bad.length) throw new Error(`the hold input has entries that are not name globs: ${bad.map((g) => JSON.stringify(g)).join(", ")}`);
  // HOLD_GLOB and normalName leave only letters, digits, `@ / : -` and `*`: nothing else to escape.
  const res = globs.map((g) => new RegExp(`^${normalName(g).split("*").join(".*")}$`));
  const held = (name) => name != null && res.some((re) => re.test(normalName(name)));
  held.globs = globs;
  return held;
}

// The PR files API stops at this many files without an error; a list this long may be cut short.
const FILES_CAP = 3000;

/**
 * The names a changed line could be naming, in every lockfile shape: the token as written, after
 * its last `node_modules/` (npm), without a leading `/` (pnpm), cut at a version `@` (yarn, pnpm,
 * `name@npm:range`), and each `:` prefix (`group:artifact:version`, Gradle). Over-matching only
 * holds a PR for a session.
 */
function candidateNames(line) {
  const names = new Set();
  for (const raw of line.match(/[@A-Za-z0-9._/:-]+/g) ?? []) {
    const token = raw.split("node_modules/").pop().replace(/^\/+/, "");
    if (!token) continue;
    const at = token.indexOf("@", 1);
    for (const t of at > 0 ? [token, token.slice(0, at)] : [token]) {
      const parts = t.split(":");
      for (let i = 1; i <= parts.length; i++) names.add(parts.slice(0, i).join(":"));
    }
  }
  return names;
}

/**
 * Held names the PR's diff moves, beyond its metadata: a bump of one package can move a held one
 * in the lockfile, and the metadata names only the first. Every added or removed line is read for
 * candidate names (candidateNames). A file GitHub sends without a patch (too large, binary), or a
 * list at the API's cap, cannot be read whole, and refuses. Only runs when something is held.
 */
function judgeHeldFiles({ files, held }) {
  if (!held?.globs?.length) return { merge: true };
  if (!Array.isArray(files)) return no("the PR's files could not be read for the hold");
  if (files.length >= FILES_CAP) return no(`the PR changes ${files.length} files or more, past what GitHub lists, so the hold cannot be checked`);
  const found = new Set();
  for (const f of files) {
    if (typeof f.patch !== "string") return no(`${f.filename} has no readable diff, so the hold cannot be checked`);
    for (const line of f.patch.split("\n")) {
      if (!/^[+-]/.test(line) || /^(\+\+\+|---) /.test(line)) continue;
      // The diff's own `+` or `-` is not part of any name.
      for (const name of candidateNames(line.slice(1))) if (held(name)) found.add(name);
    }
  }
  if (found.size) return no(`the diff moves held ${[...found].sort().join(", ")}; merged in a session`);
  return { merge: true };
}

/** `npm_and_yarn` from `dependabot/npm_and_yarn/lodash-4.17.21`, or null. Dependabot picks the delimiter. */
function ecosystemFromBranch(ref) {
  if (typeof ref !== "string" || !ref.startsWith("dependabot") || ref.length < 12) return null;
  const parts = ref.split(ref[10]);
  return parts[0] === "dependabot" && parts[1] ? parts[1] : null;
}

/**
 * The required checks' verdict on one commit: `pass`, `wait` (one has not finished, or has not
 * started) or `fail`, with a detail line. `required` is [{ context, integration_id? }] from the
 * branch rules; `checkRuns` the commit's check runs; `statuses` its commit statuses.
 */
function judgeChecks({ required, checkRuns, statuses }) {
  if (!Array.isArray(required) || !Array.isArray(checkRuns) || !Array.isArray(statuses)) {
    return { state: "fail", detail: "the checks could not be read" };
  }
  // Latest run per (name, app), the identity GitHub's own required-check gate uses: a re-run, even
  // in a new check suite, supersedes the run it repeats. Two workflows with a same-named job are one
  // check to GitHub as well, so the fleet keeps job names unique.
  const latest = new Map();
  for (const run of checkRuns) {
    const key = `${run.name}\u0000${run.app?.id ?? ""}`;
    const prev = latest.get(key);
    if (!prev || (run.id ?? 0) > (prev.id ?? 0)) latest.set(key, run);
  }
  const runs = [...latest.values()];

  // Any failed check or status, required or not, stops the merge.
  const failedOther = [
    ...runs.filter((r) => r.status === "completed" && FAILED.has(r.conclusion)).map((r) => r.name),
    ...statuses.filter((s) => s.state === "failure" || s.state === "error").map((s) => s.context),
  ];
  if (failedOther.length) return { state: "fail", detail: `failed: ${failedOther.sort().join(", ")}` };

  const waiting = [];
  for (const { context, integration_id: app } of required) {
    const matches = runs.filter((r) => r.name === context && (app == null || r.app?.id === app));
    const status = statuses.find((s) => s.context === context);
    if (matches.length) {
      if (matches.some((r) => r.status !== "completed")) { waiting.push(context); continue; }
      const bad = matches.find((r) => !PASSED.has(r.conclusion));
      if (bad) return { state: "fail", detail: `${context} concluded ${bad.conclusion}` };
    } else if (status && app == null) {
      if (status.state === "pending") { waiting.push(context); continue; }
      if (status.state !== "success") return { state: "fail", detail: `${context} is ${status.state}` };
    } else {
      waiting.push(context);
    }
  }
  if (waiting.length) return { state: "wait", detail: `not finished: ${waiting.sort().join(", ")}` };
  return { state: "pass", detail: `passed: ${required.map((r) => r.context).sort().join(", ")}` };
}

const no = (reason) => ({ merge: false, reason });

/**
 * Whether the PR is a Dependabot patch or minor update this workflow may merge, before the checks
 * and the switch are read. `pr` is the REST pull request; `commits` its REST commit list;
 * `runHeadSha` the commit the triggering run tested.
 */
function judgePr({ repo, defaultBranch, pr, commits, runHeadSha, held = () => false }) {
  if (String(repo).toLowerCase() === SELF.toLowerCase()) return no("this repo is control plane");
  if (!pr || pr.state !== "open") return no("the PR is not open");
  if (pr.draft) return no("the PR is a draft");
  if (pr.user?.login !== DEPENDABOT) return no(`the PR is from ${JSON.stringify(pr.user?.login)}, not ${DEPENDABOT}`);
  if (String(pr.head?.repo?.full_name).toLowerCase() !== String(repo).toLowerCase()) return no("the PR's branch is not in this repo");
  if (pr.base?.ref !== defaultBranch) return no(`the PR targets ${JSON.stringify(pr.base?.ref)}, not the default branch`);
  if (pr.head?.sha !== runHeadSha) return no("the PR's head moved after this run's commit; the newer run decides");
  if (pr.mergeable === false || pr.mergeable_state === "dirty") return no("the PR has merge conflicts; Dependabot rebases it");
  if (pr.base?.repo?.allow_squash_merge === false) return no("the repo does not allow a squash merge");

  const ecosystem = ecosystemFromBranch(pr.head?.ref);
  if (!ecosystem) return no(`the branch ${JSON.stringify(pr.head?.ref)} is not a Dependabot branch`);
  if (EXCLUDED_ECOSYSTEMS.has(ecosystem)) return no(`the ${ecosystem} ecosystem is merged in a session, never here`);

  if (!Array.isArray(commits) || !commits.length) return no("the PR's commits could not be read");
  for (const c of commits) {
    if (c.author?.login !== DEPENDABOT) return no(`commit ${String(c.sha).slice(0, 7)} is not authored by ${DEPENDABOT}`);
    if (c.commit?.verification?.verified !== true) return no(`commit ${String(c.sha).slice(0, 7)} has no verified signature`);
  }
  const head = commits.find((c) => c.sha === pr.head.sha);
  if (!head) return no("the PR's head commit is not in its commit list");

  const parsed = parseUpdates(head.commit?.message);
  if (!parsed) return no("the head commit carries no readable Dependabot metadata");
  // A subject names one dependency, so the message fills in only a one-dependency block.
  const updates = parsed.length === 1 && parsed[0].updateType == null
    ? parsed.map((u) => {
      const read = updateTypeFromMessage(head.commit.message, u);
      return { ...u, updateType: read.type, inferred: read.why ?? "read from the message" };
    })
    : parsed;
  const holding = [...new Set(updates.filter((u) => held(u.name)).map((u) => u.name))];
  if (holding.length) return no(`held by this repo's stub, merged in a session: ${holding.join(", ")}`);
  const blocked = updates.filter((u) => !MERGEABLE_UPDATES.has(u.updateType));
  if (blocked.length) {
    return no(`not patch or minor: ${blocked.map((u) => `${u.name ?? "?"} (${u.updateType ?? "no update-type"}${u.inferred ? `; ${u.inferred}` : ""})`).join(", ")}`);
  }
  // Below 1.0 the leftmost non-zero part is the breaking one (Cargo's and npm's caret ranges): a
  // 0.y minor and a 0.0.z patch are judged as majors. An update with no version to read is refused.
  const breaking = (u) => {
    const v = parseVersion(u.version);
    if (!v) return true;
    if (v.parts[0] !== 0) return false;
    return u.updateType === "version-update:semver-minor" || v.parts[1] === 0;
  };
  const preOne = updates.filter(breaking);
  if (preOne.length) return no(`a breaking bump below 1.0, or no version to read: ${preOne.map((u) => `${u.name ?? "?"} ${u.version ?? "?"}`).join(", ")}`);
  return { merge: true, reason: `${ecosystem}: ${updates.map((u) => `${u.name} ${u.updateType.replace("version-update:", "")}${u.inferred ? " (read from the message)" : ""}`).join(", ")}` };
}

/**
 * The branch rules' gates beyond required checks, judged before the merge is tried so a gate this
 * workflow can never meet reads as a notice, not as a refused merge on every run. `rules` is the
 * REST answer for the default branch; `upToDate` whether GitHub has computed the PR as current
 * with it. An allowlist: a rule type not named here may ask for something this job cannot give.
 */
const KNOWN_RULES = new Set(["deletion", "non_fast_forward", "creation", "required_linear_history", "required_signatures", "pull_request", "required_status_checks"]);

function judgeRules(rules, { upToDate = false } = {}) {
  if (!Array.isArray(rules)) return no("the branch rules could not be read");
  for (const r of rules) {
    const p = r.parameters ?? {};
    if (!KNOWN_RULES.has(r.type)) return no(`the branch has a ${r.type} rule this workflow does not judge`);
    if (r.type === "pull_request") {
      if ((p.required_approving_review_count ?? 0) > 0) return no("the branch requires an approving review");
      if (p.require_code_owner_review) return no("the branch requires a code owner's review");
      if (Array.isArray(p.required_reviewers) && p.required_reviewers.length) return no("the branch requires named reviewers");
      if (Array.isArray(p.allowed_merge_methods) && !p.allowed_merge_methods.includes("squash")) return no("the branch does not allow a squash merge");
    }
    // GitHub computes mergeability lazily, so `unknown` right after the base moves is not "current".
    if (r.type === "required_status_checks" && p.strict_required_status_checks_policy && !upToDate) {
      return no("the branch requires the PR to be up to date, and GitHub does not yet say it is");
    }
  }
  return { merge: true };
}

/** The required contexts that judge code: the gate's set minus the fleet checks. */
function codeChecks(required) {
  return (required ?? []).filter((r) => r.context !== NOT_A_CODE_CHECK);
}

module.exports = { holdMatcher, judgeHeldFiles, parseUpdates, updateTypeFromMessage, ecosystemFromBranch, judgeChecks, judgePr, judgeRules, codeChecks, DEPENDABOT, SELF };
