const test = require("node:test");
const assert = require("node:assert");
const {
  priorityName,
  engagementName,
  computeUpdates,
  frozenEngagement,
  LANE_PRECEDENCE,
} = require("./fields.js");

// ─────────────────────────── Priority ───────────────────────────

test("Priority mirrors the P-label, and the highest wins a multi-label mislabel", () => {
  assert.strictEqual(priorityName(["P2"]), "P2");
  assert.strictEqual(priorityName(["type:bug", "P0", "P3"]), "P0");
});

test("no P-label yields null — a priority is never invented", () => {
  // The write policy downstream is "no label -> leave the field alone". If this
  // returned a default, every unlabelled item would acquire a fabricated priority
  // that looks exactly like a human's judgement.
  assert.strictEqual(priorityName(["type:bug"]), null);
  assert.strictEqual(priorityName([]), null);
  assert.strictEqual(priorityName(undefined), null);
});

// ─────────────────────────── Engagement ───────────────────────────

test("Engagement derives from the lane: PREFIX, hyphens becoming spaces", () => {
  assert.strictEqual(engagementName(["lane:do"]), "Do");
  assert.strictEqual(engagementName(["lane:session"]), "Session");
  assert.strictEqual(engagementName(["lane:decide"]), "Decide");
  assert.strictEqual(engagementName(["lane:kick-off"]), "Kick off");
});

test("a lane this public module has never heard of still resolves", () => {
  // THE WIDER-DIRECTION RULE, executable. This repo cannot read the fleet's label
  // canon, so an enumerated lane set here would silently return null for any lane
  // added there tomorrow -- and null means "leave the field alone", which is
  // indistinguishable from a correctly-empty field. Being permissive fails at the
  // API instead, which is loud.
  assert.strictEqual(engagementName(["lane:triage"]), "Triage");
  assert.strictEqual(engagementName(["lane:deep-work"]), "Deep work");
});

test("two lanes: the most costly to the human wins, and an unknown lane never outranks a known one", () => {
  // Over-reporting what a person owes is the safe direction for a surface whose
  // job is "what do I owe". An unknown lane is honoured but ranks last, so it
  // cannot quietly displace a lane whose cost this fleet has actually reasoned
  // about.
  assert.strictEqual(engagementName(["lane:decide", "lane:do"]), "Do");
  assert.strictEqual(engagementName(["lane:kick-off", "lane:session"]), "Session");
  assert.strictEqual(engagementName(["lane:mystery", "lane:decide"]), "Decide");
  assert.strictEqual(LANE_PRECEDENCE[0], "do", "precedence must stay most-costly-first");
});

test("no lane label yields null, and a bare `lane:` is not a lane", () => {
  assert.strictEqual(engagementName(["pm:awareness"]), null);
  assert.strictEqual(engagementName([]), null);
  assert.strictEqual(engagementName(["lane:"]), null);
});

// ─────────────────────────── computeUpdates ───────────────────────────

test("Track is SET-IF-EMPTY and never clobbers a human's override", () => {
  const empty = computeUpdates({ track: "Work", labels: [], current: {} });
  assert.deepStrictEqual(empty, [{ fieldName: "Track", optionName: "Work" }]);

  // Already set, and set DIFFERENTLY from what the caller supplies: that is a
  // deliberate override, and a courier must not overwrite it.
  const overridden = computeUpdates({
    track: "Work",
    labels: [],
    current: { track: "Personal" },
  });
  assert.deepStrictEqual(overridden, []);
});

test("an unrecognised track is dropped rather than written", () => {
  // ⚠️ This module cannot see the board's option list. Writing an arbitrary
  // string would fail at the API with "no such option", which reads nothing like
  // the real cause -- a caller with a typo in its workflow input.
  assert.deepStrictEqual(computeUpdates({ track: "Wrok", labels: [], current: {} }), []);
  assert.deepStrictEqual(computeUpdates({ track: undefined, labels: [], current: {} }), []);
});

test("Priority and Engagement RE-MIRROR on divergence, unlike Track", () => {
  // The policies are genuinely different and collapsing them is a regression:
  // set-if-empty on Priority is what left fields permanently stale when a label
  // changed after the field was first written.
  const out = computeUpdates({
    track: "Personal",
    labels: ["P1", "lane:decide"],
    current: { track: "Personal", priority: "P3", engagement: "Do" },
  });
  assert.deepStrictEqual(out, [
    { fieldName: "Priority", optionName: "P1" },
    { fieldName: "Engagement", optionName: "Decide" },
  ]);
});

test("a field already matching its label produces no write", () => {
  const out = computeUpdates({
    track: "Personal",
    labels: ["P1", "lane:decide"],
    current: { track: "Personal", priority: "P1", engagement: "Decide" },
  });
  assert.deepStrictEqual(out, []);
});

test("a missing label leaves its field alone rather than clearing it", () => {
  const out = computeUpdates({
    track: "Personal",
    labels: [],
    current: { track: "Personal", priority: "P1", engagement: "Do" },
  });
  assert.deepStrictEqual(out, [], "no label must never clear an existing value");
});

test("a draft card derives nothing", () => {
  // No repository, no labels. Anything written here would be invented.
  const out = computeUpdates({
    track: "Personal",
    contentType: "DraftIssue",
    labels: ["P1", "lane:do"],
    current: {},
  });
  assert.deepStrictEqual(out, []);
});

test("computeUpdates survives a malformed item instead of throwing", () => {
  // It runs inside a workflow handling every issue event in the fleet; a throw
  // here takes membership sync down with it.
  assert.deepStrictEqual(computeUpdates(undefined), []);
  assert.deepStrictEqual(computeUpdates({}), []);
});

// ─────────────────────────── frozenEngagement ───────────────────────────

test("a value no label derives is reported as frozen", () => {
  assert.deepStrictEqual(
    frozenEngagement({ labels: ["pm:action"], current: { engagement: "Do" } }),
    { engagement: "Do" },
  );
});

test("a value a label DOES derive is not frozen", () => {
  assert.strictEqual(
    frozenEngagement({ labels: ["lane:do"], current: { engagement: "Do" } }),
    null,
  );
});

test("the awareness+Watch exclusion is a PAIR — neither half alone is the rule", () => {
  // ⚠️ The exclusion that shipped absent once, and reported 22 items where 2 were
  // real. Excluding all awareness items loses the real findings; excluding all
  // "Watch" values lets a parked action item through. Only the pair is correct.

  // Redundant, not stuck: absence already means Watch on the awareness tier.
  assert.strictEqual(
    frozenEngagement({ labels: ["pm:awareness"], current: { engagement: "Watch" } }),
    null,
  );
  // Awareness at a NON-Watch value contradicts the by-absence reading -> report.
  assert.deepStrictEqual(
    frozenEngagement({ labels: ["pm:awareness"], current: { engagement: "Decide" } }),
    { engagement: "Decide" },
  );
  // The action tier has no by-absence default, so nothing there is redundant --
  // including Watch.
  assert.deepStrictEqual(
    frozenEngagement({ labels: ["pm:action"], current: { engagement: "Watch" } }),
    { engagement: "Watch" },
  );
});

test("an empty Engagement is not frozen", () => {
  assert.strictEqual(frozenEngagement({ labels: [], current: {} }), null);
  assert.strictEqual(frozenEngagement(undefined), null);
});
