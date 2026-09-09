// Card Shark FIELD DERIVATION -- pure mapping logic, no I/O, no network.
//
// WHY IT LIVES HERE rather than in the operations repo that owns the board:
// these three derivations are FLEET semantics. Every repo calling the sync
// workflow needs the same answer, and the alternative shapes were both worse --
// duplicating ~5 lines into every caller is the "N copies that must stay
// byte-identical" defect this repo was created to end, and having the caller
// check out the operations repo would put a cross-repo checkout on the HOT path
// (every label event, every repo) instead of on a four-hourly sweep. The
// dependency belongs on the cold path.
//
// ⚠️ THIS REPO IS PUBLIC AND THE FLEET CANON IS NOT. Two consequences bind every
// line below, and neither is stylistic:
//
//   1. NO REPOSITORY NAMES. `Track` is NOT derived here from a work-repo list,
//      because that list is a set of private repository names and GitHub returns
//      404 for those to an anonymous caller -- publishing them here would answer
//      a question the platform declines to answer. It arrives as a caller-supplied
//      value instead: the generic rule is public, the private datum stays in the
//      private caller's own workflow file. See AGENTS.md § The content rule.
//
//   2. DUPLICATE IN THE WIDER DIRECTION. Per AGENTS.md, code here may not derive
//      its rules from canon it cannot read, so where a rule must be restated it is
//      restated more permissively than canon and the divergence is named. That is
//      why Engagement reads a `lane:` PREFIX rather than an enumerated lane set:
//      a lane added to canon tomorrow keeps working here rather than silently
//      returning null. The divergence is that this module will happily name an
//      Engagement for a lane the board has no option for; the write then fails
//      loudly at the API, which is the correct direction for a public module that
//      cannot see the option list.
//
// Consumed by sync.js (membership time, all fleet repos) and by the operations
// repo's four-hourly reconciler, which imports this file from its checkout.

// P0-P3 in priority order, highest first. Option names map 1:1.
const PRIORITY_LABELS = ["P0", "P1", "P2", "P3"];

// Tiebreak order when an item carries two lane labels (a mislabel). Ordered
// MOST-COSTLY-TO-THE-HUMAN FIRST: over-reporting what a person owes is the safe
// direction for a surface whose entire job is "what do I owe".
//
// ⚠️ This list is a TIEBREAK, never the vocabulary -- see constraint 2 above. A
// lane absent from it still resolves; it simply loses a tie to a lane present
// here. Deleting the list would change which of two labels wins, not whether a
// single label works.
const LANE_PRECEDENCE = ["do", "session", "decide", "kick-off"];

const TRACKS = ["Work", "Personal"];

/**
 * Priority <- the P0-P3 label. Null when none present: never invent a priority.
 * Highest wins on the unlikely multi-label case.
 */
function priorityName(labelNames) {
  const found = PRIORITY_LABELS.filter((p) => (labelNames || []).includes(p));
  return found.length ? found[0] : null;
}

/**
 * Engagement <- a `lane:<name>` label, by PREFIX.
 *
 * `lane:kick-off` -> "Kick off": strip the prefix, hyphens become spaces, first
 * letter uppercased. Null when no lane label is present -- never invent a lane.
 *
 * ⚠️ Deliberately no `lane:watch`. On the awareness tier the ABSENCE of a lane
 * already means Watch, and a label 100% derivable from another is a stale
 * self-report waiting to happen.
 */
