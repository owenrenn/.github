const test = require("node:test");
const assert = require("node:assert");
const { decideAction, isPmLabel } = require("./sync.js");
const { resolveRemoval, datesOf, preservationComment, readBoard } = require("./sync.js");

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

// ---------------------------------------------------------------------------
// #563 -- eventLabel/currentLabels DIVERGENCE.
//
// Every decideAction test above this block sets `currentLabels` consistent with
// `eventLabel`, so none of them could tell a state-based implementation from an
// event-based one: they passed identically before and after the fix. That is why
// the defect shipped, and it is the reason these cases are written as an explicit
// divergence rather than folded into the cases above.
// ---------------------------------------------------------------------------

test("#563 add: a run woken by a NON-pm label still adds when the issue carries pm:*", () => {
  // The live failure: an issue created with four labels. The run woken by
  // pm:awareness was cancelled as an intermediate; the survivor was woken by an
  // unrelated domain label and decided noop, so the board never heard.
  const d = decideAction({
    eventAction: "labeled",
    audience: "pm-surface",
    eventLabel: "type:follow-up",
    currentLabels: ["type:follow-up", "P2", "pm:awareness"],
  });
  assert.equal(d.kind, "add");
});

test("#563 remove: a run woken by a NON-pm label still removes when no pm:* remains", () => {
  // The mirror, which strands an item on the board rather than losing an
  // escalation: pm:* and an unrelated label removed together, and the run woken
  // by the unrelated one is the survivor.
  const d = decideAction({
    eventAction: "unlabeled",
    audience: "agent-zone",
    eventLabel: "type:bug",
    currentLabels: ["P2"],
  });
  assert.equal(d.kind, "remove");
});

