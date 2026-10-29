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

test("the documented fragment example, with inline # comments, parses verbatim", () => {
  // Review finding 1 (#1561): the AGENTS.md example failed its own check.
  const text = "---\ntype: fixed          # added | changed | fixed | removed\nships: desktop       # a stream name\n---\nThe panel reconnects.\n";
  const { fragment, errors } = cl.parseFragment("changelog.d/1-x.md", text, TWO);
  assert.deepEqual(errors, []);
  assert.equal(fragment.type, "fixed");
  assert.deepEqual(fragment.ships, ["desktop"]);
  assert.equal(cl.frontmatterValue('"web # not a comment"  # but this is'), "web # not a comment");
});

test("ships: accepts a quoted flow list", () => {
  assert.deepEqual(cl.parseShips('["web", "desktop"]', Object.keys(TWO)).ships, ["web", "desktop"]);
  assert.deepEqual(cl.parseShips("['web']", Object.keys(TWO)).ships, ["web"]);
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

test("pre-release identifiers follow semver: numbers numerically, a number before a word", () => {
  // Review finding 8 (#1561): rc.10 sorted before rc.2 as a string.
  const sorted = ["1.0.0-rc.10", "1.0.0-rc.2", "1.0.0-beta", "1.0.0-rc", "1.0.0-1", "1.0.0-rc-x.1"].sort(cl.compareVersions);
  assert.deepEqual(sorted, ["1.0.0-1", "1.0.0-beta", "1.0.0-rc", "1.0.0-rc.2", "1.0.0-rc.10", "1.0.0-rc-x.1"]);
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

test("an added fragment that fails to parse reports its parse errors only, not 'adds no fragment'", () => {
  // Review finding 4 (#1561).
  const f = "changelog.d/9-x.md";
  const r = pr([["M", "src/a.ts"], ["A", f]], { [f]: "---\ntype: fix\n---\nX.\n" });
  // Its own problems only (the bad type, the missing `ships:`), each naming the file.
  assert.ok(r.errors.length > 0);
  for (const e of r.errors) assert.match(e, /^changelog\.d\/9-x\.md: /, e);
  assert.ok(!r.errors.some((e) => /adds no fragment/.test(e)));
});

test("the opt-out needs a reason, and the template's <why> placeholder is not one", () => {
  // Review finding 7 (#1561).
  const code = [["M", "src/a.ts"]];
  const bare = pr(code, {}, { body: "Changelog: none\n" });
  assert.equal(bare.errors.length, 2);
  assert.match(bare.errors[0], /gives no reason/);
  assert.equal(pr(code, {}, { body: "Changelog: none — <why>\n" }).errors.length, 2);
  const real = pr(code, {}, { body: "Changelog: none — <why>\n\nChangelog: none: a CI-only change\n" });
  assert.deepEqual(real.errors, []);
  assert.match(real.notices[0], /a CI-only change/);
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
    const { entries, tags, reaches } = cl.collect(r.root, { streams: TWO });
    const cut = (s, tag) => ({ streamTags: tags[s].map((t) => t.tag), prefix: TWO[s].tagPrefix, reaches: tags[s].find((t) => t.tag === tag).reaches });
    assert.equal(cl.renderRelease(entries, "web", "v1.1.0", cut("web", "v1.1.0")).text, "### Added\n\n- A shortcut. (#11, PR #21)\n");
    const pending = { pending: true, streamTags: tags.desktop.map((t) => t.tag), prefix: TWO.desktop.tagPrefix, reaches };
    assert.equal(cl.renderRelease(entries, "desktop", "desktop-v0.2.0", pending).text, "### Added\n\n- A shortcut. (#11, PR #21)\n");
    const empty = cl.renderRelease(entries, "web", "v1.0.0", cut("web", "v1.0.0"));
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

test("a stable release lists everything since the previous stable tag, its pre-releases included", () => {
  // Review finding B (#1561): with v1.1.0-rc.1 and v1.1.0 cut, v1.1.0 rendered empty.
  const r = makeRepo();
  try {
    r.commit("init", { "src/a.ts": "" });
    r.git("tag", "v1.0.0");
    r.commit("feat(#1): one (#11)", { "src/a.ts": "1", "changelog.d/1-one.md": frag("added", "One.") });
    r.git("tag", "v1.1.0-rc.1");
    r.commit("fix(#2): two (#12)", { "src/a.ts": "2", "changelog.d/2-two.md": frag("fixed", "Two.") });
    r.git("tag", "v1.1.0-rc.2");
    r.git("tag", "v1.1.0");
    r.commit("feat(#3): three (#13)", { "src/a.ts": "3", "changelog.d/3-three.md": frag("added", "Three.") });
    const { entries, tags, reaches } = cl.collect(r.root, { streams: ONE });
    const opts = { streamTags: tags.default.map((t) => t.tag), prefix: "v" };
    const reachOf = (tag) => tags.default.find((t) => t.tag === tag)?.reaches ?? reaches;
    const issues = (tag, extra = {}) => cl.releaseEntries(entries, "default", tag, { ...opts, reaches: reachOf(tag), ...extra }).map((e) => e.issue).sort();
    assert.deepEqual(issues("v1.1.0-rc.1"), [1]);
    assert.deepEqual(issues("v1.1.0-rc.2"), [2]);
    assert.deepEqual(issues("v1.1.0"), [1, 2]);
    assert.deepEqual(issues("v1.2.0-rc.1", { pending: true }), [3]);
    assert.deepEqual(issues("v1.2.0", { pending: true }), [3]);
  } finally { r.cleanup(); }
});

test("in a merge-commit repo the add is credited to the merge, so its PR number resolves", () => {
  // Review finding C (#1561).
  const r = makeRepo();
  try {
    r.commit("init", { "src/a.ts": "" });
    r.git("checkout", "-q", "-b", "topic");
    r.commit("work on the topic", { "src/a.ts": "1", "changelog.d/4-topic.md": frag("added", "Topic.") });
    r.git("checkout", "-q", "main");
    r.git("merge", "-q", "--no-ff", "topic", "-m", "Merge pull request #7 from someone/topic");
    r.git("tag", "v1.0.0");
    const { entries } = cl.collect(r.root, { streams: ONE });
    assert.equal(entries[0].pr, 7);
    assert.equal(entries[0].releases.default, "v1.0.0");
  } finally { r.cleanup(); }
});

test("a branch that merged main into itself still credits main's PR and main's release", () => {
  // The first-parent credit there is the branch's own merge of main, which
  // names no PR and which no tag on main contains.
  const r = makeRepo();
  try {
    r.commit("init", { "src/a.ts": "" });
    r.git("checkout", "-q", "-b", "rel");
    r.commit("rel work", { "src/b.ts": "1" });
    r.git("checkout", "-q", "main");
    r.git("checkout", "-q", "-b", "topic");
    r.commit("work on the topic", { "src/a.ts": "1", "changelog.d/1-x.md": frag("added", "X.") });
    r.git("checkout", "-q", "main");
    r.git("merge", "-q", "--no-ff", "topic", "-m", "Merge pull request #5 from someone/topic");
    r.git("tag", "v1.1.0-rc.1");
    r.git("checkout", "-q", "rel");
    r.git("merge", "-q", "--no-ff", "main", "-m", "Merge branch 'main' into rel");
    const { entries } = cl.collect(r.root, { ref: "rel", streams: ONE });
    assert.equal(entries[0].pr, 5);
    assert.equal(entries[0].releases.default, "v1.1.0-rc.1");
  } finally { r.cleanup(); }
});

test("a stable release takes in only the pre-releases its history contains", () => {
  // v1.0.1-rc.1 sorts between v1.0.0 and v1.1.0 but was cut on a maintenance branch.
  const r = makeRepo();
  try {
    r.commit("init", { "src/a.ts": "" });
    r.git("tag", "v1.0.0");
    r.git("checkout", "-q", "-b", "maint");
    r.commit("fix(#2): hotfix (#12)", { "src/a.ts": "h", "changelog.d/2-hot.md": frag("fixed", "Hot.") });
    r.git("tag", "v1.0.1-rc.1");
    r.git("checkout", "-q", "main");
    r.commit("feat(#1): one (#11)", { "src/b.ts": "1", "changelog.d/1-one.md": frag("added", "One.") });
    r.git("tag", "v1.1.0");
    r.git("merge", "-q", "--no-ff", "maint", "-m", "Merge branch 'maint'");
    const { entries, tags } = cl.collect(r.root, { streams: ONE });
    const v110 = tags.default.find((t) => t.tag === "v1.1.0");
    const got = cl.releaseEntries(entries, "default", "v1.1.0", { streamTags: tags.default.map((t) => t.tag), prefix: "v", reaches: v110.reaches });
    assert.deepEqual(got.map((e) => e.issue), [1]);
  } finally { r.cleanup(); }
});

test("a release with a tag has no default prefix or ancestry: leaving either out throws", () => {
  // A defaulted "" reads every hyphenated-prefix stable tag (desktop-v1.1.0) as a pre-release.
  assert.throws(() => cl.releaseEntries([], "desktop", "desktop-v1.1.0", { streamTags: [], reaches: new Set() }), /prefix/);
  assert.throws(() => cl.releaseEntries([], "desktop", "desktop-v1.1.0", { streamTags: [], prefix: "desktop-v" }), /reaches/);
  assert.deepEqual(cl.releaseEntries([], "desktop", null, { pending: true }), []);
});

test("first containing tags: one walk per tag, version order, an untagged commit absent", () => {
  // Review finding 10 (#1561): the walk is per tag, not per fragment × tag.
  const r = makeRepo();
  try {
    const a = r.commit("a", { "x": "1" });
    r.git("tag", "v1.0.0");
    const b = r.commit("b", { "x": "2" });
    r.git("tag", "v1.0.10");
    r.git("tag", "v1.0.9");
    const c = r.commit("c", { "x": "3" });
    const first = cl.firstContainingTags(r.root, ["v1.0.0", "v1.0.9", "v1.0.10"], new Set([a, b, c]));
    assert.equal(first.get(a), "v1.0.0");
    assert.equal(first.get(b), "v1.0.9");
    assert.equal(first.has(c), false);
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
