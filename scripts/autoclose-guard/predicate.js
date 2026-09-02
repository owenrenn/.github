// Decision logic for the auto-close guard.
//
// WHY this file exists separately from the workflow: the guard's logic used to
// live inline in `github-script` YAML, where it could not be unit-tested — and
// it shipped a predicate that was wrong for four real trackers before anyone
// noticed. The workflow keeps only I/O — GraphQL in, comment out — and calls
// `evaluate`, so the decision is testable without executing a workflow.
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

// One pass yields keywords and issue refs in document order, so each `#N` can
// be attributed to the keyword that governs it. Alternation order matters: the
// longer forms must precede their prefixes or `close` would shadow `closes`.
const TOKEN_RE = new RegExp(
  `\\b(${ALL_WORDS.sort((a, b) => b.length - a.length).join("|")})\\b|#(\\d+)`,
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
  return String(body || "").replace(/[*_`~]/g, "");
}

/**
 * Single pass over the body yielding BOTH intent sets. They are computed
 * together because they come from the same attribution walk — the governing
 * keyword decides which set a `#N` lands in — and splitting the walk in two
 * would let the two directions drift apart.
 *
 * @param {string} body raw PR body
 * @returns {{reference: Set<number>, closing: Set<number>}}
 */
function intentNumbers(body) {
  const text = normalize(body);
  const reference = new Set();
  const closing = new Set();

  let governor = null; // { isReference: boolean }
  let governorEnd = -1; // index just past the last attributed token

  for (const m of text.matchAll(TOKEN_RE)) {
    const [raw, word, num] = m;

    if (word) {
      const preceding = text.slice(Math.max(0, m.index - 24), m.index);
      const isClosing = CLOSING_WORDS.has(word.toLowerCase());
      governor = {
        isReference: !isClosing || NEGATION_RE.test(preceding),
      };
      governorEnd = m.index + raw.length;
      continue;
    }

    // An issue ref. Attribute it to the governor only if the intervening text
    // is pure list punctuation; otherwise it's a bare mention with no intent.
    // This is also what keeps `Closes owner/repo#12` out of both sets: the
    // `owner/repo` sitting in the gap breaks attribution, so another repo's
    // numbering is never mistaken for one of ours and looked up locally.
    const gap = text.slice(governorEnd, m.index);
    if (governor && governorEnd >= 0 && LIST_GAP_RE.test(gap)) {
      (governor.isReference ? reference : closing).add(Number(num));
      governorEnd = m.index + raw.length; // chain onward through `#a, #b, #c`
    } else {
      governor = null;
      governorEnd = -1;
    }
  }

  return { reference, closing };
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

/**
 * Decide what to warn about, in both directions: issues GitHub will close
 * that should survive the merge, and issues the body says it closes that
 * GitHub never registered.
 *
 * @param {object} input
 * @param {Array<{number:number,title:string,state:string,labels:string[]}>} input.closingRefs
 *   Issues GitHub will close on merge (GraphQL `closingIssuesReferences`) —
 *   already folds in both body keywords and sidebar links, which is why we read
 *   it instead of re-parsing the body for closing intent. A sidebar-only link
 *   carries no keyword at all; that is exactly how two of the four historical
 *   orphanings slipped past.
 * @param {string} input.body PR body
 * @param {Object<number,{state:string,title:string}>} [input.issueStates]
 *   State + title for the numbers the body *states* it closes, resolved by the
 *   workflow. A number absent here is one we could not resolve — a typo, or
 *   another repo's numbering — and we make no claim we cannot back with a
 *   state read rather than guessing. Absent entirely = report nothing.
 * @returns {{
 *   flagged: Array<{number:number,title:string,reasons:string[]}>,
 *   unregistered: Array<{number:number,title:string}>,
 * }}
 */
function evaluate({ closingRefs = [], body = "", issueStates = {} } = {}) {
  const { reference: refIntent, closing: closeIntent } = intentNumbers(body);

  const flagged = [];
  for (const ref of closingRefs) {
    // A closed issue cannot be wrongly closed again.
    if (String(ref.state).toUpperCase() !== "OPEN") continue;

    const labels = ref.labels || [];
    const reasons = [];

    // Ordered most-diagnostic first: the contradiction names the actual bug,
    // so it should lead the warning when both signals fire.
    if (refIntent.has(ref.number)) reasons.push("contradiction");
    for (const label of PROTECTED_LABELS) {
      if (labels.includes(label)) reasons.push(label);
    }

    if (reasons.length > 0) {
      flagged.push({ number: ref.number, title: ref.title, reasons });
    }
  }

  // The inverse direction. `closingRefs` is GitHub's answer to "what will
  // merging close?"; `closeIntent` is the author's. A number in the second
  // and not the first is work the author believed was covered and isn't —
  // the omission reads as an all-clear, which is why nothing caught the
  // dropped number in the observed case.
  const registered = new Set(closingRefs.map(r => r.number));
  const unregistered = [];
  for (const number of closeIntent) {
    if (registered.has(number)) continue;
    const known = issueStates[number];
    // Only an OPEN issue can be orphaned. A closed or unresolvable number
    // costs the false-positive budget for nothing — and this guard's whole
    // design bet is that it stays rare enough to be read.
    if (!known || String(known.state).toUpperCase() !== "OPEN") continue;
    unregistered.push({ number, title: known.title });
  }

  return { flagged, unregistered };
}

/** Human-readable explanation per reason, used to build the PR comment. */
function explainReason(reason) {
  switch (reason) {
    case "contradiction":
      return "the PR body references it with `Refs`/negated wording, but it is registered as a **closing** reference — prose does not override the registration";
    case "type:project":
      return "it is an open `type:project` multi-wave tracker";
    case "no-autoclose":
      return "it carries `no-autoclose` (a long-lived watch ticket)";
    default:
      return reason;
  }
}

module.exports = {
  evaluate,
  referenceIntentNumbers,
  closingIntentNumbers,
  explainReason,
  PROTECTED_LABELS,
};
