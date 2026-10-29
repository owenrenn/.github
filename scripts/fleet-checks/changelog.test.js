// Tests for the changelog generator and the PR fragment check (#1561, the D8
// ruling on #1555).
//
// The git-backed half runs over a real throwaway repository with real tags:
// the rule "a fragment's release is the first tag OF ITS STREAM'S PREFIX that
// contains its adding commit" is a claim about git, and only git can answer it.
//
// Zero dependencies: node --test only.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const cl = require("./changelog.js");
const { normalize } = require("./config.js");
const { makeRepo } = require("./fixture.js");

const ONE = normalize({}).streams;
const TWO = normalize({ changelog: { streams: {
  web: { tagPrefix: "v", paths: ["**"], excludePaths: ["desktop/**"] },
  desktop: { tagPrefix: "desktop-v", paths: ["desktop/**", "src/**"] },
} } }).streams;

const frag = (type, body, ships) => `---\ntype: ${type}\n${ships ? `ships: ${ships}\n` : ""}---\n${body}\n`;

// ── fragments ───────────────────────────────────────────────────────────────

test("a well-formed fragment parses; issue and slug come from the name", () => {
  const { fragment, errors } = cl.parseFragment("changelog.d/1626-view-log.md", frag("added", "The panel logs view opens."), ONE);
  assert.deepEqual(errors, []);
  assert.deepEqual(fragment, { path: "changelog.d/1626-view-log.md", issue: 1626, slug: "view-log", type: "added", ships: ["default"], body: "The panel logs view opens." });
});

test("every problem in a fragment is reported at once", () => {
  const { fragment, errors } = cl.parseFragment("changelog.d/Fix.md", "---\ntype: fix\nlink: x\n---\nOne\nTwo\n", TWO);
  assert.equal(fragment, null);
  assert.equal(errors.length, 5, errors.join("\n"));   // name, unknown key, type, ships, body
});

test("ships: names, lists, all and both; both refuses a repo that does not have two streams", () => {
  const names = Object.keys(TWO);
  assert.deepEqual(cl.parseShips("web", names).ships, ["web"]);
  assert.deepEqual(cl.parseShips("[web, desktop]", names).ships, ["web", "desktop"]);
  assert.deepEqual(cl.parseShips("both", names).ships, names);
  assert.deepEqual(cl.parseShips("all", names).ships, names);
  assert.match(cl.parseShips("both", ["a", "b", "c"]).error, /exactly two/);
  assert.match(cl.parseShips("site", names).error, /"site"/);
});

// ── tags ────────────────────────────────────────────────────────────────────

test("a tag belongs to the longest prefix followed by a digit, and nothing else is a release", () => {
  assert.equal(cl.tagStream("v12.3.35", TWO), "web");
  assert.equal(cl.tagStream("desktop-v0.2.15", TWO), "desktop");
  assert.equal(cl.tagStream("vendor-sync", TWO), null);
  assert.equal(cl.tagStream("bench/1414-option-c", TWO), null);
});

test("versions compare numerically, and a pre-release sorts before its release", () => {
  const sorted = ["12.10.0", "12.9.1", "12.9.1-rc.1", "2.0.0"].sort(cl.compareVersions);
  assert.deepEqual(sorted, ["2.0.0", "12.9.1-rc.1", "12.9.1", "12.10.0"]);
});

test("the PR number is the squash suffix, or a merge commit's number, or nothing", () => {
  assert.equal(cl.prNumber("feat(#1626): the panel's log, panel 0.2.14 (#1644)"), 1644);
  assert.equal(cl.prNumber("Merge pull request #12 from a/b"), 12);
  assert.equal(cl.prNumber("wip on #12"), null);
});

// ── the PR check ────────────────────────────────────────────────────────────

const pr = (changes, texts = {}, extra = {}) =>
  cl.evaluatePr({ changes: changes.map(([status, path]) => ({ status, path })), texts: new Map(Object.entries(texts)), streams: TWO, ...extra });

test("a code PR with no fragment fails, naming the opt-out", () => {
  const r = pr([["M", "src/a.ts"]]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /Changelog: none/);
});

test("docs-only, bot-authored and opted-out PRs need no fragment, and each says why", () => {
  assert.deepEqual(pr([["M", "docs/a.md"], ["M", "README.md"]]).errors, []);
  assert.deepEqual(pr([["M", "Cargo.lock"]], {}, { author: "dependabot[bot]" }).errors, []);
  const r = pr([["M", "src/a.ts"]], {}, { body: "Summary\n\nChangelog: none — an internal refactor\n" });
  assert.deepEqual(r.errors, []);
  assert.match(r.notices[0], /an internal refactor/);
});

