const { test } = require("node:test");
const assert = require("node:assert");
const { run, TRAILER } = require("./run.js");
const { readSwitch, SWITCH } = require("./switch.js");

const OWNER = "example-org";
const REPO = "example-repo";
const SHA = "a".repeat(40);
const ACTIONS = 15368;
const MESSAGE = [
  "Bump lodash from 4.17.20 to 4.17.21", "", "---", "updated-dependencies:",
  "- dependency-name: lodash", "  dependency-version: 4.17.21", "  dependency-type: direct:production", "  update-type: version-update:semver-patch",
  "...", "", "Signed-off-by: dependabot[bot] <support@github.com>", "",
].join("\n");

const switchIssue = (over = {}) => ({
  repository_url: "https://api.github.com/repos/owenrenn/.github", title: SWITCH.title, state: "open", labels: [], ...over,
});

/** A fake Octokit answering by route; `over` replaces a route's answer (a value, or a function that may throw). */
function fakeGithub(over = {}) {
  const calls = [];
  const answers = {
    "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
      number: 7, title: "Bump lodash from 4.17.20 to 4.17.21", state: "open", draft: false, merged: false,
      user: { login: "dependabot[bot]" },
      head: { sha: SHA, ref: "dependabot/npm_and_yarn/lodash-4.17.21", repo: { full_name: `${OWNER}/${REPO}` } },
      base: { ref: "main" },
    },
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits": [{ sha: SHA, author: { login: "dependabot[bot]" }, commit: { message: MESSAGE, verification: { verified: true } } }],
    "GET /repos/{owner}/{repo}/rules/branches/{branch}": [
      { type: "pull_request", parameters: {} },
      { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci", integration_id: ACTIONS }] } },
      { type: "required_status_checks", parameters: { required_status_checks: [{ context: "fleet-checks-gate", integration_id: ACTIONS }] } },
    ],
    "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": [
      { id: 1, name: "ci", status: "completed", conclusion: "success", app: { id: ACTIONS } },
      { id: 2, name: "fleet-checks-gate", status: "completed", conclusion: "success", app: { id: ACTIONS } },
    ],
    "GET /repos/{owner}/{repo}/commits/{ref}/statuses": [],
    "GET /repos/{owner}/{repo}/issues/{issue_number}": switchIssue(),
    "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge": { merged: true },
    ...over,
  };
  const answer = async (route, params) => {
    calls.push({ route, params });
    if (!(route in answers)) throw new Error(`unexpected route ${route}`);
    const a = answers[route];
    return typeof a === "function" ? a(params, calls) : a;
  };
  return {
    calls,
    request: async (route, params) => ({ data: await answer(route, params) }),
    paginate: async (route, params) => answer(route, params),
  };
}

const context = (wr = {}) => ({
  repo: { owner: OWNER, repo: REPO },
  payload: {
    repository: { id: 1, default_branch: "main" },
    workflow_run: { event: "pull_request", conclusion: "success", head_sha: SHA, pull_requests: [{ number: 7, base: { repo: { id: 1 } } }], ...wr },
  },
});

async function go(over, wr, hold) {
  const github = fakeGithub(over);
  const notices = []; const failures = [];
  await run({ github, context: context(wr), core: { notice: (m) => notices.push(m), setFailed: (m) => failures.push(m) }, hold });
  const merge = github.calls.find((c) => c.route.startsWith("PUT"));
  return { github, notices, failures, merge };
}

