// Decision logic for the Dependabot merge on green (#1685, track F). Pure functions only: the
// workflow's I/O lives in run.js, so every rule below is tested without executing a workflow.
//
// A Dependabot PR is merged only when EVERY one of these holds, and anything this file cannot
// read answers "no merge":
//   - the PR is open, not a draft, from `dependabot[bot]`, on a `dependabot/` branch of the
//     same repo, against the default branch, and its head is the commit the triggering run tested;
//   - every commit on it is authored by `dependabot[bot]` with a verified signature, so a commit
//     pushed onto the branch by anyone else stops the merge;
//   - every dependency it updates is `version-update:semver-patch` or `-minor`, read from the
//     metadata block Dependabot writes into its commit message;
//   - the ecosystem is not `github_actions`;
//   - the default branch requires at least one status check besides `fleet-checks-gate`: that
//     one judges changelog and paths, not code, so a repo requiring nothing else is out;
//   - every required check's latest run on the head passed, and no other check's latest run failed;
//   - the kill switch reads clear (switch.js), read last, immediately before the merge.
//
// WHY the metadata is parsed here rather than by `dependabot/fetch-metadata`: that action reads
// the PR from a `pull_request` event payload, and this workflow runs on `workflow_run`, whose
// payload has none. It applies the same checks as that action (author, commit author, verified
// signature) and reads the same block, but stricter: a dependency with no `update-type` is not
// merged, where the action would infer one from the version strings.

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
 * [{ name, updateType, dependencyType }], or null when the block is missing or malformed.
 * The block sits between a `---` line and a `...` line.
 */
function parseUpdates(message) {
  if (typeof message !== "string") return null;
  // Anchored on the key, not the `---` alone: release notes above the block can carry rules of their own.
  const block = message.replace(/\r\n/g, "\n").match(/^---\nupdated-dependencies:\n([\s\S]*?)\n\.\.\.$/m);
  if (!block) return null;
  const deps = [];
  for (const line of block[1].split("\n")) {
    if (!line.trim()) continue;
    const item = line.match(/^- ([a-z-]+):(.*)$/);
    const field = line.match(/^ {2}([a-z-]+):(.*)$/);
    if (item) deps.push({ [item[1]]: scalar(item[2]) });
    else if (field && deps.length) deps[deps.length - 1][field[1]] = scalar(field[2]);
    // A top-level key after the list (`dependency-group:` and the like) ends nothing and adds nothing.
    else if (!/^[a-z-]+:/.test(line)) return null;
  }
  if (!deps.length) return null;
  return deps.map((d) => ({ name: d["dependency-name"] ?? null, updateType: d["update-type"] ?? null, dependencyType: d["dependency-type"] ?? null }));
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
  // Latest run per (name, app): a re-run supersedes the run it repeats.
  const latest = new Map();
  for (const run of checkRuns) {
    const key = `${run.name}\u0000${run.app?.id ?? ""}`;
    const prev = latest.get(key);
    if (!prev || (run.id ?? 0) > (prev.id ?? 0)) latest.set(key, run);
  }
  const runs = [...latest.values()];

  const failedOther = runs.filter((r) => r.status === "completed" && FAILED.has(r.conclusion));
  if (failedOther.length) return { state: "fail", detail: `failed: ${failedOther.map((r) => r.name).sort().join(", ")}` };

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
function judgePr({ repo, defaultBranch, pr, commits, runHeadSha }) {
  if (String(repo).toLowerCase() === SELF.toLowerCase()) return no("this repo is control plane");
  if (!pr || pr.state !== "open") return no("the PR is not open");
  if (pr.draft) return no("the PR is a draft");
  if (pr.user?.login !== DEPENDABOT) return no(`the PR is from ${JSON.stringify(pr.user?.login)}, not ${DEPENDABOT}`);
  if (String(pr.head?.repo?.full_name).toLowerCase() !== String(repo).toLowerCase()) return no("the PR's branch is not in this repo");
  if (pr.base?.ref !== defaultBranch) return no(`the PR targets ${JSON.stringify(pr.base?.ref)}, not the default branch`);
  if (pr.head?.sha !== runHeadSha) return no("the PR's head moved after this run's commit; the newer run decides");

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

  const updates = parseUpdates(head.commit?.message);
  if (!updates) return no("the head commit carries no readable Dependabot metadata");
  const blocked = updates.filter((u) => !MERGEABLE_UPDATES.has(u.updateType));
  if (blocked.length) {
    return no(`not patch or minor: ${blocked.map((u) => `${u.name ?? "?"} (${u.updateType ?? "no update-type"})`).join(", ")}`);
  }
  return { merge: true, reason: `${ecosystem}: ${updates.map((u) => `${u.name} ${u.updateType.replace("version-update:", "")}`).join(", ")}` };
}

/** The required contexts that judge code: the gate's set minus the fleet checks. */
function codeChecks(required) {
  return (required ?? []).filter((r) => r.context !== NOT_A_CODE_CHECK);
}

module.exports = { parseUpdates, ecosystemFromBranch, judgeChecks, judgePr, codeChecks, DEPENDABOT, SELF };