function engagementName(labelNames) {
  const lanes = (labelNames || [])
    .filter((l) => typeof l === "string" && l.startsWith("lane:"))
    .map((l) => l.slice("lane:".length))
    .filter((suffix) => suffix.length > 0);
  if (!lanes.length) return null;

  // Known lanes win by precedence; an unknown lane is still honoured (constraint
  // 2) but ranks after every known one, so it can never quietly outrank a lane
  // whose cost this fleet has actually reasoned about.
  let best = null;
  let bestRank = Infinity;
  for (const lane of lanes) {
    const idx = LANE_PRECEDENCE.indexOf(lane);
    const rank = idx === -1 ? LANE_PRECEDENCE.length : idx;
    if (rank < bestRank) {
      bestRank = rank;
      best = lane;
    }
  }
  const words = best.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Field writes for one board item. Each field follows its OWN write policy, and
 * the three policies are genuinely different -- collapsing them is a regression.
 *
 * item = { track, contentType, labels, current: { track, priority, engagement } }
 *
 * `track` is the caller-supplied value ("Work" | "Personal"), NOT derived here.
 */
function computeUpdates(item) {
  const updates = [];
  const { track, contentType, labels = [], current = {} } = item || {};

  // Draft cards have no repository and no labels: nothing is derivable.
  if (contentType === "DraftIssue") return updates;

  // Track: SET-IF-EMPTY. The value follows from the source repo, which is
  // immutable, so Track cannot drift -- the only way a set Track differs from the
  // derived one is a deliberate human override, which a courier must not clobber.
  //
  // ⚠️ An unrecognised track is DROPPED rather than written. This module cannot
  // see the board's option list, so writing an arbitrary string would fail at the
  // API for a reason ("no such option") that reads nothing like the real cause
  // (a caller passed a typo in its workflow input).
  if (!current.track && TRACKS.includes(track)) {
    updates.push({ fieldName: "Track", optionName: track });
  }

  // Priority: RE-MIRROR-ON-DIVERGENCE. The label is the documented source of
  // truth, so unlike Track there is no legitimate manual override to protect.
  // Set-if-empty here left fields permanently stale when a label changed AFTER
  // the field was first written. No label -> leave alone; never invent one, never
  // clear an existing one.
  const p = priorityName(labels);
  if (p && p !== current.priority) {
    updates.push({ fieldName: "Priority", optionName: p });
  }

  // Engagement: RE-MIRROR-ON-DIVERGENCE, for a sharper reason than Priority. The
  // field mirrors a label a human or agent applied -- the machine is a courier,
  // never an author. Re-mirror rather than set-if-empty because a lane names the
  // NEXT move, not the ticket, and half a real queue is compound: an item is
  // "decide" until the decision happens, then "kick-off". Set-if-empty would
  // freeze the first guess forever.
  const e = engagementName(labels);
  if (e && e !== current.engagement) {
    updates.push({ fieldName: "Engagement", optionName: e });
  }

  return updates;
}

/**
 * Detect an Engagement value on the board that NO label derives.
 *
 * REPORT-ONLY, and the asymmetry with computeUpdates is the point: "no lane label
 * -> leave the field alone" is correct and stays, because it protects a
 * deliberately-set value from being cleared by a courier. But that same rule makes
 * the state permanent AND invisible -- a frozen value reads exactly like a
 * correctly-derived one. This names the difference without acting on it, because
 * the module cannot know whether the frozen value or the missing label is right,
 * and guessing would overwrite a human's judgement with a derivation.
 *
 * ⚠️ ONE COMBINATION IS DELIBERATELY NOT REPORTED: an awareness-tier item sitting
 * at "Watch". Absence of a lane ALREADY means Watch there, so the field merely
 * restates the derivation -- redundant, not stuck. Every other combination is
 * reported, including an awareness item at a non-Watch value (which contradicts
 * the by-absence reading) and an action-tier item at any value including Watch
 * (that tier has no by-absence default, so nothing there is redundant).
 *
 * ⚠️ The test is that PAIR, not either half: excluding all awareness items loses
 * the real findings, and excluding all "Watch" values lets a parked action item
 * through.
 */
function frozenEngagement(item) {
  const { contentType, labels = [], current = {} } = item || {};
  // ⚠️ Draft cards are excluded, and this guard is NOT symmetry with
  // computeUpdates -- it is load-bearing on its own. A draft has no labels by
  // construction, so every draft carrying an Engagement value would be reported
  // as frozen forever: a permanent finding nobody can clear, which is how a
  // report stops being read. Found by integration, not by review: the consuming
  // reconciler's suite asserts it and this module did not implement it.
  if (contentType === "DraftIssue") return null;
  if (!current.engagement) return null;
  if (engagementName(labels)) return null; // a label derives it: not frozen

  const isAwareness = labels.includes("pm:awareness");
  if (isAwareness && current.engagement === "Watch") return null; // redundant, not stuck

  return { engagement: current.engagement };
}

module.exports = {
  PRIORITY_LABELS,
  LANE_PRECEDENCE,
  TRACKS,
  priorityName,
  engagementName,
  computeUpdates,
  frozenEngagement,
};
