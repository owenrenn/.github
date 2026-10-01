// Decision logic for the auto-close guard.
//
// WHY this file exists separately from the workflow: the guard's logic used to
// live inline in `github-script` YAML, where it could not be unit-tested — and
// it shipped a predicate that was wrong for four real trackers before anyone
// noticed. The workflow keeps only I/O — GraphQL in, comment out — and calls
// `verdict`, so the decision is testable without executing a workflow.
//
// ── What it decides ───────────────────────────────────────────────────────────
// GitHub auto-closes an issue on merge when the PR *registers* it as a closing
// reference — via a body keyword OR via the Development sidebar. Prose in the
// body ("does not close #N") does NOT override that registration. Four
// long-lived trackers were orphaned this way before the guard existed; the
// costliest sat closed and unnoticed for roughly six weeks.
//
// The last of those four is why the predicate changed. The original guard
// fired only on a `type:project` label; that tracker was a long-lived watch
// ticket wearing a different type label, so it carried the same risk profile
// and no coverage. The lesson: what makes an issue auto-close-dangerous is
// being a multi-wave / watch-state tracker, not carrying one particular label.
// So we detect the *contradiction* directly — the PR says "reference" but
// GitHub says "close" — and keep label predicates as a second signal.
//
// A third signal, `prose-keyword`, came from a later miss: the guard reported
// OK over the exact mistake it exists for. A PR body explained that an issue
// had been filed rather than addressed, and the past-tense closing verb with a
// colon sat directly before the number, mid-sentence. GitHub registered it as a
// close. The walk attributed that number to a closing keyword, so it counted as
// STATED intent; stated and registered agreed; neither direction fired. The fix
// is positional: only a keyword that LEADS its line counts as intentional (the
// template form, `Closes #N` on a line of its own). A registered close whose
// every keyword sits mid-sentence is flagged. This failure has recurred many
// times, each by an author who knew the rule — which is why it is enforced here
// rather than written down somewhere else.
//
// And since #942 the answer is a VERDICT the workflow fails on, not a warning it
// posts: `verdict` below compares what the body DECLARES (a line-leading closing
// keyword, nothing else) with what GitHub REGISTERED, by repository and number.
// The advisory-era `evaluate` is gone. Its three signals survive inside `verdict`
// as the REASON a registered close was not declared, and the historical PR
// bodies that pinned it now run through `verdict` in the suite.

/**
 * Labels that mark an issue as never-auto-closable regardless of PR wording.
 * `type:project` is the original predicate (kept — zero regression for the
 * multi-wave trackers it already protects); `no-autoclose` is the explicit
 * opt-in marker for watch tickets that wear some other type label, which is
 * precisely the hole a label-only predicate leaves open.
 */
const PROTECTED_LABELS = ["type:project", "no-autoclose"];

/**
 * Keywords GitHub itself treats as closing. Matched here only to determine the
 * PR author's *stated intent* — the authoritative "will this close?" answer
 * comes from GraphQL's `closingIssuesReferences`, never from this list.
 */
const CLOSING_WORDS = new Set([
  "close", "closes", "closed",
  "fix", "fixes", "fixed",
  "resolve", "resolves", "resolved",
]);

/** Keywords that state a non-closing reference. */
const REFERENCE_WORDS = new Set([
  "ref", "refs", "reference", "references", "see",
]);

const ALL_WORDS = [...CLOSING_WORDS, ...REFERENCE_WORDS];

// One pass yields keywords and issue refs in document order, so each ref can be
// attributed to the keyword that governs it. Alternation order matters: the
// longer forms must precede their prefixes or `close` would shadow `closes`.
//
// A ref is one of three shapes, and all three are ONE token:
//   `#12`                                        this repository's issue
//   `owner/repo#12`                              a named repository's issue
//   `https://github.com/owner/repo/issues/12`    the same, as a URL
// The qualified shapes matter since #942: an exact comparison of declared and
// registered has to see the form a cross-repository close is REQUIRED to take,
// or it reads that PR as declaring nothing.
const NAME = "[A-Za-z0-9_.-]+";
const TOKEN_RE = new RegExp(
  `\\b(${ALL_WORDS.sort((a, b) => b.length - a.length).join("|")})\\b` +
  `|https?://github\\.com/(${NAME}/${NAME})/issues/(\\d+)` +
  `|(?:(${NAME}/${NAME}))?#(\\d+)`,
  "gi",
);

