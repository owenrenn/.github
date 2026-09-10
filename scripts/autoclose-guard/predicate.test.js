const { test } = require("node:test");
const assert = require("node:assert");
const {
  evaluate,
  referenceIntentNumbers,
  closingIntentNumbers,
  explainReason,
  unsettled,
} = require("./predicate.js");

// Bodies below are lifted from the real PRs that caused (or narrowly avoided)
// an orphaning, so the suite pins actual history rather than invented shapes.

const openFollowUp = (number, title = "watch ticket") => ({
  number, title, state: "OPEN", labels: ["type:follow-up", "P2"],
});

// ── reference-intent parsing ────────────────────────────────────────────────

test("referenceIntentNumbers: plain `Refs #N`", () => {
  assert.deepEqual([...referenceIntentNumbers("Refs #343.")], [343]);
});

test("referenceIntentNumbers: comma and `and` lists chain to one keyword", () => {
  assert.deepEqual([...referenceIntentNumbers("Refs #310, #337")], [310, 337]);
  assert.deepEqual([...referenceIntentNumbers("Refs #1, #2 and #3")], [1, 2, 3]);
});

test("referenceIntentNumbers: markdown emphasis is stripped before matching", () => {
  // Both forms appeared verbatim in one observed PR body.
  assert.deepEqual([...referenceIntentNumbers("(`Refs #310`)")], [310]);
  assert.deepEqual([...referenceIntentNumbers("Does **not** close #310")], [310]);
});

test("referenceIntentNumbers: negated closing keywords read as reference intent", () => {
  assert.deepEqual([...referenceIntentNumbers("Does not close #310")], [310]);
  assert.deepEqual([...referenceIntentNumbers("This doesn't close #51")], [51]);
  assert.deepEqual([...referenceIntentNumbers("Never resolves #99")], [99]);
});

test("referenceIntentNumbers: honest closing keywords are NOT reference intent", () => {
  assert.deepEqual([...referenceIntentNumbers("Closes #333")], []);
  assert.deepEqual([...referenceIntentNumbers("Fixes #12. Resolves #13.")], []);
});

test("referenceIntentNumbers: attribution is per-issue, not per-document", () => {
  // An observed PR did exactly this and was correct on both counts.
  assert.deepEqual([...referenceIntentNumbers("Closes #333\n\nRefs #313")], [313]);
});

test("referenceIntentNumbers: a bare mention inherits nothing", () => {
  // Prose between the keyword and the number breaks attribution — otherwise
  // #310 here would wrongly inherit `Closes`.
  assert.deepEqual([...referenceIntentNumbers("Closes #333. This also touches #310.")], []);
  assert.deepEqual([...referenceIntentNumbers("#310 is related.")], []);
});

test("referenceIntentNumbers: empty and missing bodies are safe", () => {
  assert.deepEqual([...referenceIntentNumbers("")], []);
  assert.deepEqual([...referenceIntentNumbers(undefined)], []);
});

// ── the four historical orphanings ──────────────────────────────────────────

test("prose disclaimer + sidebar registration is flagged", () => {
  // The 4th occurrence, and the one that proved the type:project predicate was
  // on the wrong axis — the tracker wore a non-project type label, so a
  // label-only guard stayed silent.
  const body = [
    "Settles opacity + blur fleet-wide.",
    "",
    "Does **not** close #310 — that stays open as the blur-adoption watch (`Refs #310`).",
  ].join("\n");

  const { flagged } = evaluate({ closingRefs: [openFollowUp(310, "blur adoption watch")], body });

  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].number, 310);
  assert.deepEqual(flagged[0].reasons, ["contradiction"]);
});

test("negation alone is enough — no explicit Refs needed", () => {
  const { flagged } = evaluate({
    closingRefs: [openFollowUp(310)],
    body: "Does not close #310.",
  });
  assert.deepEqual(flagged.map(f => f.number), [310]);
});

