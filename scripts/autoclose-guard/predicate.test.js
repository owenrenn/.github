const { test } = require("node:test");
const assert = require("node:assert");
const {
  referenceIntentNumbers,
  closingIntentNumbers,
  explainReason,
  unsettled,
  verdict,
  renderComment,
  MARKER,
} = require("./predicate.js");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

// Bodies below are lifted from the real PRs that caused (or narrowly avoided)
// an orphaning, so the suite pins actual history rather than invented shapes.

const HERE = "example-org/example-repo";

// The historical tests below were written against `evaluate`, the advisory-era
// decision (#942 replaced it with `verdict`, which the workflow fails on). This
// adapter keeps those real bodies running through the LIVE decision instead of
// deleting the history with the function: `flagged` is everything `verdict`
// says merging would wrongly close, `unregistered` everything declared that did
// not register. Where the rule changed on purpose, the test says so.
const evaluate = ({ closingRefs = [], body = "", issueStates = {} } = {}) => {
  const v = verdict({ closingRefs, body, issueStates, repoSlug: HERE });
  const number = (key) => Number(key.slice(key.lastIndexOf("#") + 1));
  return {
    flagged: [...v.accidental, ...v.protected].map(r => ({ number: number(r.key), title: r.title, reasons: r.reasons })),
    unregistered: v.unregistered.map(u => ({ number: u.number, title: u.title })),
    fail: v.fail,
  };
};

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

