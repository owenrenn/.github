const test = require("node:test");
const assert = require("node:assert");
const { decideAction, isPmLabel } = require("./sync.js");
const { resolveRemoval, datesOf, preservationComment } = require("./sync.js");

test("any pm:-prefixed label counts, including one not yet in canon", () => {
  // WHY prefix rather than a derived set: reconcile.js derives the pm:* set from
  // the operations repo's labels.json, which is PRIVATE and unreachable from this
  // public repo. Prefix is the wider rule, so a third tier is swept here by
  // default rather than silently skipped -- the safe direction to diverge in.
  assert.ok(isPmLabel("pm:awareness"));
  assert.ok(isPmLabel("pm:action"));
  assert.ok(isPmLabel("pm:future-tier"));
  assert.ok(!isPmLabel("product:example-repo"));
  assert.ok(!isPmLabel("type:bug"));
});

test("a pm-surface issue opened without a pm:* label is backfilled, not left bare", () => {
  // WHY: unconditional add + Plan A's orphan detector = a permanent daily strand
  // report for any issue created outside a template. Spec 3.1.
  const d = decideAction({
    eventAction: "opened",
    audience: "pm-surface",
    currentLabels: ["type:bug", "P2"],
  });
  assert.equal(d.kind, "add");
  assert.equal(d.backfillLabel, "pm:awareness");
});

test("a pm-surface issue opened WITH a pm:* label is added without backfill", () => {
  const d = decideAction({
    eventAction: "opened",
    audience: "pm-surface",
    currentLabels: ["pm:action", "P2"],
  });
  assert.equal(d.kind, "add");
  assert.equal(d.backfillLabel, undefined);
});

test("an agent-zone issue merely being opened does nothing", () => {
  const d = decideAction({
    eventAction: "opened",
    audience: "agent-zone",
    currentLabels: ["type:bug"],
  });
  assert.equal(d.kind, "noop");
});

test("labeling pm:* on agent-zone adds and applies the product label", () => {
  const d = decideAction({
    eventAction: "labeled",
    audience: "agent-zone",
    eventLabel: "pm:awareness",
    currentLabels: ["pm:awareness", "type:bug"],
  });
  assert.equal(d.kind, "add");
  assert.equal(d.applyProductLabel, true);
});

test("labeling pm:* on pm-surface adds but applies no product label", () => {
  // WHY: the operations repo and the work-knowledge repo are the meta repos;
  // items there belong to no product. AGENTS.md 'No product:* labels'.
  const d = decideAction({
    eventAction: "labeled",
    audience: "pm-surface",
    eventLabel: "pm:action",
    currentLabels: ["pm:action"],
  });
  assert.equal(d.kind, "add");
  assert.equal(d.applyProductLabel, false);
});

test("labeling a non-pm label does nothing", () => {
  const d = decideAction({
    eventAction: "labeled",
    audience: "agent-zone",
    eventLabel: "type:bug",
    currentLabels: ["type:bug"],
  });
  assert.equal(d.kind, "noop");
});

test("removing one pm:* label while another remains does NOT remove the item", () => {
  // WHY this is the whole reason we re-read labels instead of trusting the
  // event's single removed label. Spec 3.2.
  const d = decideAction({
    eventAction: "unlabeled",
    audience: "agent-zone",
    eventLabel: "pm:awareness",
    currentLabels: ["pm:action", "type:bug"],
  });
  assert.equal(d.kind, "noop");
});

test("removing the LAST pm:* label removes the item", () => {
  const d = decideAction({
    eventAction: "unlabeled",
    audience: "agent-zone",
    eventLabel: "pm:action",
    currentLabels: ["type:bug"],
  });
  assert.equal(d.kind, "remove");
});

test("removing a non-pm label never removes the item", () => {
  const d = decideAction({
    eventAction: "unlabeled",
    audience: "agent-zone",
    eventLabel: "type:bug",
    currentLabels: ["pm:action"],
  });
  assert.equal(d.kind, "noop");
});

test("an unknown audience throws rather than silently choosing a branch", () => {
  // WHY loud: a typo'd `audience:` input in one stub would otherwise pick the
  // agent-zone path in a pm-surface repo and go unnoticed for months.
  assert.throws(
    () => decideAction({ eventAction: "opened", audience: "agentzone", currentLabels: [] }),
    /audience/,
  );
});

test("an agent-zone issue opened ALREADY carrying pm:* is still a noop", () => {
  // Looks like a silent loss and is not: GitHub fires issues.labeled for labels
  // applied at creation, so the `labeled` path always follows and delivers it.
  // Measured rather than assumed -- a real agent-zone repo's issue was created
  // 02:39:09Z, took pm:action at 02:39:11Z, and escalate-to-card-shark.yml ran
  // at 02:39:13Z with conclusion `success`, with the daily reconciler's next run
  // ~11h away and therefore unable to be what delivered it.
  const d = decideAction({
    eventAction: "opened",
    audience: "agent-zone",
    currentLabels: ["pm:action", "type:bug"],
  });
  assert.equal(d.kind, "noop");
});