test("type:project trackers stay covered (no regression from the old predicate)", () => {
  const { flagged } = evaluate({
    closingRefs: [{ number: 212, title: "PM operating model", state: "OPEN", labels: ["type:project"] }],
    body: "Layer 2 of the umbrella.\n\nCloses #212",
  });
  assert.equal(flagged.length, 1);
  assert.deepEqual(flagged[0].reasons, ["type:project"]);
});

test("no-autoclose marks a watch ticket even when the PR says Closes honestly", () => {
  const { flagged } = evaluate({
    closingRefs: [{ number: 310, title: "blur watch", state: "OPEN", labels: ["type:follow-up", "no-autoclose"] }],
    body: "Closes #310",
  });
  assert.deepEqual(flagged[0].reasons, ["no-autoclose"]);
});

test("both signals fire → contradiction leads the reason list", () => {
  const { flagged } = evaluate({
    closingRefs: [{ number: 310, title: "blur watch", state: "OPEN", labels: ["no-autoclose"] }],
    body: "Refs #310",
  });
  assert.deepEqual(flagged[0].reasons, ["contradiction", "no-autoclose"]);
});

// ── silence on honest PRs (the false-positive budget) ───────────────────────

test("an honest `Closes` on a finished ticket is silent", () => {
  // The near-miss in the same merge window as the flagged case. Passing here
  // here is the whole reason option 1 ("warn on any closing ref") was rejected:
  // a warning that fires on every PR gets ignored, and the orphaning recurs.
  const body = "Captures the work Mac desktop + terminal state.\n\nCloses #333\nRefs #313";
  const { flagged } = evaluate({
    closingRefs: [{ number: 333, title: "capture work Mac state", state: "OPEN", labels: ["type:follow-up"] }],
    body,
  });
  assert.deepEqual(flagged, []);
});

test("a CLOSED issue is never flagged", () => {
  const { flagged } = evaluate({
    closingRefs: [{ number: 310, title: "done", state: "CLOSED", labels: ["type:project"] }],
    body: "Refs #310",
  });
  assert.deepEqual(flagged, []);
});

test("no closing references at all → silent", () => {
  assert.deepEqual(evaluate({ closingRefs: [], body: "Refs #310" }).flagged, []);
  assert.deepEqual(evaluate({}).flagged, []);
});

// ── the mixed case: flag only the contradicted issue ────────────────────────

test("mixed PR: flags the Refs-but-registered issue, ignores the honest Closes", () => {
  const body = "Closes #333\n\nRefs #313";
  const { flagged } = evaluate({
    closingRefs: [
      { number: 333, title: "finished", state: "OPEN", labels: ["type:follow-up"] },
      { number: 313, title: "work-lane umbrella", state: "OPEN", labels: ["type:follow-up"] },
    ],
    body,
  });
  assert.deepEqual(flagged.map(f => f.number), [313]);
  assert.deepEqual(flagged[0].reasons, ["contradiction"]);
});

test("explainReason expands every reason the predicate can emit", () => {
  // Guards against a new reason being added to the predicate without matching
  // prose — which would leak a bare slug like "contradiction" into the comment.
  for (const reason of ["contradiction", "prose-keyword", "type:project", "no-autoclose"]) {
    const prose = explainReason(reason);
    assert.notEqual(prose, reason, `${reason} has no prose expansion`);
    assert.ok(prose.length > 20, `${reason} expansion is too terse: ${prose}`);
  }
});

// ── the inverse direction: stated `Closes` that GitHub never registered ─────
//
// An observed PR said `Closes #78, #426` and only #78 closed: GitHub requires
// a keyword before EACH number, so `#426` was parsed as a bare mention. The
// guard ran green on that PR because it only ever looked at `closingRefs` —
// the set GitHub computed — and #426 was never in it.

test("closingIntentNumbers: a comma list states closing intent for every number", () => {
  // The observed body shape. Both numbers are stated; only #78 registers.
  assert.deepEqual([...closingIntentNumbers("Refs #630\nCloses #78, #426")], [78, 426]);
});

test("closingIntentNumbers: mirrors referenceIntentNumbers, never overlapping it", () => {
  const body = "Closes #333\n\nRefs #313";
  assert.deepEqual([...closingIntentNumbers(body)], [333]);
  assert.deepEqual([...referenceIntentNumbers(body)], [313]);
});

