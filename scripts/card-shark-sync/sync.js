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

/** Non-empty date field values on a board item, as {field, date}. */
function datesOf(boardNode) {
  const nodes = boardNode?.fieldValues?.nodes || [];
  return nodes
    .filter((v) => v && v.date && v.field && v.field.name)
    .map((v) => ({ field: v.field.name, date: v.date }));
}

/**
 * Find the board item for an issue, FROM THE PROJECT SIDE.
 *
 * The obvious implementation -- read issue.projectItems and delete the match --
 * cannot be used: projectItems does not traverse an org-owned repo's issue to a
 * user-owned project, and it fails by returning an EMPTY LIST rather than an
 * error. It would run to completion, delete nothing, and exit 0 in 15 of the 20
 * fleet repos. Spec 2.
 *
 * Which means absence is only meaningful if the read was complete, so the
 * received-vs-declared guard runs BEFORE any matching. A short read reports
 * `unreadable`; it must never be reported as a difference. (Same rule, and the
 * same reason, as guardBoardRead in owen-ops scripts/escalation/reconcile.js.)
 */
function resolveRemoval({ boardNodes, received, declared, owner, repo, number }) {
  if (received !== declared) {
    return { status: "unreadable", received, declared };
  }
  const hit = (boardNodes || []).find((n) => {
    const c = n && n.content;
    if (!c || c.__typename !== "Issue") return false;
    return (
      c.number === number &&
      c.repository?.name === repo &&
      c.repository?.owner?.login === owner
    );
  });
  if (!hit) return { status: "absent" };
  return { status: "found", itemId: hit.id, dates: datesOf(hit) };
}

/**
 * The comment posted immediately BEFORE deleting an item that carries dates.
 *
 * Engagement, Track and Priority all derive from labels and the autofill sweep
 * restores them on re-escalation. Deferred until and Due date do not -- they are
 * hand-set, and deleting the item is the only place they can be lost. 26 items
 * carry a deferral as of 2026-08-13 (the parking pass put them there), so this
 * is no longer the negligible loss the original spec priced.
 */
function preservationComment({ dates, itemId }) {
  const rows = dates.map((d) => `| ${d.field} | ${d.date} |`).join("\n");
  return [
    "🔖 **Card Shark field values preserved before de-escalation**",
    "",
    "The last `pm:*` label was removed, so this issue left Card Shark and its board",
    "item was deleted. These hand-set values do not derive from labels and would",
    "otherwise be lost — re-apply them if this is ever re-escalated:",
    "",
    "| Field | Value |",
    "|---|---|",
    rows,
    "",
    `<sub>Deleted item \`${itemId}\`. Automated by \`card-shark-sync.yml\` — owen-ops#469.</sub>`,
  ].join("\n");
}

module.exports = { isPmLabel, decideAction, datesOf, resolveRemoval, preservationComment };