test("#563 the decision does not depend on eventLabel at all", () => {
  // The property, not another instance of it. Hold the state fixed, vary only
  // which event woke the run -- including the no-label-payload case -- and every
  // decision must be identical. A future edit that reintroduces an eventLabel
  // gate fails here even if it happens to satisfy the two cases above.
  const state = ["pm:action", "type:bug", "P1"];
  const kinds = new Set(
    ["pm:action", "type:bug", "P1", undefined].map(
      (eventLabel) =>
        decideAction({ eventAction: "labeled", audience: "agent-zone", eventLabel, currentLabels: state }).kind,
    ),
  );
  assert.deepEqual([...kinds], ["add"], "eventLabel changed the decision");

  const bare = ["type:bug"];
  const removals = new Set(
    ["pm:action", "type:bug", undefined].map(
      (eventLabel) =>
        decideAction({ eventAction: "unlabeled", audience: "agent-zone", eventLabel, currentLabels: bare }).kind,
    ),
  );
  assert.deepEqual([...removals], ["remove"], "eventLabel changed the decision");
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
  //
  // ⚠️ That rationale was TRUE BY LUCK until #563 and is now true by design, so
  // do not read the measurement below as having established it. What was measured
  // was a single-label creation, where exactly one `labeled` run exists and
  // therefore cannot be the one the concurrency group cancels. Add a second label
  // and the delivering run became a coin flip -- which is precisely how #563
  // escaped. The labeled path now decides from the issue's current labels, so
  // whichever run survives the queue delivers this. See decideAction.
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
  // Those two halves now live in different files: the query resolves by number
  // HERE, and the comparison moved into readBoard with the rest of the paging
  // (#490). So this asserts the two independent values still meet --
  // the query keyed by number, and PROJECT_ID handed in as the expectation.
  //
  // The comparison ITSELF is covered behaviourally by "reading the wrong project
  // fails loudly rather than concluding absence", which executes the guard
  // instead of matching its source text. That is the stronger check, and the
  // reason this one did not simply follow the moved line with a new regex: a
  // text match in sync.test.js against sync.js is a test that reads the file it
  // is testing, which proves only that the code agrees with itself.
  assert.match(WORKFLOW_CODE, /projectV2\(number:\s*5\)/);
  assert.match(WORKFLOW_CODE, /projectId:\s*PROJECT_ID/);
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

// ---------------------------------------------------------------------------
// readBoard — the paged read, and the concurrency race that broke it (#490)
// ---------------------------------------------------------------------------
//
// WHY these live here at all: the paging loop used to sit inline in the
// workflow's github-script step, where nothing could reach it. It shipped a
// defect that survived design, implementation and review, and surfaced only on
// a live batch de-escalation. tests.yml already states the principle this
// applies -- the code executes from this repo, so the suite must reach it.

// A fake board pager. `pages` is a list of {nodes, totalCount} to hand back in
// order; one entry per call. Deliberately NOT a copy of the real query -- these
// tests are about paging and retry arithmetic, not about the GraphQL selection
// (which the WORKFLOW_CODE text assertions above cover).
function fakePager(attemptsPages, { projectId = "PVT_test" } = {}) {
  let attempt = -1;
  let page = 0;
  let queries = 0;
  return {
    // Actual run() invocations, NOT attempts. The one consumer asserts that work
    // is bounded, and "two attempts ran" is not that claim -- with a multi-page
    // fixture the two diverge and the assertion would read true while measuring
    // something else.
    calls: () => queries,
    attempts: () => attempt + 1,
    run: async () => {
      queries++;
      // A fresh attempt starts whenever the previous one consumed all its pages.
      if (page === 0) attempt++;
      const pages = attemptsPages[Math.min(attempt, attemptsPages.length - 1)];
      const p = pages[page];
      page = page + 1 >= pages.length ? 0 : page + 1;
      return {
        user: {
          projectV2: {
            id: projectId,
            items: {
              totalCount: p.totalCount,
              nodes: p.nodes,
              pageInfo: { hasNextPage: page !== 0, endCursor: `c${page}` },
            },
          },
        },
      };
    },
  };
}

const item = (n) => ({ id: `i${n}`, content: { __typename: "Issue", number: n } });

test("a consistent single-page read returns ok", async () => {
  const f = fakePager([[{ nodes: [item(1), item(2)], totalCount: 2 }]]);
  const r = await readBoard({ runQuery: f.run, projectId: "PVT_test" });
  assert.equal(r.status, "ok");
  assert.equal(r.received, 2);
  assert.equal(r.declared, 2);
  assert.equal(r.nodes.length, 2);
});

test("a multi-page read concatenates every page", async () => {
  const f = fakePager([[
    { nodes: [item(1), item(2)], totalCount: 4 },
    { nodes: [item(3), item(4)], totalCount: 4 },
  ]]);
  const r = await readBoard({ runQuery: f.run, projectId: "PVT_test" });
  assert.equal(r.status, "ok");
  assert.equal(r.nodes.length, 4);
});

test("declared is pinned to page 0, not overwritten by each page (#490)", async () => {
  // THE REGRESSION TEST. The original loop did `declared = items.totalCount` on
  // every iteration, so `declared` ended up holding the LAST page's count while
  // `nodes` had accumulated across ALL of them. A board shrinking mid-read
  // therefore disagreed with itself by construction.
  //
  // Here page 0 declares 4 and we collect all 4, but a concurrent deletion means
  // page 1 reports 3. Pinned: 4 === 4, ok. Per-page: 4 !== 3, a false
  // "unreadable" -- which is exactly what took down a live run.
  const f = fakePager([[
    { nodes: [item(1), item(2)], totalCount: 4 },
    { nodes: [item(3), item(4)], totalCount: 3 },
  ]]);
  const r = await readBoard({ runQuery: f.run, projectId: "PVT_test" });
  assert.equal(r.status, "ok");
  assert.equal(r.declared, 4);
  assert.equal(r.received, 4);
});

test("a genuinely inconsistent read is retried, and succeeds when the board settles", async () => {
  // The live #490 failure: a batch of concurrent de-escalations, one run reading the
  // board while the others deleted from it. A transient mutation resolves on
  // a re-read; a truncated read does not. That is the whole distinction the
  // retry buys, and the guard could not previously make it.
  const f = fakePager([
    [{ nodes: [item(1)], totalCount: 2 }],           // attempt 1: short
    [{ nodes: [item(1), item(2)], totalCount: 2 }],  // attempt 2: settled
  ]);
  const r = await readBoard({ runQuery: f.run, projectId: "PVT_test", sleep: async () => {} });
  assert.equal(r.status, "ok");
  assert.equal(r.attempts, 2);
});

test("a persistently inconsistent read exhausts its retries and reports unreadable", async () => {
  // The direction that MUST still fail. A read that never reconciles is a
  // truncated read, and absence inferred from one is the silent no-op this
  // whole valve was built to avoid. Retry must not launder it into ok.
  const f = fakePager([[{ nodes: [item(1)], totalCount: 9 }]]);
  const r = await readBoard({
    runQuery: f.run, projectId: "PVT_test", maxAttempts: 3, sleep: async () => {},
  });
  assert.equal(r.status, "inconsistent");
  assert.equal(r.received, 1);
  assert.equal(r.declared, 9);
  assert.equal(r.attempts, 3);
});

test("retries are bounded — a flapping board cannot spin the job to its timeout", async () => {
  const f = fakePager([[{ nodes: [], totalCount: 5 }]]);
  const r = await readBoard({
    runQuery: f.run, projectId: "PVT_test", maxAttempts: 2, sleep: async () => {},
  });
  assert.equal(r.status, "inconsistent");
  assert.equal(f.calls(), 2);
});

test("a missing project is reported as such, never as an empty board", async () => {
  // A renamed owner or deleted project arrives as null, not an error. Reported
  // as `absent` it would de-escalate nothing while exiting clean.
  const r = await readBoard({ runQuery: async () => ({ user: null }), projectId: "PVT_test" });
  assert.equal(r.status, "no-project");
});

test("reading the wrong project fails loudly rather than concluding absence", async () => {
  // Resolved by NUMBER in the query, so this compares two INDEPENDENT hardcoded
  // references to the board. Re-fetching node(id: PROJECT_ID) would make the
  // assertion tautological -- the defect this replaced.
  const f = fakePager([[{ nodes: [], totalCount: 0 }]], { projectId: "PVT_other" });
  const r = await readBoard({ runQuery: f.run, projectId: "PVT_test" });
  assert.equal(r.status, "wrong-project");
  assert.equal(r.got, "PVT_other");
});

test("a cursor that stops advancing is truncated, not retried forever", async () => {
  // Distinct from `inconsistent`: the page cap means the cursor never terminated,
  // so re-reading would loop the same way. Gated on there still being a cursor,
  // so a read that legitimately completes ON the cap page is not failed.
  const runQuery = async () => ({
    user: { projectV2: { id: "PVT_test", items: {
      totalCount: 999, nodes: [item(1)],
      pageInfo: { hasNextPage: true, endCursor: "stuck" },
    }}},
  });
  const r = await readBoard({ runQuery, projectId: "PVT_test", maxPages: 5, sleep: async () => {} });
  assert.equal(r.status, "truncated");
  // Pins the BYPASS, not just the status. Letting truncation fall into the retry
  // loop would still yield status "truncated" (from the final attempt) with this
  // assertion absent -- green, while spending two extra full board reads and the
  // backoff on a cursor that is never going to advance.
  assert.equal(r.attempts, 1);
});

test("the workflow reports a stale read as unreadable, never as a difference", () => {
  // The mapping from readBoard's result back to a failure message. `inconsistent`
  // and `truncated` must both reach setFailed -- if either fell through to the
  // removal path, absence would be concluded from a partial board.
  assert.match(WORKFLOW_CODE, /inconsistent/);
  assert.match(WORKFLOW_CODE, /truncated/);
  assert.match(WORKFLOW_CODE, /setFailed/);
});

test("the workflow no longer pages the board inline", () => {
  // The extraction is the point: an inline loop is one nothing can test, which
  // is how #490 shipped. If paging returns to the YAML, these tests go quiet
  // while still passing -- so assert the call site instead.
  assert.match(WORKFLOW_CODE, /readBoard\(/);
  assert.ok(!/declared\s*=\s*items\.totalCount/.test(WORKFLOW_CODE));
});

// --- Findings from the review of the #490 fix -------------------------------

test("a query that THROWS is retried, not aborted", async () => {
  // The retry was built for a count mismatch and did not cover a throw -- the
  // same transient class, and the likelier one. A 502 or a secondary rate limit
  // on a later page aborted the entire read, went red, and left the label
  // removed with the board item still present. github-script does not retry
  // GraphQL by default, so nothing underneath covered it either.
  let n = 0;
  const runQuery = async () => {
    if (++n === 1) throw new Error("502 Bad Gateway");
    return { user: { projectV2: { id: "PVT_test", items: {
      totalCount: 1, nodes: [item(1)], pageInfo: { hasNextPage: false },
    }}}};
  };
  const r = await readBoard({ runQuery, projectId: "PVT_test", sleep: async () => {} });
  assert.equal(r.status, "ok");
  assert.equal(r.attempts, 2);
});

test("a query that throws on EVERY attempt still fails, and names the cause", async () => {
  // The retry must not swallow a persistent failure into a confident answer.
  const runQuery = async () => { throw new Error("401 Unauthorized"); };
  const r = await readBoard({
    runQuery, projectId: "PVT_test", maxAttempts: 2, sleep: async () => {},
  });
  assert.equal(r.status, "inconsistent");
  assert.match(r.reason, /401 Unauthorized/);
});

test("a missing totalCount is a broken response, not a race", async () => {
  // Falling through would fail SAFE (nothing equals undefined) but burn every
  // retry and then report "received 0 of undefined" -- which reads as a race and
  // is not one. Named as a shape fault, on the first attempt.
  const runQuery = async () => ({
    user: { projectV2: { id: "PVT_test", items: {
      nodes: [item(1)], pageInfo: { hasNextPage: false },
    }}},
  });
  const r = await readBoard({ runQuery, projectId: "PVT_test", sleep: async () => {} });
  assert.equal(r.status, "malformed");
  assert.equal(r.attempts, 1);
});

test("a project that vanishes MID-read is retried, not reported as unresolvable", async () => {
  // `no-project` on page 0 means a renamed owner or a deleted board -- terminal.
  // The same null on page 2 means it went away under us, which is transient. One
  // shape, two faults; reporting the second as the first sends the reader to a
  // cause they do not have.
  let n = 0;
  const runQuery = async (cursor) => {
    n++;
    if (n === 2) return { user: { projectV2: null } };       // page 2 of attempt 1
    return { user: { projectV2: { id: "PVT_test", items: {
      totalCount: 2,
      nodes: [item(n)],
      pageInfo: { hasNextPage: !cursor, endCursor: "c1" },
    }}}};
  };
  const r = await readBoard({ runQuery, projectId: "PVT_test", sleep: async () => {} });
  assert.equal(r.status, "ok");
  assert.ok(r.attempts > 1);
});

test("a project missing on PAGE 0 is still terminal, with no retries spent", async () => {
  const r = await readBoard({
    runQuery: async () => ({ user: { projectV2: null } }),
    projectId: "PVT_test", sleep: async () => {},
  });
  assert.equal(r.status, "no-project");
  assert.equal(r.attempts, 1);
});

test("retry backoff is jittered, so correlated runs do not re-read in lockstep", async () => {
  // NOT a refinement. The trigger is correlated by construction: a batch
  // de-escalation fires many runs at once, they collide on one board, and they
  // mismatch within a second of each other. A fixed delay marches all of them
  // back into the API together, each re-reading the whole board. Two different
  // random draws must produce two different delays.
  const delays = [];
  const runQuery = async () => ({
    user: { projectV2: { id: "PVT_test", items: {
      totalCount: 9, nodes: [], pageInfo: { hasNextPage: false },
    }}},
  });
  await readBoard({
    runQuery, projectId: "PVT_test", maxAttempts: 3,
    sleep: async (ms) => { delays.push(ms); },
    backoffMs: 1000, random: () => 0,
  });
  const lo = [...delays];
  delays.length = 0;
  await readBoard({
    runQuery, projectId: "PVT_test", maxAttempts: 3,
    sleep: async (ms) => { delays.push(ms); },
    backoffMs: 1000, random: () => 1,
  });
  assert.notDeepEqual(lo, delays);
  assert.ok(lo.every((d, i) => d < delays[i]));
});

test("the workflow proceeds ONLY on an explicit ok status", () => {
  // ⚠️ The finding that mattered most in review. A blocklist of failure statuses
  // lets an unenumerated one fall through with nodes/received/declared all
  // undefined -- and resolveRemoval's guard is `received !== declared`, which for
  // two undefineds is FALSE. The guard does not fire, the match finds nothing,
  // and the run reports "nothing to remove" and exits 0. Verified by hand before
  // the fix: resolveRemoval returned {status:"absent"}.
  assert.match(WORKFLOW_CODE, /board\.status\s*!==\s*"ok"/);
  assert.match(WORKFLOW_CODE, /unhandled status/);
});

// ---------------------------------------------------------------------------
// shouldSync -- the job-level gate (#917)
// ---------------------------------------------------------------------------

const { shouldSync } = require("./sync.js");
const { computeUpdates, priorityName, engagementName } = require("./fields.js");

const gate = (eventAction, eventLabel, audience = "agent-zone") =>
  shouldSync({ eventAction, audience, eventLabel });

test("the gate runs every event that can change the board", () => {
  assert.equal(gate("opened", undefined, "pm-surface"), true);
  assert.equal(gate("labeled", "pm:awareness"), true);
  assert.equal(gate("unlabeled", "pm:action"), true); // the exit valve
  assert.equal(gate("labeled", "pm:future-tier"), true); // prefix, like isPmLabel
  assert.equal(gate("labeled", "lane:decide"), true); // Engagement re-mirror
  assert.equal(gate("labeled", "lane:some-new-lane"), true); // prefix, like engagementName
  for (const p of ["P0", "P1", "P2", "P3"]) assert.equal(gate("labeled", p), true); // Priority re-mirror
});

test("the gate skips every event that provably changes nothing", () => {
  // decideAction: an agent-zone issue reaches the board only by escalation, and
  // a pm:* label applied at creation arrives as its own `labeled` event.
  assert.equal(gate("opened", undefined, "agent-zone"), false);
  for (const l of ["type:bug", "product:example-repo", "area:core", "devops:"]) {
    assert.equal(gate("labeled", l), false, `labeled ${l}`);
    assert.equal(gate("unlabeled", l), false, `unlabeled ${l}`);
  }
  // Removing a lane or priority never clears a field -- computeUpdates writes
  // only values that are present -- and it cannot change pm:* membership.
  assert.equal(gate("unlabeled", "lane:decide"), false);
  assert.equal(gate("unlabeled", "P2"), false);
  // An action no stub subscribes to.
  assert.equal(gate("edited", "pm:awareness"), false);
});

test("a label the gate skips cannot change any field the sync writes", () => {
  // The claim the whole gate rests on, asserted against fields.js itself rather
  // than restated: starting from an item already in step with its labels, adding
  // any skipped label yields NO field update.
  const bases = [
    ["pm:awareness"],
    ["pm:action", "P2"],
    ["pm:action", "lane:decide", "P1"],
    ["pm:awareness", "lane:kick-off"],
  ];
  const skipped = ["type:bug", "product:example-repo", "area:core", "devops:"];
  const inStep = (labels) => ({
    track: "Personal",
    priority: priorityName(labels),
    engagement: engagementName(labels),
  });
  let checked = 0;
  for (const base of bases) {
    for (const l of skipped) {
      const updates = computeUpdates({
        track: "Personal", contentType: "Issue", labels: [...base, l], current: inStep(base),
      });
      assert.deepEqual(updates, [], `${l} added to [${base}]`);
      checked++;
    }
  }
  assert.equal(checked, bases.length * skipped.length);

  // Non-vacuity: from the same starting point, a label the gate KEEPS does
  // change a field. Without this, a computeUpdates that returned [] for
  // everything would pass the loop above.
  const base = ["pm:action", "P2"];
  const kept = (l) => computeUpdates({
    track: "Personal", contentType: "Issue", labels: [...base, l], current: inStep(base),
  });
  assert.notDeepEqual(kept("P1"), []);
  assert.notDeepEqual(kept("lane:decide"), []);
});

/**
 * A deliberately tiny evaluator for the ONE grammar the gate uses: `||`, `&&`,
 * `==`, parentheses, single-quoted strings, startsWith(), contains(),
 * fromJSON(), and the context paths handed in. Anything else throws, so an
 * edit that reaches outside this grammar fails loudly instead of being
 * evaluated wrongly. String comparison is case-insensitive and null reads as
 * '', as GitHub's expression engine does.
 *
 * WHY evaluate rather than match text: a regex over the expression proves the
 * clauses are PRESENT, not that they combine to the right answer -- swap one
 * `||` for `&&` and every text assertion still passes.
 */
function evalGate(expr, ctx) {
  const src = expr.trim();
  const tokens = [];
  const re = /\s*(\|\||&&|==|[(),]|'[^']*'|[A-Za-z_][\w.]*)/y;
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    const m = re.exec(src);
    if (!m) throw new Error(`unexpected input at ${at}: ${src.slice(at, at + 20)}`);
    tokens.push(m[1]);
  }
  let i = 0;
  const peek = () => tokens[i];
  const take = (want) => {
    const t = tokens[i++];
    if (t === undefined) throw new Error("unexpected end of expression");
    if (want !== undefined && t !== want) throw new Error(`expected ${want}, got ${t}`);
    return t;
  };
  const str = (v) => (v == null ? "" : String(v)).toLowerCase();
  const FUNCS = {
    startsWith: (a, b) => str(a).startsWith(str(b)),
    contains: (a, b) => (Array.isArray(a) ? a.some((x) => str(x) === str(b)) : str(a).includes(str(b))),
    fromJSON: (s) => JSON.parse(s),
  };
  function primary() {
    const t = take();
    if (t === "(") { const v = or(); take(")"); return v; }
    if (t.startsWith("'")) return t.slice(1, -1);
    if (peek() === "(") {
      if (!Object.hasOwn(FUNCS, t)) throw new Error(`unknown function ${t}`);
      take("(");
      const args = [or()];
      while (peek() === ",") { take(","); args.push(or()); }
      take(")");
      return FUNCS[t](...args);
    }
    if (!Object.hasOwn(ctx, t)) throw new Error(`unknown context path ${t}`);
    return ctx[t];
  }
  function eq() {
    const v = primary();
    if (peek() !== "==") return v;
    take("==");
    return str(v) === str(primary());
  }
  function and() {
    let v = eq();
    while (peek() === "&&") { take("&&"); const r = eq(); v = Boolean(v) && Boolean(r); }
    return v;
  }
  function or() {
    let v = and();
    while (peek() === "||") { take("||"); const r = and(); v = Boolean(v) || Boolean(r); }
    return v;
  }
  const v = or();
  if (i !== tokens.length) throw new Error(`trailing tokens: ${tokens.slice(i).join(" ")}`);
  return Boolean(v);
}

// The shipped expression, folded exactly as YAML folds `>-`: same-indent lines
// joined by single spaces. Read from RAW text (not WORKFLOW_CODE) because the
// comment block above it is part of what locates it.
const GATE = (() => {
  const m = WORKFLOW.match(/^ {2}sync:\n(?: {4}#.*\n)* {4}if: >-\n((?: {6}\S.*\n)+)/m);
  if (!m) return null;
  return { lines: m[1].split("\n").filter(Boolean) };
})();

test("the sync job opens with its `if: >-` gate, folded onto one logical line", () => {
  assert.ok(GATE, "the sync job must open with the `if: >-` gate");
  // A MORE-indented line inside `>-` keeps its newline instead of folding --
  // legal YAML, and a different expression than the one this suite evaluates.
  assert.ok(GATE.lines.every((l) => /^ {6}\S/.test(l)), "every gate line at the same indent");
});

test("the workflow's if: expression agrees with shouldSync on every event", () => {
  const expr = GATE.lines.map((l) => l.trim()).join(" ");
  const actions = ["opened", "labeled", "unlabeled", "edited"];
  const labels = [
    undefined, "pm:awareness", "pm:action", "pm:future-tier",
    "lane:decide", "lane:kick-off", "lane:some-new-lane",
    "P0", "P1", "P2", "P3", "P4",
    "type:bug", "product:example-repo", "area:core", "devops:",
  ];
  const audiences = ["pm-surface", "agent-zone"];
  let n = 0;
  let runs = 0;
  for (const a of actions) {
    for (const l of labels) {
      for (const aud of audiences) {
        const want = shouldSync({ eventAction: a, audience: aud, eventLabel: l });
        const got = evalGate(expr, {
          "github.event.action": a,
          "github.event.label.name": l ?? null,
          "inputs.audience": aud,
        });
        assert.equal(got, want, `${a} / ${l} / ${aud}`);
        n++;
        if (want) runs++;
      }
    }
  }
  assert.equal(n, actions.length * labels.length * audiences.length);
  // Both outcomes exercised -- a gate that always ran (or never ran) would
  // agree with a shouldSync that did the same.
  assert.ok(runs > 0 && runs < n, `runs=${runs} of ${n}`);
});

test("the gate evaluator refuses anything outside its grammar", () => {
  const ctx = { "github.event.action": "labeled" };
  assert.throws(() => evalGate("github.event.sender.login == 'x'", ctx), /unknown context path/);
  assert.throws(() => evalGate("endsWith(github.event.action, 'x')", ctx), /unknown function/);
  assert.throws(() => evalGate("github.event.action != 'x'", ctx), /unexpected input|trailing/);
});