test("closingIntentNumbers: negated and bare mentions are not closing intent", () => {
  assert.deepEqual([...closingIntentNumbers("Does not close #310")], []);
  assert.deepEqual([...closingIntentNumbers("Closes #333. This also touches #310.")], [333]);
  assert.deepEqual([...closingIntentNumbers("#310 is related.")], []);
});

test("closingIntentNumbers: a cross-repo ref is not claimed as this repo's number", () => {
  // `owner/repo` between the keyword and the `#N` breaks attribution, so the
  // number is never mistaken for a local issue we could look up by number.
  assert.deepEqual([...closingIntentNumbers("Closes example-org/example-repo#12")], []);
});

test("an OPEN stated-close that GitHub did not register is reported", () => {
  const { flagged, unregistered } = evaluate({
    closingRefs: [{ number: 78, title: "landed", state: "OPEN", labels: ["type:follow-up"] }],
    body: "Closes #78, #426",
    issueStates: { 426: { state: "OPEN", title: "Raycast vs native Spotlight" } },
  });
  assert.deepEqual(flagged, []);
  assert.deepEqual(unregistered, [{ number: 426, title: "Raycast vs native Spotlight" }]);
});

test("an unregistered number that is already CLOSED is not reported", () => {
  // Nothing is orphaned — warning here would spend the false-positive budget.
  const { unregistered } = evaluate({
    closingRefs: [],
    body: "Closes #426",
    issueStates: { 426: { state: "CLOSED", title: "already done" } },
  });
  assert.deepEqual(unregistered, []);
});

test("an unregistered number with no resolvable state is not reported", () => {
  // A typo'd or nonexistent number orphans nothing; we make no claim we
  // cannot back with a state read. Absent `issueStates` is the same case.
  assert.deepEqual(evaluate({ closingRefs: [], body: "Closes #99999" }).unregistered, []);
  assert.deepEqual(
    evaluate({ closingRefs: [], body: "Closes #99999", issueStates: {} }).unregistered,
    [],
  );
});

test("an honest single `Closes` that registered correctly reports nothing", () => {
  const { flagged, unregistered } = evaluate({
    closingRefs: [{ number: 333, title: "finished", state: "OPEN", labels: ["type:follow-up"] }],
    body: "Closes #333",
    issueStates: { 333: { state: "OPEN", title: "finished" } },
  });
  assert.deepEqual(flagged, []);
  assert.deepEqual(unregistered, []);
});

test("both directions can fire on one PR and are reported separately", () => {
  const { flagged, unregistered } = evaluate({
    closingRefs: [{ number: 313, title: "umbrella", state: "OPEN", labels: ["type:follow-up"] }],
    body: "Refs #313\nCloses #78, #426",
    issueStates: { 426: { state: "OPEN", title: "orphaned" }, 78: { state: "OPEN", title: "a" } },
  });
  assert.deepEqual(flagged.map(f => f.number), [313]);
  assert.deepEqual(unregistered.map(u => u.number), [78, 426]);
});

// ── prose keywords: registered by a keyword mid-sentence ────────────────────
//
// An observed PR body explained that an issue had been filed rather than
// addressed, with the past-tense closing verb and a colon right before the
// number. GitHub registered it as a close and the guard reported OK: the walk
// attributed the number to a closing keyword, so it counted as STATED intent,
// and stated and registered agreed. Only a keyword that leads its line is
// intentional now. The fixtures are synthetic; the sentence SHAPE is the
// observed one.

const open = (number, title = "t") => ({ number, title, state: "OPEN", labels: ["type:follow-up"] });

test("a mid-sentence closing keyword that registered is flagged prose-keyword", () => {
  const body =
    "Closes #40\n\n" +
    "Verification found two problems outside this diff, both filed rather than fixed: " +
    "#41 (a local run can never pass one suite) and #42.";
  const { flagged } = evaluate({ closingRefs: [open(40), open(41)], body, issueStates: {} });
  assert.deepEqual(flagged.map(f => f.number), [41], "only the prose-closed issue is flagged");
  assert.deepEqual(flagged[0].reasons, ["prose-keyword"]);
});