test("a green Dependabot patch with the switch clear is merged, squashed and pinned to the judged commit", async () => {
  const r = await go();
  assert.deepStrictEqual(r.failures, []);
  assert.ok(r.merge, r.notices.join("\n"));
  assert.strictEqual(r.merge.params.sha, SHA);
  assert.strictEqual(r.merge.params.merge_method, "squash");
  assert.strictEqual(r.merge.params.commit_title, "Bump lodash from 4.17.20 to 4.17.21 (#7)");
  assert.ok(r.merge.params.commit_message.startsWith(MESSAGE.trimEnd()), "keeps Dependabot's message and its metadata block");
  assert.ok(r.merge.params.commit_message.endsWith(TRAILER));
  assert.match(r.notices.at(-1), /^#7: merged: npm_and_yarn: lodash semver-patch$/);
});

test("the switch is read after the checks and immediately before the merge", async () => {
  const r = await go();
  const routes = r.github.calls.map((c) => c.route);
  assert.strictEqual(routes.at(-2), "GET /repos/{owner}/{repo}/issues/{issue_number}");
  assert.strictEqual(routes.at(-1), "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge");
});

test("a paused switch stops the merge with a notice", async () => {
  const r = await go({ "GET /repos/{owner}/{repo}/issues/{issue_number}": switchIssue({ labels: [{ name: "Autonomy:Paused" }] }) });
  assert.strictEqual(r.merge, undefined);
  assert.deepStrictEqual(r.failures, []);
  assert.match(r.notices.at(-1), /switch is paused/);
});

test("an unreadable switch stops the merge and fails the job", async () => {
  const gone = () => { const e = new Error("Not Found"); e.status = 404; throw e; };
  for (const answer of [gone, switchIssue({ state: "closed" }), switchIssue({ title: "renamed" }), switchIssue({ repository_url: "https://api.github.com/repos/x/y" })]) {
    const r = await go({ "GET /repos/{owner}/{repo}/issues/{issue_number}": answer });
    assert.strictEqual(r.merge, undefined);
    assert.strictEqual(r.failures.length, 1);
    assert.match(r.failures[0], /autonomy switch/);
  }
});

test("a repo whose only required check is fleet-checks-gate is never merged", async () => {
  const r = await go({ "GET /repos/{owner}/{repo}/rules/branches/{branch}": [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "fleet-checks-gate" }] } }] });
  assert.strictEqual(r.merge, undefined);
  assert.match(r.notices.at(-1), /requires no check that tests code/);
});

test("a repo with no required checks at all is never merged", async () => {
  const r = await go({ "GET /repos/{owner}/{repo}/rules/branches/{branch}": [] });
  assert.strictEqual(r.merge, undefined);
});

test("a required check still running leaves the PR for the run that finishes last", async () => {
  const r = await go({ "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": [{ id: 1, name: "ci", status: "in_progress", conclusion: null, app: { id: ACTIONS } }] });
  assert.strictEqual(r.merge, undefined);
  assert.match(r.notices.at(-1), /not merged \(wait\)/);
  assert.ok(!r.github.calls.some((c) => c.route.includes("issues")), "the switch is not read for a PR that cannot merge yet");
});

test("a major update is not merged and the checks are never read", async () => {
  const major = MESSAGE.replace("semver-patch", "semver-major");
  const r = await go({ "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits": [{ sha: SHA, author: { login: "dependabot[bot]" }, commit: { message: major, verification: { verified: true } } }] });
  assert.strictEqual(r.merge, undefined);
  assert.match(r.notices.at(-1), /not patch or minor/);
  assert.ok(!r.github.calls.some((c) => c.route.includes("check-runs")));
});

test("a failed or non-PR triggering run decides nothing", async () => {
  for (const wr of [{ conclusion: "failure" }, { event: "push" }, { pull_requests: [] }, { pull_requests: [{ number: 7, base: { repo: { id: 2 } } }] }]) {
    const r = await go({}, wr);
    assert.strictEqual(r.github.calls.length, 0, JSON.stringify(wr));
    assert.deepStrictEqual(r.failures, []);
  }
});

test("a merge GitHub refuses fails the job with its answer", async () => {
  const refuse = () => { const e = new Error("Required status check \"ci\" is expected."); e.status = 405; throw e; };
  const r = await go({ "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge": refuse });
  assert.strictEqual(r.failures.length, 1);
  assert.match(r.failures[0], /refused the merge: 405 Required status check/);
});

test("a merge refused because another run merged first is a notice, not a failure", async () => {
  let merged = false;
  const github = {
    "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge": () => { merged = true; const e = new Error("Pull Request is not mergeable"); e.status = 405; throw e; },
    "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({ ...fakeGithubPr(), merged }),
  };
  const r = await go(github);
  assert.deepStrictEqual(r.failures, []);
  assert.match(r.notices.at(-1), /already merged by another run/);
});

function fakeGithubPr() {
  return {
    number: 7, title: "Bump lodash", state: "open", draft: false,
    user: { login: "dependabot[bot]" },
    head: { sha: SHA, ref: "dependabot/npm_and_yarn/lodash-4.17.21", repo: { full_name: `${OWNER}/${REPO}` } },
    base: { ref: "main" },
  };
}

test("an API error while deciding fails the job instead of passing silently", async () => {
  const boom = () => { const e = new Error("Server Error"); e.status = 502; throw e; };
  const r = await go({ "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits": boom });
  assert.strictEqual(r.merge, undefined);
  assert.match(r.failures[0], /could not decide: 502 Server Error/);
});

