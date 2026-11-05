const { test } = require("node:test");
const assert = require("node:assert");
const { parseUpdates, ecosystemFromBranch, judgeChecks, judgePr, codeChecks } = require("./decide.js");

// The shape Dependabot writes, from its message builder: subject, links, the metadata block, sign-off.
const message = (deps, { group } = {}) => [
  "Bump lodash from 4.17.20 to 4.17.21",
  "",
  "Bumps [lodash](https://example.com/lodash) from 4.17.20 to 4.17.21.",
  "- [Commits](https://example.com/compare)",
  "",
  "---",
  "updated-dependencies:",
  ...deps.flatMap((d) => [
    `- dependency-name: ${d.name}`,
    ...(d.version ? [`  dependency-version: ${d.version}`] : []),
    "  dependency-type: direct:production",
    ...(d.type ? [`  update-type: ${d.type}`] : []),
    ...(group ? [`  dependency-group: ${group}`] : []),
  ]),
  "...",
  "",
  "Signed-off-by: dependabot[bot] <support@github.com>",
].join("\n");

const PATCH = "version-update:semver-patch";
const MINOR = "version-update:semver-minor";
const MAJOR = "version-update:semver-major";

test("parseUpdates reads every dependency's name and update type", () => {
  assert.deepStrictEqual(parseUpdates(message([{ name: "lodash", version: "4.17.21", type: PATCH }, { name: '"@types/node"', type: MINOR }], { group: "npm" })), [
    { name: "lodash", updateType: PATCH, dependencyType: "direct:production" },
    { name: "@types/node", updateType: MINOR, dependencyType: "direct:production" },
  ]);
});

test("parseUpdates reads CRLF line endings", () => {
  assert.strictEqual(parseUpdates(message([{ name: "a", type: PATCH }]).replace(/\n/g, "\r\n"))[0].updateType, PATCH);
});

test("parseUpdates answers null with no block, an empty block, or a block that is not Dependabot's", () => {
  assert.strictEqual(parseUpdates("Bump a from 1 to 2"), null);
  assert.strictEqual(parseUpdates("x\n---\nupdated-dependencies:\n...\n"), null);
  assert.strictEqual(parseUpdates("x\n---\nsomething-else:\n- a: b\n...\n"), null);
  assert.strictEqual(parseUpdates("x\n---\nupdated-dependencies:\n  garbage without an item\n...\n"), null);
  assert.strictEqual(parseUpdates(undefined), null);
});

test("parseUpdates skips a horizontal rule above the block", () => {
  const m = `Bump a\n\n---\nnotes\n\n${message([{ name: "a", type: PATCH }])}`;
  assert.strictEqual(parseUpdates(m)[0].name, "a");
});

test("parseUpdates keeps a dependency with no update-type, as null", () => {
  assert.strictEqual(parseUpdates(message([{ name: "a" }]))[0].updateType, null);
});

test("ecosystemFromBranch reads either delimiter", () => {
  assert.strictEqual(ecosystemFromBranch("dependabot/npm_and_yarn/lodash-4.17.21"), "npm_and_yarn");
  assert.strictEqual(ecosystemFromBranch("dependabot-github_actions-actions-checkout-5"), "github_actions");
  assert.strictEqual(ecosystemFromBranch("feature/dependabot"), null);
  assert.strictEqual(ecosystemFromBranch("dependabot"), null);
  assert.strictEqual(ecosystemFromBranch(null), null);
});

// ── judgeChecks ──────────────────────────────────────────────────────────────

const ACTIONS = 15368;
const run = (name, conclusion, extra = {}) => ({ id: extra.id ?? 1, name, status: conclusion ? "completed" : "in_progress", conclusion: conclusion ?? null, app: { id: extra.app ?? ACTIONS } });
const REQUIRED = [{ context: "ci", integration_id: ACTIONS }, { context: "fleet-checks-gate", integration_id: ACTIONS }];

test("judgeChecks passes when every required check's latest run succeeded", () => {
  const r = judgeChecks({ required: REQUIRED, checkRuns: [run("ci", "success"), run("fleet-checks-gate", "success")], statuses: [] });
  assert.strictEqual(r.state, "pass");
});

test("judgeChecks waits while a required check is running or has not started", () => {
  assert.strictEqual(judgeChecks({ required: REQUIRED, checkRuns: [run("ci", null), run("fleet-checks-gate", "success")], statuses: [] }).state, "wait");
  assert.strictEqual(judgeChecks({ required: REQUIRED, checkRuns: [run("fleet-checks-gate", "success")], statuses: [] }).state, "wait");
});

test("judgeChecks fails a required check that skipped or was neutral: it proved nothing", () => {
  for (const c of ["skipped", "neutral", "cancelled"]) {
    const r = judgeChecks({ required: REQUIRED, checkRuns: [run("ci", c), run("fleet-checks-gate", "success")], statuses: [] });
    assert.strictEqual(r.state, "fail", c);
  }
});

test("judgeChecks fails when a check nobody requires failed", () => {
  const r = judgeChecks({ required: REQUIRED, checkRuns: [run("ci", "success"), run("fleet-checks-gate", "success"), run("rls", "failure")], statuses: [] });
  assert.deepStrictEqual(r, { state: "fail", detail: "failed: rls" });
});

test("judgeChecks reads the latest run per name, so a green re-run supersedes a red one", () => {
  const runs = [run("ci", "failure", { id: 1 }), run("ci", "success", { id: 2 }), run("fleet-checks-gate", "success")];
  assert.strictEqual(judgeChecks({ required: REQUIRED, checkRuns: runs, statuses: [] }).state, "pass");
  const reversed = [run("ci", "success", { id: 1 }), run("ci", "failure", { id: 2 }), run("fleet-checks-gate", "success")];
  assert.strictEqual(judgeChecks({ required: REQUIRED, checkRuns: reversed, statuses: [] }).state, "fail");
});