test("a line-leading Closes is intentional — bold, indented, or after CRLF", () => {
  for (const body of ["Closes #5", "  **Closes** #5", "Summary\r\nCloses #5", "Refs #4\n\tFixes #5"]) {
    assert.deepEqual(evaluate({ closingRefs: [open(5)], body }).flagged, [], JSON.stringify(body));
  }
});

test("a number stated line-leading AND mid-sentence is intentional", () => {
  const body = "Closes #5\n\nThe second commit also fixes #5 for the parity job.";
  assert.deepEqual(evaluate({ closingRefs: [open(5)], body }).flagged, []);
});

test("policy, pinned: the second keyword of a one-line pair is flagged", () => {
  // It still closes; the warning costs a glance. Pinned so relaxing it is a
  // deliberate change rather than drift.
  const { flagged } = evaluate({ closingRefs: [open(1), open(2)], body: "Closes #1, closes #2" });
  assert.deepEqual(flagged.map(f => [f.number, f.reasons]), [[2, ["prose-keyword"]]]);
});

test("policy, pinned: a list-item keyword does not lead its line", () => {
  const { flagged } = evaluate({ closingRefs: [open(7)], body: "Summary\n- Closes #7" });
  assert.deepEqual(flagged.map(f => [f.number, f.reasons]), [[7, ["prose-keyword"]]]);
});

test("a sidebar-only link (no keyword at all) is NOT prose-keyword", () => {
  // Governed by the label signals, exactly as before this signal existed.
  assert.deepEqual(evaluate({ closingRefs: [open(8)], body: "Unrelated summary." }).flagged, []);
});

test("an already-CLOSED issue closed by prose is not flagged", () => {
  const ref = { number: 9, title: "done", state: "CLOSED", labels: [] };
  assert.deepEqual(evaluate({ closingRefs: [ref], body: "this also fixes #9 in passing" }).flagged, []);
});

test("stated closing intent is unchanged by position — only the flag is new", () => {
  // The unregistered direction still sees a mid-sentence close as stated.
  assert.deepEqual([...closingIntentNumbers("both filed rather than fixed: #41")], [41]);
});

// ── settle before judging: the registered set lags a body write (#916) ──────
//
// On `opened`, `closingIssuesReferences` read EMPTY for a PR whose close
// registered moments later, and the guard reported OK. `unsettled` names the
// lag-shaped disagreements the workflow waits out before evaluating.

test("unsettled: a stated close not yet registered is lag-shaped", () => {
  assert.deepEqual(unsettled("Closes #5", []), [5]);
});

test("unsettled: a settled honest close is not", () => {
  assert.deepEqual(unsettled("Closes #5", [open(5)]), []);
});

test("unsettled: a registered number the body now only references is lag-shaped", () => {
  // An edit swapped a closing keyword for `Refs`; GitHub hasn't dropped it yet.
  assert.deepEqual(unsettled("Refs #5", [open(5)]), [5]);
});

test("unsettled: a sidebar-only link the body never mentions never triggers a retry", () => {
  assert.deepEqual(unsettled("Unrelated summary.", [open(8)]), []);
});

test("unsettled: the observed opened-race shape — a prose close, empty registered set", () => {
  const body = "Refs #40\n\nThe last PR of that step closes #40.";
  assert.deepEqual(unsettled(body, []), [40]);
});

test("unsettled, pinned cost: a GENUINE mismatch waits the full budget, then reports", () => {
  // `Closes #1, #2` registers #1 alone — #2 never registers, so it stays
  // unsettled on every read. The guard waits out its retries and THEN reports
  // #2 as unregistered. A real contradiction (Refs + a registered close) behaves
  // the same. Pinned so the ~20s wait is a known cost, never a surprise.
  assert.deepEqual(unsettled("Closes #1, #2", [open(1)]), [2]);
  assert.deepEqual(unsettled("Refs #3", [open(3)]), [3]);
});