// ── switch.js ────────────────────────────────────────────────────────────────

const read = (answer) => readSwitch({ request: async () => (typeof answer === "function" ? answer() : { data: answer }) });

test("readSwitch: open, exact title, no label reads clear; the label reads paused", async () => {
  assert.deepStrictEqual(await read(switchIssue()), { state: "clear" });
  assert.deepStrictEqual(await read(switchIssue({ labels: ["autonomy:paused"] })), { state: "paused" });
});

test("readSwitch: every other answer is unreadable", async () => {
  for (const a of [null, "text", switchIssue({ labels: "x" }), switchIssue({ state: "closed" }), switchIssue({ title: "Agent autonomy switch " }), switchIssue({ repository_url: undefined })]) {
    assert.strictEqual((await read(a)).state, "unreadable", JSON.stringify(a));
  }
  assert.strictEqual((await read(() => { throw new Error("boom"); })).state, "unreadable");
});

test("readSwitch reads the switch by number, in this repo", async () => {
  let seen;
  await readSwitch({ request: async (route, params) => { seen = params; return { data: switchIssue() }; } });
  assert.deepStrictEqual(seen, { owner: "owenrenn", repo: ".github", issue_number: 40 });
});

test("a branch rule this job cannot meet is a notice, and the merge is never tried", async () => {
  const rules = [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }];
  const r = await go({ "GET /repos/{owner}/{repo}/rules/branches/{branch}": rules });
  assert.strictEqual(r.merge, undefined);
  assert.deepStrictEqual(r.failures, []);
  assert.match(r.notices.at(-1), /requires an approving review/);
});

test("a failing status on the head stops the merge", async () => {
  const r = await go({ "GET /repos/{owner}/{repo}/commits/{ref}/statuses": [{ context: "deploy", state: "failure" }, { context: "deploy", state: "pending" }] });
  assert.strictEqual(r.merge, undefined);
  assert.match(r.notices.at(-1), /failed: deploy/);
});

test("a refused merge keeps GitHub's answer even when the re-read fails too", async () => {
  let reads = 0;
  const r = await go({
    "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge": () => { const e = new Error("Head branch was modified"); e.status = 409; throw e; },
    "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => { if (++reads > 1) { const e = new Error("Server Error"); e.status = 502; throw e; } return fakeGithubPr(); },
  });
  assert.strictEqual(r.failures.length, 1);
  assert.match(r.failures[0], /refused the merge: 409 Head branch was modified/);
});

test("the check runs are asked for with filter latest", async () => {
  const r = await go();
  assert.strictEqual(r.github.calls.find((c) => c.route.includes("check-runs")).params.filter, "latest");
});

test("strict checks with an uncomputed mergeability wait for GitHub instead of trying the merge", async () => {
  const rules = [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "ci", integration_id: ACTIONS }] } }];
  const pr = { ...fakeGithubPr(), mergeable_state: "unknown" };
  const r = await go({ "GET /repos/{owner}/{repo}/rules/branches/{branch}": rules, "GET /repos/{owner}/{repo}/pulls/{pull_number}": pr });
  assert.strictEqual(r.merge, undefined);
  assert.match(r.notices.at(-1), /up to date/);
});

test("the caller's hold input reaches the decision, and the run says what it holds", async () => {
  const r = await go({ "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": [] }, {}, "lodash");
  assert.strictEqual(r.merge, undefined);
  assert.strictEqual(r.notices[0], "holding: lodash");
  assert.match(r.notices.at(-1), /held by this repo's stub, merged in a session: lodash/);
  assert.ok((await go({}, {}, undefined)).merge, "no hold merges as before, and never reads the files");
});

test("a held package moved only in the diff stops the merge", async () => {
  const files = [{ filename: "package-lock.json", patch: '+    "node_modules/example-pkg-core": {' }];
  const r = await go({ "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": files }, {}, "example-pkg-*");
  assert.strictEqual(r.merge, undefined);
  assert.match(r.notices.at(-1), /the diff moves held example-pkg-core/);
});

test("a malformed hold input fails the job before anything is read", async () => {
  const r = await go({}, {}, "- example-pkg");
  assert.strictEqual(r.merge, undefined);
  assert.match(r.failures[0], /not name globs/);
  assert.strictEqual(r.github.calls.length, 0);
});
