// The fleet's agent autonomy kill switch, read from an Actions job (#1685).
//
// The switch is issue #40 in this repo, titled exactly "Agent autonomy switch". The label
// `autonomy:paused` on it pauses every agent merge, release and ticket start, this workflow's
// merges included. This repo is public, so any fleet repo's job can read it under either owner.
//
// ⚠️ IT FAILS CLOSED. Anything but "the exact issue, open, in this repo, readable" answers
// `unreadable`, and the caller treats that as paused: a switch that reads "go" when it is gone is
// worse than none. It reads the issue by NUMBER, never by search: the search index lags a label
// change, and the moment the switch is pulled is when that lag would matter.
//
// ⚠️ The operations repo's own switch reader holds the same rules for agent sessions. The two
// cannot share code (that repo is private), so a change to one is made to the other in a paired
// PR; both fail closed, so a drift can only ever stop a merge, never license one.

const SWITCH = Object.freeze({
  owner: "owenrenn",
  repo: ".github",
  number: 40,
  title: "Agent autonomy switch",
  label: "autonomy:paused",
});

const unreadable = (reason) => ({ state: "unreadable", reason });

/**
 * `clear`, `paused`, or `unreadable` with a reason. Never throws. `request` is an Octokit
 * `request` function (`github.request` in github-script); `def` is overridable for the suite.
 */
async function readSwitch({ request, def = SWITCH }) {
  const slug = `${def.owner}/${def.repo}`;
  let body;
  try {
    ({ data: body } = await request("GET /repos/{owner}/{repo}/issues/{issue_number}", { owner: def.owner, repo: def.repo, issue_number: def.number }));
  } catch (err) {
    return unreadable(`${slug}#${def.number} could not be read: ${err?.status ?? ""} ${err?.message ?? String(err)}`.replace(/\s+/g, " ").trim());
  }
  if (!body || typeof body !== "object") return unreadable(`${slug}#${def.number}: the response is not an issue`);
  // GitHub follows a transferred issue to its new repo; that is no longer the switch.
  if (typeof body.repository_url !== "string" || !body.repository_url.toLowerCase().endsWith(`/repos/${slug}`.toLowerCase())) {
    return unreadable(`${slug}#${def.number}: answers from ${JSON.stringify(body.repository_url)}`);
  }
  if (body.title !== def.title) return unreadable(`${slug}#${def.number}: title is ${JSON.stringify(body.title)}`);
  if (body.state !== "open") return unreadable(`${slug}#${def.number} is ${body.state}`);
  if (!Array.isArray(body.labels)) return unreadable(`${slug}#${def.number}: labels are not a list`);
  // Case-blind, so a recased label still pauses: any error is toward stopping.
  const paused = body.labels.some((l) => String(typeof l === "string" ? l : l?.name).toLowerCase() === def.label.toLowerCase());
  return { state: paused ? "paused" : "clear" };
}

module.exports = { readSwitch, SWITCH };