const node = (over = {}) => ({
  id: over.id || "PVTI_test",
  isArchived: over.isArchived || false,
  content: over.content === null ? null : {
    __typename: over.__typename || "Issue",
    number: over.number || 15,
    repository: { name: over.repo || "example-repo", owner: { login: over.owner || "example-org" } },
  },
  fieldValues: { nodes: over.fieldValues || [] },
});

const dateValue = (name, date) => ({ date, field: { name } });

test("a short board read reports unreadable rather than absent", () => {
  // WHY THIS IS THE WHOLE POINT: projectItems returns an EMPTY LIST, not an
  // error, for org-repo -> user-project. A no-match that we trusted would delete
  // nothing and exit 0 in most fleet repos. Spec 2. So absence is only believable
  // when the read was provably complete.
  const r = resolveRemoval({
    boardNodes: [node()], received: 1, declared: 613,
    owner: "example-org", repo: "example-repo", number: 99,
  });
  assert.equal(r.status, "unreadable");
});

test("a complete read that finds no match reports absent", () => {
  const r = resolveRemoval({
    boardNodes: [node()], received: 1, declared: 1,
    owner: "example-org", repo: "example-repo", number: 99,
  });
  assert.equal(r.status, "absent");
});

test("a complete read finds the matching item id", () => {
  const r = resolveRemoval({
    boardNodes: [node({ id: "PVTI_lAHOABLEFc4BRJ30zg0-bOE" })], received: 1, declared: 1,
    owner: "example-org", repo: "example-repo", number: 15,
  });
  assert.equal(r.status, "found");
  assert.equal(r.itemId, "PVTI_lAHOABLEFc4BRJ30zg0-bOE");
});

test("matching is scoped by OWNER too, not just repo name and number", () => {
  // WHY: two orgs can hold a same-named repo. A repo of that name exists under
  // one org and not the other -- but nothing stops one being created, and a
  // cross-owner collision would delete the wrong board item.
  const r = resolveRemoval({
    boardNodes: [node({ owner: "other-org" })], received: 1, declared: 1,
    owner: "example-org", repo: "example-repo", number: 15,
  });
  assert.equal(r.status, "absent");
});

test("matching is scoped by repo NAME too", () => {
  // The third dimension of the match predicate. Owner and number collisions are
  // covered above; without this one, a same-owner same-number issue in a
  // different repo would resolve to this item and delete it.
  const r = resolveRemoval({
    boardNodes: [node({ repo: "other-repo" })], received: 1, declared: 1,
    owner: "example-org", repo: "example-repo", number: 15,
  });
  assert.equal(r.status, "absent");
});

test("a pull request on the board is never matched as an issue", () => {
  // WHY __typename is load-bearing: deleting it once blanked Plan A's detector
  // entirely and published `clear` over a large batch of strands.
  const r = resolveRemoval({
    boardNodes: [node({ __typename: "PullRequest" })], received: 1, declared: 1,
    owner: "example-org", repo: "example-repo", number: 15,
  });
  assert.equal(r.status, "absent");
});

test("a draft item with null content does not throw", () => {
  const r = resolveRemoval({
    boardNodes: [node({ content: null })], received: 1, declared: 1,
    owner: "example-org", repo: "example-repo", number: 15,
  });
  assert.equal(r.status, "absent");
});

test("only non-empty date fields are collected", () => {
  const d = datesOf(node({
    fieldValues: [dateValue("Deferred until", "2026-11-01"), dateValue("Due date", null), {}],
  }));
  assert.deepEqual(d, [{ field: "Deferred until", date: "2026-11-01" }]);
});

test("the preservation comment names every date it is rescuing", () => {
  const c = preservationComment({
    dates: [{ field: "Deferred until", date: "2026-11-01" }, { field: "Due date", date: "2026-09-09" }],
    itemId: "PVTI_x",
  });
  assert.match(c, /Deferred until.*2026-11-01/s);
  assert.match(c, /Due date.*2026-09-09/s);
  assert.match(c, /card-shark-sync\.yml/);
});

