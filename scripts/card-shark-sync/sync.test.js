const test = require("node:test");
const assert = require("node:assert");
const { decideAction, isPmLabel } = require("./sync.js");

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
