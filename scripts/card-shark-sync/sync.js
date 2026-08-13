// Pure decision layer for the Card Shark exit valve (owen-ops#469 Plan B).
//
// Every decision this workflow makes lives here so it can be tested without a
// board, a token, or an event. The workflow does I/O and nothing else.
//
// This repo is PUBLIC and the fleet canon (owen-ops/.github/labels.json,
// fleet.json) is PRIVATE, so nothing here may depend on reading canon. Where a
// rule must be duplicated rather than derived, it is duplicated in the WIDER
// direction and the divergence is named in a comment.

const PM_PREFIX = "pm:";
const AUDIENCES = ["pm-surface", "agent-zone"];

/** The valve's membership test. Wider than reconcile.js's derived set, on purpose. */
const isPmLabel = (name) => typeof name === "string" && name.startsWith(PM_PREFIX);

/**
 * Decide what an issues event implies for board membership.
 *
 * `currentLabels` MUST be a fresh read of the issue's labels, not the event
 * payload's. The payload describes the moment the event fired; by the time this
 * runs, a second label operation may have landed. The unlabeled path is the one
 * that turns on this -- see the two-pm-labels test.
 */
function decideAction({ eventAction, audience, eventLabel, currentLabels }) {
  if (!AUDIENCES.includes(audience)) {
    throw new Error(`unknown audience ${JSON.stringify(audience)} — expected one of ${AUDIENCES.join(", ")}`);
  }
  const labels = currentLabels || [];
  const pmRemaining = labels.filter(isPmLabel);
  const isAgentZone = audience === "agent-zone";
  const noop = (reason) => ({ kind: "noop", applyProductLabel: false, reason });

  if (eventAction === "opened") {
    if (isAgentZone) return noop("agent-zone issues reach the board only by explicit escalation");
    // pm-surface: every issue auto-flows (AGENTS.md), AND pm:* <=> on-board
    // (spec 3.1). Backfilling the label the templates already default is the
    // only option that keeps both true without a foundational-doc edit.
    return {
      kind: "add",
      applyProductLabel: false,
      ...(pmRemaining.length === 0 ? { backfillLabel: "pm:awareness" } : {}),
      reason: "pm-surface issue opened",
    };
  }

  if (eventAction === "labeled") {
    if (!isPmLabel(eventLabel)) return noop(`${eventLabel} is not a pm:* label`);
    return {
      kind: "add",
      applyProductLabel: isAgentZone,
      reason: `${eventLabel} applied`,
    };
  }

  if (eventAction === "unlabeled") {
    if (!isPmLabel(eventLabel)) return noop(`${eventLabel} is not a pm:* label`);
    if (pmRemaining.length > 0) {
      return noop(`still carries ${pmRemaining.join(", ")}`);
    }
    return { kind: "remove", applyProductLabel: false, reason: `last pm:* label (${eventLabel}) removed` };
  }

  return noop(`unhandled event action ${eventAction}`);
}

module.exports = { isPmLabel, decideAction };
