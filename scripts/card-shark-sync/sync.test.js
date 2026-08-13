const test = require("node:test");
const assert = require("node:assert");
const { decideAction, isPmLabel } = require("./sync.js");
const { resolveRemoval, datesOf, preservationComment } = require("./sync.js");

test("any pm:-prefixed label counts, including one not yet in canon", () => {
  // WHY prefix rather than a derived set: reconcile.js derives the pm:* set from
  // owen-ops/.github/labels.json, which is PRIVATE and unreachable from this
  // public repo. Prefix is the wider rule, so a third tier is swept here by
  // default rather than silently skipped -- the safe direction to diverge in.
  assert.ok(isPmLabel("pm:awareness"));
  assert.ok(isPmLabel("pm:action"));
  assert.ok(isPmLabel("pm:future-tier"));
  assert.ok(!isPmLabel("product:arcade"));
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
  // WHY: owen-ops and zetaglobal are the meta repos; items there belong to no
  // product. AGENTS.md 'No product:* labels'.
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
  // Measured rather than assumed -- icntcloud/stravinsky#788 was created
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
    repository: { name: over.repo || "arcade", owner: { login: over.owner || "icntcloud" } },
  },
  fieldValues: { nodes: over.fieldValues || [] },
});

const dateValue = (name, date) => ({ date, field: { name } });

test("a short board read reports unreadable rather than absent", () => {
  // WHY THIS IS THE WHOLE POINT: projectItems returns an EMPTY LIST, not an
  // error, for org-repo -> user-project. A no-match that we trusted would delete
  // nothing and exit 0 in 15 of 20 repos. Spec 2. So absence is only believable
  // when the read was provably complete.
  const r = resolveRemoval({
    boardNodes: [node()], received: 1, declared: 613,
    owner: "icntcloud", repo: "arcade", number: 99,
  });
  assert.equal(r.status, "unreadable");
});

test("a complete read that finds no match reports absent", () => {
  const r = resolveRemoval({
    boardNodes: [node()], received: 1, declared: 1,
    owner: "icntcloud", repo: "arcade", number: 99,
  });
  assert.equal(r.status, "absent");
});

test("a complete read finds the matching item id", () => {
  const r = resolveRemoval({
    boardNodes: [node({ id: "PVTI_lAHOABLEFc4BRJ30zg0-bOE" })], received: 1, declared: 1,
    owner: "icntcloud", repo: "arcade", number: 15,
  });
  assert.equal(r.status, "found");
  assert.equal(r.itemId, "PVTI_lAHOABLEFc4BRJ30zg0-bOE");
});

test("matching is scoped by OWNER too, not just repo name and number", () => {
  // WHY: two orgs can hold a same-named repo. owenrenn/arbor exists and an
  // icntcloud/arbor does not -- but nothing stops one being created, and a
  // cross-owner collision would delete the wrong board item.
  const r = resolveRemoval({
    boardNodes: [node({ owner: "owenrenn" })], received: 1, declared: 1,
    owner: "icntcloud", repo: "arcade", number: 15,
  });
  assert.equal(r.status, "absent");
});

test("matching is scoped by repo NAME too", () => {
  // The third dimension of the match predicate. Owner and number collisions are
  // covered above; without this one, a same-owner same-number issue in a
  // different repo would resolve to this item and delete it.
  const r = resolveRemoval({
    boardNodes: [node({ repo: "stravinsky" })], received: 1, declared: 1,
    owner: "icntcloud", repo: "arcade", number: 15,
  });
  assert.equal(r.status, "absent");
});

test("a pull request on the board is never matched as an issue", () => {
  // WHY __typename is load-bearing: deleting it once blanked Plan A's detector
  // entirely and published `clear` over ~121 strands.
  const r = resolveRemoval({
    boardNodes: [node({ __typename: "PullRequest" })], received: 1, declared: 1,
    owner: "icntcloud", repo: "arcade", number: 15,
  });
  assert.equal(r.status, "absent");
});

test("a draft item with null content does not throw", () => {
  const r = resolveRemoval({
    boardNodes: [node({ content: null })], received: 1, declared: 1,
    owner: "icntcloud", repo: "arcade", number: 15,
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
  assert.match(c, /owen-ops#469/);
});

const fs = require("node:fs");
const path = require("node:path");
const WORKFLOW = fs.readFileSync(
  path.join(__dirname, "../../.github/workflows/card-shark-sync.yml"), "utf8",
);

test("the board query asks for archived items explicitly", () => {
  // archivedStates IS THE TRAP. ProjectV2.items excludes archived items by
  // default AND filters totalCount the same way, so received-vs-declared reads
  // clean over a partial board. Measured on the real board: 176 visible vs 607
  // actual. Without this, resolveRemoval's guard is decorative.
  assert.match(WORKFLOW, /archivedStates:\s*\[ARCHIVED,\s*NOT_ARCHIVED\]/);
});

test("the board query still asks each node for __typename", () => {
  // Load-bearing and easy to mistake for noise: resolveRemoval refuses to match
  // anything that is not an Issue, so without __typename it matches NOTHING and
  // every removal reports `absent`. Silent, and on the success path.
  assert.match(WORKFLOW, /__typename/);
});

test("the board query asks for the repository OWNER, not just the name", () => {
  assert.match(WORKFLOW, /owner\s*\{\s*login/);
});

test("the workflow asserts the board it read is the project it will write to", () => {
  // Same guard escalation-reconcile.yml carries: a wrong project id would page
  // some other board, find no match, and report a clean `absent`.
  assert.match(WORKFLOW, /PVT_kwHOABLEFc4BRJ30/);
});

test("the workflow pages the board rather than reading one page", () => {
  // 613 items against a 100-item page. A single page IS a short read, which the
  // guard would correctly call unreadable -- every removal would fail.
  assert.match(WORKFLOW, /hasNextPage/);
  assert.match(WORKFLOW, /endCursor/);
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
  assert.match(WORKFLOW, /workflow_call:/);
  assert.match(WORKFLOW, /audience:/);
  assert.match(WORKFLOW, /required:\s*true/);
});