test("judgeChecks does not take a same-named check from another app for a required one", () => {
  const r = judgeChecks({ required: REQUIRED, checkRuns: [run("ci", "success", { app: 99 }), run("fleet-checks-gate", "success")], statuses: [] });
  assert.strictEqual(r.state, "wait");
});

test("judgeChecks reads a required commit status when no check run has the name", () => {
  const required = [{ context: "legacy" }];
  assert.strictEqual(judgeChecks({ required, checkRuns: [], statuses: [{ context: "legacy", state: "success" }] }).state, "pass");
  assert.strictEqual(judgeChecks({ required, checkRuns: [], statuses: [{ context: "legacy", state: "pending" }] }).state, "wait");
  assert.strictEqual(judgeChecks({ required, checkRuns: [], statuses: [{ context: "legacy", state: "failure" }] }).state, "fail");
});

test("judgeChecks fails when its inputs could not be read", () => {
  assert.strictEqual(judgeChecks({ required: null, checkRuns: [], statuses: [] }).state, "fail");
});

test("codeChecks drops fleet-checks-gate, so a repo requiring only it has nothing left", () => {
  assert.deepStrictEqual(codeChecks([{ context: "fleet-checks-gate" }]), []);
  assert.deepStrictEqual(codeChecks(REQUIRED).map((r) => r.context), ["ci"]);
  assert.deepStrictEqual(codeChecks(undefined), []);
});

// ── judgePr ──────────────────────────────────────────────────────────────────

const REPO = "example-org/example-repo";
const SHA = "a".repeat(40);
const commit = (over = {}) => ({ sha: SHA, author: { login: "dependabot[bot]" }, commit: { message: message([{ name: "lodash", type: PATCH }]), verification: { verified: true } }, ...over });
const pr = (over = {}) => ({
  state: "open", draft: false, user: { login: "dependabot[bot]" },
  head: { sha: SHA, ref: "dependabot/npm_and_yarn/lodash-4.17.21", repo: { full_name: REPO } },
  base: { ref: "main" }, ...over,
});
const judge = (over = {}) => judgePr({ repo: REPO, defaultBranch: "main", pr: pr(over.pr), commits: over.commits ?? [commit()], runHeadSha: over.runHeadSha ?? SHA });

test("judgePr merges a verified Dependabot patch or minor update", () => {
  assert.deepStrictEqual(judge(), { merge: true, reason: "npm_and_yarn: lodash semver-patch" });
  const minor = commit({ commit: { message: message([{ name: "a", type: MINOR }, { name: "b", type: PATCH }]), verification: { verified: true } } });
  assert.strictEqual(judge({ commits: [minor] }).merge, true);
});

test("judgePr refuses a major, a missing update-type, or a group with one major in it", () => {
  for (const deps of [[{ name: "a", type: MAJOR }], [{ name: "a" }], [{ name: "a", type: PATCH }, { name: "b", type: MAJOR }]]) {
    const c = commit({ commit: { message: message(deps), verification: { verified: true } } });
    const r = judge({ commits: [c] });
    assert.strictEqual(r.merge, false, JSON.stringify(deps));
    assert.match(r.reason, /not patch or minor/);
  }
});

test("judgePr refuses the github_actions ecosystem", () => {
  const r = judge({ pr: { head: { sha: SHA, ref: "dependabot/github_actions/actions/checkout-6", repo: { full_name: REPO } } } });
  assert.strictEqual(r.merge, false);
  assert.match(r.reason, /github_actions/);
});

test("judgePr refuses a PR that is closed, a draft, not Dependabot's, from a fork, or against another branch", () => {
  const cases = [
    { state: "closed" },
    { draft: true },
    { user: { login: "someone" } },
    { head: { sha: SHA, ref: "dependabot/npm_and_yarn/x", repo: { full_name: "other/fork" } } },
    { base: { ref: "release" } },
    { head: { sha: SHA, ref: "feature/x", repo: { full_name: REPO } } },
  ];
  for (const c of cases) assert.strictEqual(judge({ pr: c }).merge, false, JSON.stringify(c));
});

test("judgePr refuses when the head moved past the commit the run tested", () => {
  const r = judge({ runHeadSha: "b".repeat(40) });
  assert.strictEqual(r.merge, false);
  assert.match(r.reason, /head moved/);
});

test("judgePr refuses when any commit is someone else's or unsigned", () => {
  const extra = { sha: "c".repeat(40), author: { login: "someone" }, commit: { message: "fix", verification: { verified: true } } };
  assert.strictEqual(judge({ commits: [extra, commit()] }).merge, false);
  assert.strictEqual(judge({ commits: [commit({ commit: { message: commit().commit.message, verification: { verified: false } } })] }).merge, false);
  assert.strictEqual(judge({ commits: [] }).merge, false);
});

test("judgePr refuses a head commit with no metadata block", () => {
  const c = commit({ commit: { message: "Bump a from 1 to 2", verification: { verified: true } } });
  assert.match(judge({ commits: [c] }).reason, /no readable Dependabot metadata/);
});

test("judgePr refuses this repo, whatever the case", () => {
  const r = judgePr({ repo: "OwenRenn/.GitHub", defaultBranch: "main", pr: pr({ head: { sha: SHA, ref: "dependabot/npm_and_yarn/x", repo: { full_name: "OwenRenn/.GitHub" } } }), commits: [commit()], runHeadSha: SHA });
  assert.deepStrictEqual(r, { merge: false, reason: "this repo is control plane" });
});