const fs = require("node:fs");
const path = require("node:path");
const WORKFLOW = fs.readFileSync(
  path.join(__dirname, "../../.github/workflows/card-shark-sync.yml"), "utf8",
);
// Assertions about CODE must not be satisfiable by a COMMENT. The __typename
// test passed against a comment mentioning __typename while the query selection
// had it removed -- the test defended nothing, in the file whose whole subject
// is failures that look like successes.
const WORKFLOW_CODE = WORKFLOW.replace(/^\s*(#|\/\/).*$/gm, "");

test("the board query asks for archived items explicitly", () => {
  // archivedStates IS THE TRAP. ProjectV2.items excludes archived items by
  // default AND filters totalCount the same way, so received-vs-declared reads
  // clean over a partial board. Measured on the real board: only a small
  // fraction of items were visible against the majority sitting archived.
  // Without this, resolveRemoval's guard is decorative.
  assert.match(WORKFLOW_CODE, /archivedStates:\s*\[ARCHIVED,\s*NOT_ARCHIVED\]/);
});

test("the board query still asks each node for __typename", () => {
  // Load-bearing and easy to mistake for noise: resolveRemoval refuses to match
  // anything that is not an Issue, so without __typename it matches NOTHING and
  // every removal reports `absent`. Silent, and on the success path.
  assert.match(WORKFLOW_CODE, /__typename/);
});

test("the board query asks for the repository OWNER, not just the name", () => {
  assert.match(WORKFLOW_CODE, /owner\s*\{\s*login/);
});

test("the workflow asserts the board it read is the project it will write to", () => {
  // Same guard escalation-reconcile.yml carries, and now genuinely: resolving
  // by NUMBER and asserting the ID means a wrong project id fails loudly
  // instead of paging some other board and reporting a clean `absent`. (The
  // node(id:) form this replaced made the comparison tautological -- a
  // node(id: X) query always returns the node whose id is X, so the "guard"
  // was dead code wearing this comment.)
  assert.match(WORKFLOW_CODE, /PVT_kwHOABLEFc4BRJ30/);
});

test("the board query resolves the project by NUMBER, not by the id it asserts", () => {
  // The guard is only meaningful if lookup key and asserted value are independent.
  assert.match(WORKFLOW_CODE, /projectV2\(number:\s*5\)/);
  assert.match(WORKFLOW_CODE, /project\.id !== PROJECT_ID/);
});

test("the sync logic is checked out from owenrenn/.github, not the caller", () => {
  // actions/checkout in a REUSABLE workflow checks out the CALLER by default, so
  // without this the require() resolves against the calling repo and every run
  // dies at step 1. Named in the commit message as pinned; it was not.
  assert.match(WORKFLOW_CODE, /repository:\s*owenrenn\/\.github/);
});

test("the preservation comment is posted BEFORE the delete, with nothing catching between", () => {
  // The one unrecoverable-loss invariant in the file: a hand-set Deferred until
  // exists nowhere else once the item is gone. Reordering these two currently
  // ships green.
  assert.ok(WORKFLOW_CODE.indexOf("createComment") < WORKFLOW_CODE.indexOf("deleteProjectV2Item"));
  assert.ok(!/try\s*\{/.test(WORKFLOW_CODE));
});

test("the add path uses the idempotent mutation, not actions/add-to-project", () => {
  // actions/add-to-project@v2 FAILS with "Content already exists in this project"
  // when the issue is already on the board -- which is the ordinary promotion
  // path (adding pm:action to an issue that already carries pm:awareness), not an
  // edge case. It went red on every promotion while producing the right end
  // state, and a habitually-red workflow is one whose real failures go unread.
  //
  // Asserted against WORKFLOW_CODE because the comment above the fix names the
  // action it replaced -- matching raw text here would pass on a file that had
  // been reverted to using it.
  assert.match(WORKFLOW_CODE, /addProjectV2ItemById/);
  assert.ok(!/uses:\s*actions\/add-to-project/.test(WORKFLOW_CODE));
});

test("the add mutation passes the issue node id, not the issue number", () => {
  // addProjectV2ItemById takes a global node id. Passing context.issue.number
  // would fail at runtime only, on a path no unit test reaches.
  assert.match(WORKFLOW_CODE, /contentId:\s*context\.payload\.issue\.node_id/);
});

test("the workflow serializes per issue", () => {
  assert.match(WORKFLOW_CODE, /concurrency:/);
  assert.match(WORKFLOW_CODE, /cancel-in-progress:\s*false/);
});

test("the workflow pages the board rather than reading one page", () => {
  // Several hundred items against a 100-item page. A single page IS a short
  // read, which the guard would correctly call unreadable -- every removal
  // would fail.
  assert.match(WORKFLOW_CODE, /hasNextPage/);
  assert.match(WORKFLOW_CODE, /endCursor/);
});

test("the reusable workflow declares its contract: workflow_call + a required audience input", () => {
  // NOT a trigger assertion. `on: issues: types: [opened, labeled, unlabeled]`
  // lives in the per-repo STUB -- a reusable workflow declares only
  // workflow_call, so asserting the three event names against THIS file asserts
  // something it can never contain. (It did, in an earlier draft of the plan.)
  // The trigger coverage is asserted where the triggers actually live, against
  // the script that emits the stub.
  //
  // What IS this file's contract is the input all 20 stubs must pass. Renaming
  // or dropping it breaks every repo at once, and decideAction throws rather
  // than silently choosing a branch -- loud, but only if the input still arrives.
  assert.match(WORKFLOW_CODE, /workflow_call:/);
  assert.match(WORKFLOW_CODE, /audience:/);
  assert.match(WORKFLOW_CODE, /required:\s*true/);
});