test("ships: is held to the paths the PR touched", () => {
  const f = "changelog.d/9-x.md";
  // The measured case from #1561's brief: a desktop-only PR claiming the site.
  const wrong = pr([["M", "desktop/src-tauri/main.rs"], ["A", f]], { [f]: frag("fixed", "X.", "web") });
  assert.equal(wrong.errors.length, 1);
  assert.match(wrong.errors[0], /ships: web/);
  // Shared code ships in both, so claiming both is right.
  assert.deepEqual(pr([["M", "src/lib/a.ts"], ["A", f]], { [f]: frag("fixed", "X.", "both") }).errors, []);
});

test("a fragment-only PR, and a deleted fragment, pass with a note", () => {
  const f = "changelog.d/9-x.md";
  const r = pr([["A", f]], { [f]: frag("fixed", "X.", "web") });
  assert.deepEqual(r.errors, []);
  assert.match(r.notices.join(" "), /no paths to be checked/);
  assert.match(pr([["D", f], ["M", "docs/a.md"]]).notices.join(" "), /deleted/);
});

// ── the generator, over real tags ───────────────────────────────────────────

function history() {
  const r = makeRepo();
  r.commit("init", { "src/a.ts": "", "desktop/main.rs": "" });
  r.git("tag", "v1.0.0");
  r.commit("fix(#10): panel wakes (#20)", { "desktop/main.rs": "1", "changelog.d/10-panel-wakes.md": frag("fixed", "The panel wakes.", "desktop") });
  r.git("tag", "desktop-v0.1.0");
  r.commit("feat(#11): shared shortcut (#21)", { "src/a.ts": "1", "changelog.d/11-shortcut.md": frag("added", "A shortcut.", "both") });
  r.git("tag", "v1.1.0");
  r.commit("feat(#12): web only (#22)", { "src/a.ts": "2", "changelog.d/12-web-only.md": frag("changed", "The site changed.", "web") });
  return r;
}

test("a fragment ships in the first tag of each of ITS streams that contains it", () => {
  const r = history();
  try {
    const { entries, problems } = cl.collect(r.root, { streams: TWO });
    assert.deepEqual(problems, []);
    const by = Object.fromEntries(entries.map((e) => [e.issue, e]));
    assert.deepEqual(by[10].releases, { desktop: "desktop-v0.1.0" });
    // Added after desktop-v0.1.0 and before v1.1.0: released on the web, not yet in the panel.
    assert.deepEqual(by[11].releases, { web: "v1.1.0", desktop: null });
    assert.deepEqual(by[12].releases, { web: null });
    assert.equal(by[11].pr, 21);
  } finally { r.cleanup(); }
});

test("a release body lists only that release; a pending tag lists what is unreleased; an empty one says so", () => {
  const r = history();
  try {
    const { entries } = cl.collect(r.root, { streams: TWO });
    assert.equal(cl.renderRelease(entries, "web", "v1.1.0").text, "### Added\n\n- A shortcut. (#11, PR #21)\n");
    assert.equal(cl.renderRelease(entries, "desktop", "desktop-v0.2.0", { pending: true }).text, "### Added\n\n- A shortcut. (#11, PR #21)\n");
    const empty = cl.renderRelease(entries, "web", "v1.0.0");
    assert.equal(empty.count, 0);
    assert.match(empty.text, /No changelog fragments/);
  } finally { r.cleanup(); }
});

test("the full changelog prints each stream newest first, unreleased on top", () => {
  const r = history();
  try {
    const { entries, tags } = cl.collect(r.root, { streams: TWO });
    const text = cl.renderChangelog({ entries, tags, streams: TWO });
    const heads = text.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.replace(/ — \d{4}-\d{2}-\d{2}$/, ""));
    assert.deepEqual(heads, ["## Unreleased — web", "## v1.1.0 — web", "## Unreleased — desktop", "## desktop-v0.1.0 — desktop"]);
  } finally { r.cleanup(); }
});

test("an invalid fragment already on the branch is skipped by the generator and reported", () => {
  const r = history();
  try {
    r.commit("bad (#23)", { "changelog.d/13-bad.md": "no frontmatter\n" });
    const { entries, problems } = cl.collect(r.root, { streams: TWO });
    assert.equal(entries.length, 3);
    assert.equal(problems.length, 1);
  } finally { r.cleanup(); }
});