test("type:project trackers stay covered when the close is NOT declared; a declared close is the final PR", () => {
  // CHANGED ON PURPOSE by #942. The label was a guess at intent while intent could not be read: this body
  // used to be flagged for carrying a `Closes` line at all. Intent is declared now, and a tracker's final PR
  // is exactly a declared close, so this passes. The tracker is still protected where it matters: registered
  // WITHOUT a declaration (a wave PR with a sidebar link), it fails, and the label is named.
  const tracker = { number: 212, title: "PM operating model", state: "OPEN", labels: ["type:project"] };
  assert.deepEqual(evaluate({ closingRefs: [tracker], body: "Layer 2 of the umbrella.\n\nCloses #212" }).flagged, []);
  const wave = evaluate({ closingRefs: [tracker], body: "Layer 2 of the umbrella.\n\nRefs #212" });
  assert.deepEqual(wave.flagged[0].reasons, ["contradiction", "type:project"]);
  assert.equal(wave.fail, true);
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
  for (const reason of ["contradiction", "prose-keyword", "undeclared", "type:project", "no-autoclose"]) {
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
  // A qualified ref is its own token and goes to the KEYED sets, never the number
  // sets, so another repository's number is never looked up as a local issue.
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

test("an unregistered number with no resolvable state IS reported: a typo is a close that will not fire", () => {
  // CHANGED ON PURPOSE by #942. This used to stay silent, on the reasoning that a nonexistent number orphans
  // nothing. But the author wrote a `Closes` line and meant to close SOMETHING, and nothing will close. A
  // failed state read lands here too, and an unreadable answer must not look like a clean one.
  for (const input of [{ closingRefs: [], body: "Closes #99999" }, { closingRefs: [], body: "Closes #99999", issueStates: {} }]) {
    const out = evaluate(input);
    assert.deepEqual(out.unregistered.map(u => u.number), [99999]);
    assert.equal(out.fail, true);
  }
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

test("a sidebar-only link (no keyword at all) is NOT prose-keyword, and is no longer silent", () => {
  // CHANGED ON PURPOSE by #942. It used to pass unless a label caught it, which is how two of the four
  // historical orphanings got through. Nothing in the body declares it, so it fails as `undeclared`.
  assert.deepEqual(evaluate({ closingRefs: [open(8)], body: "Unrelated summary." }).flagged.map(f => f.reasons), [["undeclared"]]);
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

// `unsettled` names what may be LAG, as `owner/repo#N` keys. It is key-aware since
// #942: declarations can be qualified now, and a number-only version never saw
// them, so `Closes owner/repo#7` went red on ordinary lag with no wait at all.
const K = (n) => `${HERE}#${n}`;

test("unsettled: a stated close not yet registered is lag-shaped", () => {
  assert.deepEqual(unsettled("Closes #5", [], HERE), [K(5)]);
});

test("unsettled: a QUALIFIED or URL declaration waits for registration like a bare one", () => {
  assert.deepEqual(unsettled(`Closes ${HERE}#7`, [], HERE), [K(7)]);
  assert.deepEqual(unsettled(`Closes https://github.com/${HERE}/issues/7`, [], HERE), [K(7)]);
  assert.deepEqual(unsettled(`Closes ${HERE}#7`, [{ repo: HERE, ...open(7) }], HERE), []);
  assert.deepEqual(unsettled("Closes example-org/other-repo#9", [], HERE), ["example-org/other-repo#9"]);
});

test("unsettled: a settled honest close is not", () => {
  assert.deepEqual(unsettled("Closes #5", [open(5)], HERE), []);
});

test("unsettled: a registered number the body now only references is lag-shaped", () => {
  // An edit swapped a closing keyword for `Refs`; GitHub hasn't dropped it yet.
  assert.deepEqual(unsettled("Refs #5", [open(5)], HERE), [K(5)]);
});

test("unsettled: a sidebar-only link the body never mentions never triggers a retry", () => {
  assert.deepEqual(unsettled("Unrelated summary.", [open(8)], HERE), []);
});

test("unsettled: the observed opened-race shape — a prose close, empty registered set", () => {
  const body = "Refs #40\n\nThe last PR of that step closes #40.";
  assert.deepEqual(unsettled(body, [], HERE), [K(40)]);
});

test("unsettled, pinned cost: a GENUINE mismatch waits the full budget, then reports", () => {
  // `Closes #1, #2` registers #1 alone — #2 never registers, so it stays
  // unsettled on every read. The guard waits out its retries and THEN reports
  // #2 as unregistered. A real contradiction (Refs + a registered close) behaves
  // the same. Pinned so the ~20s wait is a known cost, never a surprise.
  assert.deepEqual(unsettled("Closes #1, #2", [open(1)], HERE), [K(2)]);
  assert.deepEqual(unsettled("Refs #3", [open(3)], HERE), [K(3)]);
});

// ── the verdict: declared vs registered, and a RED check (#942) ───────────────
//
// The guard used to find the problem and exit `pass`, so the finding sat in a
// comment while the check row read green. It happened ten times, four of them to
// authors writing the rule down. The fix is surface placement: one exact
// comparison, and a non-zero exit when it fails.
//
// DECLARED is the template form and nothing else: a closing keyword on a line of
// its own. REGISTERED is GitHub's `closingIssuesReferences`. Write nothing and
// the PR declares that it closes nothing.

const reg = (number, extra = {}) => ({ repo: HERE, number, title: `issue ${number}`, state: "OPEN", labels: [], ...extra });
const judge = (body, closingRefs = [], more = {}) => verdict({ body, closingRefs, repoSlug: HERE, issueStates: {}, ...more });
const OPEN = (n) => ({ [n]: { state: "OPEN", title: `issue ${n}` } });

test("verdict, the table: nothing declared and nothing registered passes with zero ceremony", () => {
  const v = judge("Tidies the build.\n\nRefs #12");
  assert.equal(v.fail, false);
  assert.deepEqual([v.accidental, v.protected, v.unregistered, v.unverifiable], [[], [], [], []]);
  assert.equal(renderComment(v), null, "nothing to say, so no comment");
});

test("verdict, the table: registered with NOTHING declared fails: the accidental close", () => {
  // A Development-sidebar link carries no keyword at all, so no grep of the body can see it.
  const v = judge("Tidies the build.", [reg(938)]);
  assert.equal(v.fail, true);
  assert.deepEqual(v.accidental.map(a => [a.key, a.reasons]), [[`${HERE}#938`, ["undeclared"]]]);
});

test("verdict, the table: declared and NOT registered fails: the close that will not fire", () => {
  const v = judge("Closes #938", [], { issueStates: OPEN(938) });
  assert.equal(v.fail, true);
  assert.deepEqual(v.unregistered.map(u => u.key), [`${HERE}#938`]);
});

test("verdict, the table: declared and registered alike passes", () => {
  assert.equal(judge("Closes #938", [reg(938)]).fail, false);
});

test("verdict, the table: registered MORE than declared fails, naming only the extra", () => {
  const v = judge("Closes #938", [reg(938), reg(941)]);
  assert.equal(v.fail, true);
  assert.deepEqual(v.accidental.map(a => a.key), [`${HERE}#941`]);
});

test("verdict: every prose vector fails without modelling GitHub's parser", () => {
  // Negated wording under a heading: the exact body that started #942.
  const negated = judge("## This PR does not close #5\n\nMore work follows.", [reg(5)]);
  assert.equal(negated.fail, true);
  assert.deepEqual(negated.accidental[0].reasons, ["contradiction"]);
  // A keyword mid-sentence, in prose about what was NOT done.
  const prose = judge("Filed rather than fixed: #6 stays open.", [reg(6)]);
  assert.equal(prose.fail, true);
  assert.deepEqual(prose.accidental[0].reasons, ["prose-keyword"]);
  // A comma list: the body means two, GitHub registers one.
  const list = judge("Closes #11, #12", [reg(11)], { issueStates: OPEN(12) });
  assert.equal(list.fail, true);
  assert.deepEqual(list.unregistered.map(u => u.key), [`${HERE}#12`]);
  assert.deepEqual(list.accidental, []);
  // The second keyword of a one-line pair does not lead its line, so it is not a declaration.
  const pair = judge("Closes #1 and closes #2", [reg(1), reg(2)]);
  assert.deepEqual(pair.accidental.map(a => [a.key, a.reasons]), [[`${HERE}#2`, ["prose-keyword"]]]);
});

test("verdict: a FULLY QUALIFIED declaration is a declaration, in ref form and in URL form", () => {
  // The guard used to drop `owner/repo#N` from its intent sets entirely. Under an exact comparison that
  // would read as "declared nothing" and turn the form the fleet's own rule requires across repos red.
  assert.equal(judge(`Closes ${HERE}#7`, [reg(7)]).fail, false);
  assert.equal(judge(`Closes https://github.com/${HERE}/issues/7`, [reg(7)]).fail, false);
  assert.equal(judge("Closes Example-Org/Example-Repo#7", [reg(7)]).fail, false, "repository names compare case-insensitively");
  assert.equal(judge("Closes example-org/my_repo#7", [reg(7, { repo: "example-org/my_repo" })]).fail, false,
    "an underscore inside a name is not emphasis and must survive the markdown strip");
});

test("verdict: the comparison is by REPOSITORY and number, so a shared number cannot hide a mismatch", () => {
  const v = judge("Closes #7", [reg(7, { repo: "example-org/other-repo" })], { issueStates: OPEN(7) });
  assert.equal(v.fail, true);
  assert.deepEqual(v.accidental.map(a => a.key), ["example-org/other-repo#7"]);
  assert.deepEqual(v.unregistered.map(u => u.key), [`${HERE}#7`]);
});

test("verdict: another repository's issue that is declared and NOT visible is unverifiable, and says so without failing", () => {
  // The check runs with its caller's token, which cannot read another private repository. A declared
  // cross-repo close that is absent from the registered set may be registered and invisible. Calling that
  // red on every such PR would teach the eye to scroll past the row; calling it clean would be a lie.
  const v = judge("Closes example-org/other-repo#40");
  assert.equal(v.fail, false);
  assert.deepEqual(v.unverifiable, ["example-org/other-repo#40"]);
  const text = renderComment(v);
  assert.match(text, /example-org\/other-repo#40/);
  assert.match(text, /cannot (see|read)/);
  // Visible and registered, it is simply a match.
  const seen = judge("Closes example-org/other-repo#40", [reg(40, { repo: "example-org/other-repo" })]);
  assert.deepEqual([seen.fail, seen.unverifiable], [false, []]);
});

test("verdict: registered references the token cannot see are covered only by declarations that could be them", () => {
  const covered = judge("Closes example-org/other-repo#40", [], { invisibleRegistered: 1 });
  assert.equal(covered.fail, false);
  const extra = judge("Tidies the build.", [], { invisibleRegistered: 1 });
  assert.equal(extra.fail, true, "something will close on merge that the body never declared and this check cannot name");
  assert.equal(extra.unseen, 1);
  assert.match(renderComment(extra), /cannot (see|read)/);
});

test("verdict: an issue that is already CLOSED is not a finding in either direction", () => {
  assert.equal(judge("Tidies the build.", [reg(9, { state: "CLOSED" })]).fail, false);
  assert.equal(judge("Closes #9", [], { issueStates: { 9: { state: "CLOSED", title: "done" } } }).fail, false);
});

test("verdict: a declared number that names NO readable issue fails: a typo is a close that will not fire", () => {
  const v = judge("Closes #99999");
  assert.equal(v.fail, true);
  assert.deepEqual(v.unregistered.map(u => [u.key, u.known]), [[`${HERE}#99999`, false]]);
  assert.match(renderComment(v), /could not (read|find)/);
});

test("verdict: `no-autoclose` fails even when declared; a declared close of a project tracker passes", () => {
  // `no-autoclose` says "never by merge", so a declaration contradicts the issue's own marker. A project
  // tracker's FINAL PR is the legitimate declared close, and the label was only ever a guess at intent.
  const watch = judge("Closes #20", [reg(20, { labels: ["no-autoclose"] })]);
  assert.equal(watch.fail, true);
  assert.deepEqual(watch.protected.map(p => p.key), [`${HERE}#20`]);
  assert.equal(judge("Closes #21", [reg(21, { labels: ["type:project"] })]).fail, false);
  // Undeclared, the tracker is an accidental close like any other, and the label is named as a reason.
  assert.deepEqual(judge("Wave 2 of 5.", [reg(21, { labels: ["type:project"] })]).accidental[0].reasons, ["undeclared", "type:project"]);
});

test("renderComment: an unregistered close reads as LAG first, and says what to do after merge", () => {
  // GitHub's registration can run behind for hours. On a well-formed PR the row is red during that
  // stretch, so the words must not say the body is wrong.
  const text = renderComment(judge("Closes #938", [], { issueStates: OPEN(938) }));
  assert.match(text, /unregistered so far/i);
  assert.match(text, /re-check, then close by hand after merge/i);
  assert.equal(/your PR body is wrong/i.test(text), false);
  assert.ok(text.startsWith(MARKER));
});

test("renderComment: it says the check is RED and not required, and no longer calls itself advisory", () => {
  const text = renderComment(judge("Tidies the build.", [reg(938)]));
  assert.match(text, /never blocks the merge/);
  assert.match(text, /not a required check/);
  assert.equal(/Advisory only/i.test(text), false);
  assert.match(text, /#938/);
  assert.match(text, /on a line of its own/);
});

// ── the workflow itself, EXECUTED ────────────────────────────────────────────
//
// A workflow cannot be run in a test, but its inline script can: it is sliced out
// of the YAML and run against mock `github` / `core` / `context`. This replaced a
// set of pattern matches over the YAML text, which review showed stayed green
// with the non-zero exit deleted, with the repository dropped from every
// registered ref, and with `repoSlug` never passed (which would have turned every
// bare `Closes #N` red fleet-wide). Text can describe wiring; only running it
// shows the wiring works.

const GUARD_YML = readFileSync(join(__dirname, "../../.github/workflows/autoclose-guard.yml"), "utf8");
const guardScript = (() => {
  const opener = "          script: |\n";
  const at = GUARD_YML.indexOf(opener);
  assert.ok(at > 0, "the guard's inline script was not found — the harness is looking at nothing");
  const lines = [];
  for (const line of GUARD_YML.slice(at + opener.length).split("\n")) {
    if (line.trim() !== "" && !line.startsWith("            ")) break;
    lines.push(line.slice(12));
  }
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  return new AsyncFunction("github", "context", "core", "require", "process", "setTimeout", lines.join("\n"));
})();

const node = (number, extra = {}) => ({
  number, title: `issue ${number}`, state: "OPEN",
  repository: { nameWithOwner: "Example-Org/Example-Repo" },   // canonical case, as GitHub returns it
  labels: { nodes: [] }, ...extra,
});
const registeredRead = (nodes, totalCount = nodes.length) =>
  ({ repository: { pullRequest: { closingIssuesReferences: { totalCount, nodes } } } });

/**
 * Run the guard once. `reads` are the successive answers to the registered-set query (the last repeats);
 * an Error in the list is thrown. `states` answers the local state query by number, `cross` the
 * cross-repository one by `owner/repo#N`. Returns everything the script did, in order.
 */
async function runGuard({ body, reads = [registeredRead([])], states = {}, cross = {}, comments = [], writeFails = false }) {
  const log = [];
  const queue = [...reads];
  const queries = [];
  const core = {
    info: () => {}, warning: (m) => log.push(["warning", String(m)]), setFailed: (m) => log.push(["setFailed", String(m)]),
  };
  const github = {
    graphql: async (query, vars) => {
      queries.push(query);
      if (query.includes("closingIssuesReferences")) {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) throw next;
        return next;
      }
      if (query.includes("$number")) {
        const hit = cross[`${vars.owner}/${vars.repo}#${vars.number}`];
        if (!hit) throw Object.assign(new Error("Could not resolve to a Repository"), { data: { repository: null } });
        return { repository: { issue: { number: vars.number, ...hit } } };
      }
      const out = {};
      let missing = false;
      for (const [, alias, n] of query.matchAll(/(i\d+): issue\(number: (\d+)\)/g)) {
        out[alias] = states[n] ? { number: Number(n), ...states[n] } : null;
        if (!states[n]) missing = true;
      }
      if (missing) throw Object.assign(new Error("Could not resolve to an Issue"), { data: { repository: out } });
      return { repository: out };
    },
    paginate: async () => comments,
    rest: { issues: {
      listComments: () => {},
      createComment: async ({ body: text }) => { if (writeFails) throw new Error("Resource not accessible by integration"); log.push(["createComment", text]); },
      updateComment: async ({ body: text }) => { if (writeFails) throw new Error("Resource not accessible by integration"); log.push(["updateComment", text]); },
      deleteComment: async ({ comment_id }) => { log.push(["deleteComment", comment_id]); },
    } },
  };
  const context = { payload: { pull_request: { number: 26, body } }, repo: { owner: "example-org", repo: "example-repo" } };
  const waits = [];
  await guardScript(
    github, context, core,
    () => require("./predicate.js"),
    { env: { GITHUB_WORKSPACE: "/nowhere" } },
    (fn, ms) => { waits.push(ms); fn(); },
  );
  return {
    log, waits, queries,
    failed: log.filter(([k]) => k === "setFailed").map(([, m]) => m),
    warnings: log.filter(([k]) => k === "warning").map(([, m]) => m),
    did: log.map(([k]) => k),
  };
}

test("ACCEPTANCE (#942): an undeclared registered close FAILS the job, and the comment is written first", async () => {
  const r = await runGuard({ body: "Tidies the build.", reads: [registeredRead([node(938)])] });
  assert.equal(r.failed.length, 1, "the row is red");
  assert.match(r.failed[0], /1 will close undeclared/);
  assert.deepEqual(r.did.filter(k => k !== "warning"), ["createComment", "setFailed"], "the red row always has its explanation");
  assert.match(r.log[0][1], /example-org\/example-repo#938/);
});

test("workflow: a clean PR is green, and a stale guard comment from an earlier run is removed", async () => {
  const stale = { id: 77, user: { type: "Bot" }, body: `${MARKER}\nold finding` };
  const r = await runGuard({ body: "Tidies the build.\n\nRefs #12", comments: [stale] });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.log.filter(([k]) => k === "deleteComment").map(([, id]) => id), [77]);
});

test("workflow: a bare `Closes #N` that registered HERE is green: the repository reaches the verdict", async () => {
  // Kills three mutants at once: `repoSlug` not passed, every node attributed to a fixed repo, and the
  // registered side compared case-sensitively (the node carries GitHub's canonical case).
  const r = await runGuard({ body: "Closes #7", reads: [registeredRead([node(7)])] });
  assert.deepEqual([r.failed, r.did], [[], []]);
});

test("workflow: a cross-repository close that registered is matched to its own declaration", async () => {
  const other = { repository: { nameWithOwner: "example-org/other-repo" } };
  const ok = await runGuard({ body: "Closes example-org/other-repo#7", reads: [registeredRead([node(7, other)])] });
  assert.deepEqual(ok.failed, []);
  // The same registration with only a LOCAL declaration of that number is a mismatch both ways.
  const clash = await runGuard({ body: "Closes #7", reads: [registeredRead([node(7, other)])], states: { 7: { state: "OPEN", title: "local seven" } } });
  assert.match(clash.failed[0], /1 will close undeclared, 1 unregistered so far/);
});

test("workflow: a registered ref it cannot read is COUNTED, whether the node is null or has no repository", async () => {
  const hidden = await runGuard({ body: "Tidies the build.", reads: [registeredRead([null])] });
  assert.match(hidden.failed[0], /1 unreadable and undeclared/);
  // A node with no repository cannot be attributed. Calling it local would let it match a local `Closes #7`.
  const orphan = await runGuard({ body: "Closes #7", reads: [registeredRead([node(7, { repository: null })])], states: { 7: { state: "OPEN", title: "local seven" } } });
  assert.match(orphan.failed[0], /1 unregistered so far, 1 unreadable and undeclared/);
});

test("workflow: PARTIAL data is the answer for what it could read; no data at all is a crash, and says so", async () => {
  const partial = Object.assign(new Error("Resource not accessible"), { data: registeredRead([node(5), null]) });
  const r = await runGuard({ body: "Closes #5\nCloses example-org/private#9", reads: [partial] });
  assert.deepEqual(r.failed, [], "#5 matched, and the unreadable one is accounted for by the cross-repository declaration");
  const dead = await runGuard({ body: "Closes #5", reads: [new Error("upstream connect error")] });
  assert.match(dead.failed[0], /crashed/);
  assert.match(dead.log.find(([k]) => k === "createComment")[1], /was NOT checked/);
});

test("workflow: a QUALIFIED declaration waits out registration lag like a bare one", async () => {
  const body = "Closes example-org/example-repo#7";
  const r = await runGuard({ body, reads: [registeredRead([]), registeredRead([node(7)])] });
  assert.deepEqual(r.failed, [], "the second read registered it");
  assert.deepEqual(r.waits, [5000], "one wait, then settled");
});

test("workflow: when the comment cannot be written, the verdict still fails the job, and is not reported as a crash", async () => {
  // A fork PR's token is read-only. The finding was computed; a 403 on the comment must not turn it into
  // "the guard crashed, this PR was NOT checked", which is false, and the row is now the only signal.
  const r = await runGuard({ body: "Tidies the build.", reads: [registeredRead([node(938)])], writeFails: true });
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0], /1 will close undeclared/);
  assert.equal(/crashed/.test(r.failed[0]), false);
  assert.ok(r.warnings.some(w => /could not write the comment/i.test(w)));
});

test("workflow: more registered refs than one page holds is refused, never judged on the first 25", async () => {
  const many = Array.from({ length: 25 }, (_, i) => node(100 + i));
  const r = await runGuard({ body: "Tidies the build.", reads: [registeredRead(many, 26)] });
  assert.match(r.failed[0], /crashed.*26 registered/);
});

test("workflow: a declared close of an issue that is already CLOSED is quiet: the states reach the final verdict", async () => {
  const r = await runGuard({ body: "Closes #8", states: { 8: { state: "CLOSED", title: "done" } } });
  assert.deepEqual(r.failed, []);
});

test("workflow: a number too large to be an issue is never sent to the API, and does not cost its neighbour its state", async () => {
  const r = await runGuard({ body: "Closes #8\nCloses #99999999999", states: { 8: { state: "CLOSED", title: "done" } } });
  assert.match(r.failed[0], /1 unregistered so far/, "#8 is closed and quiet; only the impossible number is reported");
  assert.equal(r.queries.some(q => /99999999999|e\+/.test(q)), false);
});

test("workflow: another repository's declared close is judged if the token can read it, and only said if it cannot", async () => {
  const body = "Closes example-org/other-repo#40";
  const readable = await runGuard({ body, cross: { "example-org/other-repo#40": { state: "OPEN", title: "forty" } } });
  assert.match(readable.failed[0], /1 unregistered so far/);
  const blind = await runGuard({ body });
  assert.deepEqual(blind.failed, []);
  assert.ok(blind.warnings.some(w => /cannot verify.*example-org\/other-repo#40/.test(w)));
  assert.deepEqual(blind.did.filter(k => k !== "warning"), ["createComment"], "said in a comment, on a green row");
});

test("this repo's own PRs run the BRANCH's decision logic, and every other caller gets main's", () => {
  // The workflow file and the predicate are fetched two ways. `uses: ./…` gave this repo's PRs the branch's
  // workflow, while the checkout fetched the predicate from `main`: the PR that added `verdict` crashed on
  // itself, and a PR changing both files could not be checked before merge.
  const guard = readFileSync(join(__dirname, "../../.github/workflows/autoclose-guard.yml"), "utf8");
  assert.match(guard, /logic_ref:[\s\S]*?default: "main"/, "callers that pass nothing read main");
  assert.match(guard, /repository: owenrenn\/\.github\n\s+ref: \$\{\{ inputs\.logic_ref \}\}/);
  const own = readFileSync(join(__dirname, "../../.github/workflows/guard-own-prs.yml"), "utf8");
  // `github.sha`, NOT the PR's head: on `pull_request` the workflow file comes from the test-merge commit
  // (main merged with the branch), so the logic has to come from that same commit. The head alone skews the
  // other way the moment main moves under an open PR.
  assert.match(own, /uses: \.\/\.github\/workflows\/autoclose-guard\.yml\n\s+with:\n(?:\s+#.*\n)*\s+logic_ref: \$\{\{ github\.sha \}\}/);
  assert.equal(/still read from `main`/.test(own), false, "the stale claim that contradicted the line above is gone");
});

// ── review of the #942 branch: the parse ─────────────────────────────────────

test("a declaration does NOT chain across a line break: the next paragraph's `#N` is a mention", () => {
  // The gap rule allowed any whitespace, newlines included. Harmless while the guard only advised; under a
  // failing verdict, a body whose next paragraph opens with an issue number declared that issue too.
  assert.deepEqual([...closingIntentNumbers("Closes #5\n\n#6 tracks the follow-up.")], [5]);
  assert.deepEqual([...closingIntentNumbers("Fixes #5\n\n\n#6, #7 and #8 are related but stay open.")], [5]);
  assert.equal(judge("Closes #5\n\n#6 tracks the follow-up.", [reg(5)], { issueStates: OPEN(6) }).fail, false);
  // On ONE line a list still chains, so the comma list keeps failing as it must.
  assert.deepEqual([...closingIntentNumbers("Closes #1, #2")], [1, 2]);
});

test("an owner or repository that starts with a KEYWORD is still one ref", () => {
  // The keyword alternative was tried first, so `close-io/x#7` was read as the keyword `close`.
  for (const repo of ["close-io/repo", "fix-org/repo", "see-saw/x", "ref-lab/x", "example-org/closes"]) {
    assert.equal(judge(`Closes ${repo}#7`, [reg(7, { repo })]).fail, false, repo);
  }
});

test("repository names keep their dots and underscores, wherever they sit", () => {
  for (const repo of ["example-org/.github", "example-org/my.repo-x", "example-org/my__repo", "example-org/_repo", "example-org/repo_"]) {
    assert.equal(judge(`Closes ${repo}#7`, [reg(7, { repo })]).fail, false, repo);
  }
  // Emphasis underscores are still stripped, so `_Closes #5_` and `Does _not_ close #5` read as before.
  assert.deepEqual([...closingIntentNumbers("_Closes #5_")], [5]);
  assert.deepEqual([...referenceIntentNumbers("Does _not_ close #5")], [5]);
  // An owner cannot start with `-`, so stray punctuation is not swallowed into the name: the ref is read as
  // `example-org/x#5`. (It is then a bare mention, because `-` is not list punctuation after a keyword.)
  assert.deepEqual(judge("Closes -example-org/x#5", [reg(5, { repo: "example-org/x" })]).accidental.map(a => a.key), ["example-org/x#5"]);
});

test("the registered side is compared case-insensitively too: GitHub returns the canonical case", () => {
  assert.equal(judge("Closes example-org/example-repo#7", [reg(7, { repo: "Example-Org/Example-Repo" })]).fail, false);
  assert.equal(verdict({ body: "Closes #7", closingRefs: [reg(7, { repo: "Example-Org/Example-Repo" })], repoSlug: "EXAMPLE-ORG/example-repo" }).fail, false);
});

test("a QUALIFIED close is a declaration only when it leads its line, and it carries its reason when it does not", () => {
  const other = "example-org/other-repo";
  const prose = judge(`This also fixes ${other}#4 in passing.`, [reg(4, { repo: other })]);
  assert.deepEqual(prose.accidental.map(a => [a.key, a.reasons]), [[`${other}#4`, ["prose-keyword"]]]);
  const negated = judge(`Does not close ${other}#4.`, [reg(4, { repo: other })]);
  assert.deepEqual(negated.accidental[0].reasons, ["contradiction"]);
});

test("`GH-5` is the same ref as `#5`", () => {
  assert.equal(judge("Closes GH-5", [reg(5)]).fail, false);
});

test("a line inside a FENCED code block is an example, not a declaration", () => {
  // A body that quotes the rule ("write it like this") would otherwise declare the example and go red.
  const body = "How to close:\n\n```\nCloses #12\n```\n\nRefs #3";
  assert.deepEqual([...closingIntentNumbers(body)], []);
  assert.equal(judge(body).fail, false);
  // If GitHub did register it, the PR is still caught, as undeclared.
  assert.equal(judge(body, [reg(12)]).fail, true);
});

// ── review of the #942 branch: the verdict ───────────────────────────────────

test("verdict REFUSES to run without a repository: every bare `#N` would be compared against nothing", () => {
  assert.throws(() => verdict({ body: "Closes #5", closingRefs: [] }), /repoSlug/);
  assert.throws(() => verdict({ body: "Closes #5", closingRefs: [], repoSlug: "" }), /repoSlug/);
});

test("verdict: a registered ref whose state is MISSING is treated as open, never skipped", () => {
  const v = judge("Tidies the build.", [reg(9, { state: undefined })]);
  assert.equal(v.fail, true);
});

test("verdict: a ref registered twice is reported once", () => {
  assert.equal(judge("Tidies the build.", [reg(9), reg(9)]).accidental.length, 1);
});

test("verdict: a cross-repository close the token CAN read is judged, not waved through as unverifiable", () => {
  // `Closes other#1, other#2` registers `other#1` alone: the comma-list bug, in a repository this check
  // can see. "Unverifiable" is for a repository it cannot read, and whether it can is measured: the
  // workflow tries to read each such issue and passes what it got as `crossStates`.
  const other = "example-org/other-repo";
  const body = `Closes ${other}#1, ${other}#2`;
  const readable = judge(body, [reg(1, { repo: other })], { crossStates: { [`${other}#2`]: { state: "OPEN", title: "two" } } });
  assert.equal(readable.fail, true);
  assert.deepEqual(readable.unregistered.map(u => u.key), [`${other}#2`]);
  assert.deepEqual(readable.unverifiable, []);
  // Readable and already closed: nothing to orphan.
  assert.equal(judge(body, [reg(1, { repo: other })], { crossStates: { [`${other}#2`]: { state: "CLOSED", title: "two" } } }).fail, false);
  // Not readable: still said, still not failed.
  const blind = judge(body, [reg(1, { repo: other })]);
  assert.deepEqual([blind.fail, blind.unverifiable], [false, [`${other}#2`]]);
});

// ── review of the #942 branch: the comment ───────────────────────────────────

test("renderComment: it says how the red row CLEARS, because a registration arriving later fires no event", () => {
  // The guard runs on opened / edited / reopened / ready_for_review. When GitHub registers late, or the
  // sidebar link is removed, none of those fire, so the row stays red until someone re-runs the check.
  const lag = renderComment(judge("Closes #938", [], { issueStates: OPEN(938) }));
  assert.match(lag, /re-run this check/i);
  const sidebar = renderComment(judge("Tidies the build.", [reg(938)]));
  assert.match(sidebar, /re-run this check/i);
  assert.equal(/clears itself when declared and registered agree/.test(lag + sidebar), false, "it does not clear by itself");
});

test("renderComment: advice for another repository's issue names it in the qualified form", () => {
  const other = "example-org/other-repo";
  const text = renderComment(judge("Tidies the build.", [reg(4, { repo: other })]));
  assert.match(text, new RegExp(`Closes ${other}#4`));
  assert.match(text, new RegExp(`Refs ${other}#4`));
  // A local issue keeps the short form.
  assert.match(renderComment(judge("Tidies the build.", [reg(938)])), /`Closes #938`/);
});

test("renderComment: every section a verdict can carry is rendered, and an unseen-only verdict reads on its own", () => {
  const watch = renderComment(judge("Closes #20", [reg(20, { labels: ["no-autoclose"] })]));
  assert.match(watch, /no-autoclose/);
  assert.match(watch, /#20/);
  const unseen = renderComment(judge("Tidies the build.", [], { invisibleRegistered: 2 }));
  assert.match(unseen, /Merging will close \*\*2\*\* issue\(s\) this check cannot read/);
});