// A `#N` belongs to the preceding keyword only if nothing but list punctuation
// sits between them. This is what makes `Refs #11, #12` attribute BOTH numbers
// to `Refs`, while `Closes #11. This also touches #12.` leaves #12 ungoverned
// rather than wrongly inheriting `Closes`.
const LIST_GAP_RE = /^(?:[\s,;:.]|and|also|&)*$/i;

// A closing keyword directly negated states reference intent, not closing
// intent — "Does not close #N" is the exact prose that lulled a real PR into
// believing its disclaimer was load-bearing.
// Anchored to the end of the preceding text so it only matches a negation
// attached to *this* keyword, not one somewhere earlier in the paragraph.
const NEGATION_RE = /(?:\bnot\b|\bnever\b|n't)\s*$/i;

/**
 * Markdown emphasis is decoration, not content, and it lands mid-phrase in
 * real PR bodies — `Does **not** close #N` and `` `Refs #N` `` both came from
 * a single observed PR. Stripping it first lets the matchers stay simple.
 */
function normalize(body) {
  // An underscore is emphasis only at the EDGE of a word. Inside one it is part
  // of a name, and stripping it turned `owner/my_repo#7` into a different
  // repository, which an exact comparison then reported as a mismatch.
  return String(body || "")
    .replace(/[*`~]/g, "")
    .replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, "");
}

/**
 * Single pass over the body yielding BOTH intent sets. They are computed
 * together because they come from the same attribution walk — the governing
 * keyword decides which set a `#N` lands in — and splitting the walk in two
 * would let the two directions drift apart.
 *
 * `closingLeading` is the subset of `closing` stated by at least one keyword
 * that LEADS its line. A number in `closing` but not `closingLeading` was only
 * ever closed by prose.
 *
 * The three NUMBER sets hold bare `#N` refs only, exactly as before: a qualified
 * ref is never mistaken for one of this repository's numbers and looked up
 * locally. `keyed` holds the same three sets for qualified refs, as lower-cased
 * `owner/repo#N` strings. `verdict` joins the two once it knows which repository
 * "here" is.
 *
 * @param {string} body raw PR body
 * @returns {{reference: Set<number>, closing: Set<number>, closingLeading: Set<number>,
 *   keyed: {reference: Set<string>, closing: Set<string>, closingLeading: Set<string>}}}
 */
function intentNumbers(body) {
  const text = normalize(body);
  const reference = new Set();
  const closing = new Set();
  const closingLeading = new Set();
  const keyed = { reference: new Set(), closing: new Set(), closingLeading: new Set() };

  let governor = null; // { isReference: boolean, leading: boolean }
  let governorEnd = -1; // index just past the last attributed token

  for (const m of text.matchAll(TOKEN_RE)) {
    const [raw, word, urlRepo, urlNum, refRepo, refNum] = m;

    if (word) {
      const preceding = text.slice(Math.max(0, m.index - 24), m.index);
      const isClosing = CLOSING_WORDS.has(word.toLowerCase());
      // Line-leading = nothing but whitespace between the line start and the
      // keyword. Measured AFTER normalize(), so `**Closes** #N` still leads. A
      // list marker or blockquote does NOT lead — a deliberate policy choice: the
      // template form is the only intentional one. `\r\n` bodies are fine: the
      // slice starts after the `\n`.
      const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
      governor = {
        isReference: !isClosing || NEGATION_RE.test(preceding),
        leading: /^\s*$/.test(text.slice(lineStart, m.index)),
      };
      governorEnd = m.index + raw.length;
      continue;
    }

    // An issue ref. Attribute it to the governor only if the intervening text
    // is pure list punctuation; otherwise it's a bare mention with no intent.
    const repo = urlRepo || refRepo || null;
    const n = Number(urlNum || refNum);
    const gap = text.slice(governorEnd, m.index);
    if (governor && governorEnd >= 0 && LIST_GAP_RE.test(gap)) {
      // A qualified ref goes to `keyed` and NEVER to the number sets: another
      // repository's numbering must not be mistaken for one of ours.
      const sets = repo ? keyed : { reference, closing, closingLeading };
      const item = repo ? `${repo.toLowerCase()}#${n}` : n;
      if (governor.isReference) {
        sets.reference.add(item);
      } else {
        sets.closing.add(item);
        if (governor.leading) sets.closingLeading.add(item);
      }
      governorEnd = m.index + raw.length; // chain onward through `#a, #b, #c`
    } else {
      governor = null;
      governorEnd = -1;
    }
  }

  return { reference, closing, closingLeading, keyed };
}

/**
 * Issue numbers the PR body refers to with non-closing intent — either an
 * explicit reference keyword (`Refs #N`) or a negated closing keyword
 * (`does not close #N`).
 *
 * @param {string} body raw PR body
 * @returns {Set<number>}
 */
function referenceIntentNumbers(body) {
  return intentNumbers(body).reference;
}

/**
 * Issue numbers the PR body states it will CLOSE (`Closes #N`, `Fixes #N`).
 *
 * WHY this is not redundant with `closingIssuesReferences`: the two are
 * supposed to agree, and silently don't. GitHub requires a keyword before
 * EACH number, so `Closes #11, #12` registers **#11 alone** and reads #12 as
 * a bare mention. Stated intent and GitHub's computed set then diverge in the
 * direction that leaves work open, with nothing in the PR timeline saying so.
 * ⚠️ A real PR shipped exactly this while an earlier version of this guard was
 * GREEN, because every check it ran was over the computed set — and the
 * dropped number was never in it. An omission reads as an all-clear.
 *
 * @param {string} body raw PR body
 * @returns {Set<number>}
 */
function closingIntentNumbers(body) {
  return intentNumbers(body).closing;
}

/** Human-readable explanation per reason, used to build the PR comment. */
function explainReason(reason) {
  switch (reason) {
    case "contradiction":
      return "the PR body references it with `Refs`/negated wording, but it is registered as a **closing** reference — prose does not override the registration";
    case "prose-keyword":
      return "it is registered as a **closing** reference only because a closing keyword sits right before its number **mid-sentence** — often in prose saying the issue was *not* addressed. If you mean to close it, put `Closes #N` on a line of its own; if not, break the keyword/number pair";
    case "undeclared":
      return "no closing keyword in the body declares it: a **Development-sidebar link**, or a keyword GitHub read that this check's line rule does not";
    case "type:project":
      return "it is an open `type:project` multi-wave tracker";
    case "no-autoclose":
      return "it carries `no-autoclose` (a long-lived watch ticket)";
    default:
      return reason;
  }
}

/**
 * Numbers where the body and GitHub's registered set disagree in a way that may
 * be LAG rather than a real mismatch (#916).
 *
 * `closingIssuesReferences` is eventually consistent: read within seconds of a
 * body write, it can still return the set as it was BEFORE the write. On
 * `opened` that is an empty set — the guard reported OK over a PR whose close
 * registered moments later, and a PR opened in its final form is only ever
 * checked on `opened`.
 *
 * Two lag shapes, both cheap to wait out:
 *   - stated as closing, not registered yet: a write GitHub hasn't applied;
 *   - registered, and the body now references it with `Refs`/negated wording:
 *     an edit that dropped a closing keyword, not applied yet.
 * A registered number the body never mentions (a sidebar-only link) is NOT
 * lag-shaped and never triggers a retry.
 *
 * The workflow re-reads while this is non-empty, then evaluates the LATEST read
 * regardless. So a genuine mismatch — a comma list that registered one number,
 * or a real contradiction — costs the retry budget in seconds, never a missed
 * report, and the waiting stays inside the 1-minute billing floor.
 *
 * @param {string} body raw PR body
 * @param {Array<{number:number}>} [closingRefs] GitHub's registered set, as read
 * @returns {number[]} ascending
 */
function unsettled(body, closingRefs = []) {
  const { reference, closing } = intentNumbers(body);
  const registered = new Set(closingRefs.map(r => r.number));
  const out = new Set();
  for (const n of closing) if (!registered.has(n)) out.add(n);
  for (const n of registered) if (reference.has(n)) out.add(n);
  return [...out].sort((a, b) => a - b);
}

/** Marker on the guard's own PR comment, so a later run can find and replace it. */
const MARKER = "<!-- autoclose-guard -->";

/**
 * THE VERDICT (#942): does what this PR DECLARES it closes equal what GitHub
 * REGISTERED it will close?
 *
 * WHY a verdict and not a warning: the guard used to reach the right answer
 * and exit `pass`. The finding sat in a comment while the check row, the
 * surface people act on, read green. That happened ten times, four of them to
 * authors writing the rule down at the time. So the finding moves onto the
 * status surface: `fail` is what the workflow turns into a non-zero exit.
 *
 * DECLARED is one thing only: a closing keyword that LEADS its line, the
 * template form (`Closes #N`, `Closes owner/repo#N`, or the issue URL). Write
 * nothing and the PR declares that it closes nothing. Closing is opt-in.
 * ⚠️ The declaration is itself a closing keyword, on purpose. A separate field
 * was considered and rejected: it adds a second line to every closing PR, and
 * the obvious name for it ("auto-close", a colon, a number) is itself a closing
 * keyword. With "nothing written means nothing closed" as the default, the only
 * way to declare is to write the line that is meant to close, so the two
 * cannot drift apart.
 *
 * REGISTERED is `closingIssuesReferences`, GitHub's own answer. Nothing here
 * models GitHub's parser to decide what will close, which is why negation,
 * table cells, headings, comma lists and Development-sidebar links all reduce
 * to the same comparison.
 *
 * The comparison is by REPOSITORY and number. `repoSlug` names "here"; a bare
 * `#N` is here.
 *
 * What fails:
 *   accidental    registered, OPEN, and not declared
 *   protected     registered, OPEN, declared, and carrying `no-autoclose`
 *   unregistered  declared here, and not registered (unless known CLOSED)
 *   unseen        registered refs the token cannot read, beyond what the
 *                 body's cross-repository declarations could account for
 *
 * What does NOT fail, and is still said: `unverifiable`, a declared close of
 * ANOTHER repository's issue that is absent from the registered set. This
 * check runs on its caller's token, which cannot read another private
 * repository, so "absent" may mean "registered and invisible". Red on every
 * such PR would teach the eye to scroll past the row; silence would be a lie.
 *
 * ⚠️ Not covered, by construction: a keyword that arrives in a commit message
 * folded into a squash merge. It registers at merge time, after any check.
 *
 * @param {object} input
 * @param {Array<{repo?:string,number:number,title:string,state:string,labels?:string[]}>} input.closingRefs
 * @param {string} input.body PR body
 * @param {string} input.repoSlug `owner/repo` of the PR's own repository
 * @param {Object<number,{state:string,title:string}>} [input.issueStates]
 *   State of the declared-but-unregistered issues HERE. A number absent from it
 *   could not be read: it names no issue, or the read failed. Either way the
 *   author meant to close something and nothing says it will, so it fails.
 * @param {number} [input.invisibleRegistered] registered refs returned as null
 */
function verdict({ closingRefs = [], body = "", repoSlug = "", issueStates = {}, invisibleRegistered = 0 } = {}) {
  const here = String(repoSlug).toLowerCase();
  const local = (n) => `${here}#${n}`;
  const walk = intentNumbers(body);
  const keysOf = (name) => new Set([...[...walk[name]].map(local), ...walk.keyed[name]]);
  const declared = keysOf("closingLeading");
  const stated = keysOf("closing");
  const referenced = keysOf("reference");

  const keyOf = (ref) => `${String(ref.repo || repoSlug).toLowerCase()}#${ref.number}`;
  const registered = new Set(closingRefs.map(keyOf));

  const accidental = [];
  const protectedRefs = [];
  for (const ref of closingRefs) {
    // A closed issue cannot be wrongly closed again.
    if (String(ref.state).toUpperCase() !== "OPEN") continue;
    const key = keyOf(ref);
    const labels = ref.labels || [];
    if (declared.has(key)) {
      // `no-autoclose` means "never by merge", so a declaration contradicts the
      // issue's own marker. `type:project` does NOT fail here: a tracker's final
      // PR is the legitimate declared close, and the label was only ever a
      // stand-in for intent that could not be read.
      if (labels.includes("no-autoclose")) protectedRefs.push({ key, title: ref.title, reasons: ["no-autoclose"] });
      continue;
    }
    // Most diagnostic first: the reason says HOW it got registered.
    const reasons = [referenced.has(key) ? "contradiction" : stated.has(key) ? "prose-keyword" : "undeclared"];
    for (const label of PROTECTED_LABELS) if (labels.includes(label)) reasons.push(label);
    accidental.push({ key, title: ref.title, reasons });
  }

  const unregistered = [];
  const unverifiable = [];
  for (const key of declared) {
    if (registered.has(key)) continue;
    const [repo, number] = [key.slice(0, key.lastIndexOf("#")), Number(key.slice(key.lastIndexOf("#") + 1))];
    if (repo !== here) { unverifiable.push(key); continue; }
    const known = issueStates[number];
    // Already closed: nothing is orphaned, and the row stays quiet.
    if (known && String(known.state).toUpperCase() !== "OPEN") continue;
    unregistered.push({ key, number, title: known ? known.title : null, known: Boolean(known) });
  }

  // Registered refs the token could not read. Each could be one of the body's
  // cross-repository declarations. Any beyond that count will close on merge
  // with nothing in the body declaring it, and this check cannot even name it.
  const unseen = Math.max(0, invisibleRegistered - unverifiable.length);

  return {
    fail: accidental.length > 0 || protectedRefs.length > 0 || unregistered.length > 0 || unseen > 0,
    accidental, protected: protectedRefs, unregistered, unverifiable, unseen,
  };
}

/**
 * The PR comment for a verdict, or `null` when there is nothing to say.
 *
 * Pure and here, not in the workflow, so its wording is tested. One sentence
 * matters more than the rest: an unregistered close is described as LAG first.
 * GitHub's registration can run hours behind, and during that stretch a
 * well-formed PR is red. A comment telling its author the body is wrong sends
 * them to edit a body that is right.
 */
function renderComment(v) {
  if (!v.fail && v.unverifiable.length === 0) return null;
  const out = [MARKER];
  out.push(v.fail
    ? "🔴 **This PR's declared closes do not match what merging will do.**"
    : "ℹ️ **This PR declares a close this check cannot verify.**");

  if (v.accidental.length > 0) {
    out.push(
      "",
      "Merging will **close** these open issues, and the body does not declare it:",
      "",
      v.accidental.map(r => [
        `- **${r.key}** — ${r.title}`,
        ...r.reasons.map(reason => `  - ${explainReason(reason)}`),
      ].join("\n")).join("\n"),
      "",
      "A close is declared by a closing keyword **on a line of its own** (`Closes #N`), and by nothing else.",
      "",
      "- **Meant to close it:** add that line.",
      "- **Did not mean to:** change the wording to `Refs #N`, and unlink the issue from the Development sidebar. The sidebar link closes it with no keyword at all.",
    );
  }

  if (v.protected.length > 0) {
    out.push(
      "",
      "These issues carry `no-autoclose` and will be closed by this merge:",
      "",
      v.protected.map(r => `- **${r.key}** — ${r.title}`).join("\n"),
      "",
      "Change the line to `Refs #N` and close the issue by hand when its watch is over.",
    );
  }

  if (v.unregistered.length > 0) {
    out.push(
      "",
      "**Unregistered so far:** the body declares these closes, and GitHub has not registered them.",
      "",
      v.unregistered.map(r => r.known
        ? `- **${r.key}** — ${r.title}`
        : `- **${r.key}** — this check could not read that issue: a wrong number, or a read that failed`).join("\n"),
      "",
      "GitHub's registration can lag a body edit, sometimes by a long way. **Re-check, then close by hand after merge** if it still has not registered:",
      "",
      "```bash",
      "gh pr view <number> --json closingIssuesReferences",
      "```",
      "",
      "If it never registers, check the line itself: GitHub needs a keyword before **each** number, so `Closes #1, #2` registers `#1` only.",
    );
  }

  if (v.unverifiable.length > 0) {
    out.push(
      "",
      "These declared closes are in **another repository**, and this check cannot see whether they registered (it runs on this repository's token):",
      "",
      v.unverifiable.map(k => `- **${k}**`).join("\n"),
      "",
      "Confirm with your own token before relying on the merge to close them.",
    );
  }

  if (v.unseen > 0) {
    out.push(
      "",
      `Merging will also close **${v.unseen}** issue(s) this check cannot read, likely in another repository, that the body does not declare. Check the Development sidebar.`,
    );
  }

  out.push(
    "",
    v.fail
      ? "_This check is red on purpose and is not a required check: it never blocks the merge. It clears itself when declared and registered agree._"
      : "_The check is green: nothing it could read disagrees._",
  );
  return out.join("\n");
}

module.exports = {
  referenceIntentNumbers,
  closingIntentNumbers,
  explainReason,
  unsettled,
  verdict,
  renderComment,
  MARKER,
  PROTECTED_LABELS,
};
