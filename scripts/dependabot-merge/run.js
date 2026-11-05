// I/O for the Dependabot merge on green (#1685, track F): reads, then at most one merge per PR.
// Every rule is in decide.js and switch.js; this file only fetches what they judge and acts on it.
//
// Outcomes, and how each one shows on the run:
//   merged            a notice naming the update.
//   not ours / wait   a notice. A PR still running checks is decided by the run that finishes last.
//   checks failed     a notice; the PR stays open for a session to look at.
//   switch paused     a notice.
//   switch unreadable the job FAILS: the switch is gone or renamed, and someone should see that.
//   merge refused     the job FAILS with GitHub's answer, unless the PR was merged meanwhile.

const { holdMatcher, judgeHeldFiles, judgePr, judgeRules, judgeChecks, codeChecks } = require("./decide.js");
const { readSwitch } = require("./switch.js");

const TRAILER = "Merged on green by the fleet's Dependabot merge workflow (#1685).";

async function decideOne({ github, owner, repo, number, runHeadSha, defaultBranch, held = holdMatcher(""), log }) {
  const slug = `${owner}/${repo}`;
  const { data: pr } = await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: number });
  const commits = await github.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", { owner, repo, pull_number: number, per_page: 100 });

  const verdict = judgePr({ repo: slug, defaultBranch, pr, commits, runHeadSha, held });
  if (!verdict.merge) return log.notice(`#${number}: not merged: ${verdict.reason}`);
  if (held.globs.length) {
    const files = await github.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", { owner, repo, pull_number: number, per_page: 100 });
    const inDiff = judgeHeldFiles({ files, held });
    if (!inDiff.merge) return log.notice(`#${number}: not merged: ${inDiff.reason}`);
  }

  const { data: rules } = await github.request("GET /repos/{owner}/{repo}/rules/branches/{branch}", { owner, repo, branch: defaultBranch, per_page: 100 });
  const gates = judgeRules(rules, { upToDate: ["clean", "unstable", "has_hooks"].includes(pr.mergeable_state) });
  if (!gates.merge) return log.notice(`#${number}: not merged: ${gates.reason}`);
  const required = rules
    .filter((r) => r.type === "required_status_checks")
    .flatMap((r) => r.parameters?.required_status_checks ?? []);
  if (!codeChecks(required).length) return log.notice(`#${number}: not merged: ${defaultBranch} requires no check that tests code`);

  const sha = pr.head.sha;
  // Both lists in full: Octokit's paginate unwraps the `check_runs` key itself. `filter: latest` is
  // the API's default, stated; judgeChecks still takes the latest per name, which it does not promise.
  const [checkRuns, statuses] = await Promise.all([
    github.paginate("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { owner, repo, ref: sha, filter: "latest", per_page: 100 }),
    github.paginate("GET /repos/{owner}/{repo}/commits/{ref}/statuses", { owner, repo, ref: sha, per_page: 100 }),
  ]);
  // Newest first: the first status per context is its current one.
  const current = [...new Map(statuses.slice().reverse().map((st) => [st.context, st])).values()];
  const checks = judgeChecks({ required, checkRuns, statuses: current });
  if (checks.state !== "pass") return log.notice(`#${number}: not merged (${checks.state}): ${checks.detail}`);

  // Read last, immediately before the merge, so a pull of the switch stops the next merge.
  const sw = await readSwitch({ request: github.request });
  if (sw.state === "paused") return log.notice(`#${number}: not merged: the autonomy switch is paused`);
  if (sw.state !== "clear") return log.fail(`#${number}: not merged: the autonomy switch is ${sw.reason ?? "unreadable"}`);

  try {
    await github.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
      owner, repo, pull_number: number,
      // Pinned to the judged commit: a push after the read makes GitHub refuse the merge.
      sha,
      merge_method: "squash",
      commit_title: `${pr.title} (#${number})`,
      // Dependabot's own message, metadata block included, so the commit on the default branch
      // carries the same record the PR did.
      commit_message: `${commits.find((c) => c.sha === sha).commit.message.trimEnd()}\n\n${checks.detail}\n${TRAILER}`,
    });
  } catch (err) {
    const refused = `${err?.status ?? ""} ${err?.message ?? String(err)}`;
    let after = null;
    try { ({ data: after } = await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: number })); } catch { /* the refusal below still names GitHub's answer */ }
    if (after?.merged) return log.notice(`#${number}: already merged by another run`);
    return log.fail(`#${number}: GitHub refused the merge: ${refused}`);
  }
  return log.notice(`#${number}: merged: ${verdict.reason}`);
}

/** The github-script entry point: `run({ github, context, core, hold })`; `hold` is the caller's input. */
async function run({ github, context, core, hold }) {
  const wr = context.payload?.workflow_run;
  const log = { notice: (m) => core.notice(m), fail: (m) => core.setFailed(m) };
  // Read first, so a malformed hold fails every run, not only the first green Dependabot PR's.
  let held;
  try { held = holdMatcher(hold); } catch (err) { return log.fail(err.message); }
  if (held.globs.length) log.notice(`holding: ${held.globs.join(", ")}`);
  if (!wr) return log.notice("not a workflow_run event; nothing to decide");
  if (wr.event !== "pull_request") return log.notice(`the run was a ${wr.event} run; nothing to decide`);
  if (wr.conclusion !== "success") return log.notice(`the run concluded ${wr.conclusion}; nothing to merge`);
  const { owner, repo } = context.repo;
  const defaultBranch = context.payload.repository?.default_branch;
  if (!defaultBranch) return log.fail("the event names no default branch");
  // Same-repo PRs only: GitHub leaves this list empty for a branch from a fork.
  const prs = (wr.pull_requests ?? []).filter((p) => p.base?.repo?.id === context.payload.repository?.id);
  if (!prs.length) return log.notice("the run belongs to no PR in this repo");
  for (const p of prs) {
    try {
      await decideOne({ github, owner, repo, number: p.number, runHeadSha: wr.head_sha, defaultBranch, held, log });
    } catch (err) {
      log.fail(`#${p.number}: could not decide: ${err?.status ?? ""} ${err?.message ?? String(err)}`);
    }
  }
}

module.exports = { run, decideOne, TRAILER };
