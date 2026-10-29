// Tests for the shared dead-path engine (#1561; the link half is #867's).
//
// The bias is toward FALSE POSITIVES, because those are what get a detector
// switched off (#409). Each "is not judged" case below is a shape measured as
// a false finding on a real fleet repo while this check was built.
//
// Zero dependencies: node --test only.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const dp = require("./dead-paths.js");
const { makeRepo } = require("./fixture.js");

// ── slugs (pinned to real headings; the em-dash case is the 54-to-1 bug) ─────

test("slugify matches GitHub on the punctuation fleet headings use", () => {
  const cases = [
    ["Nested tmux — the outer always wins the prefix", "nested-tmux--the-outer-always-wins-the-prefix"],
    ["⚠️ Exclusions — the one that matters", "-exclusions--the-one-that-matters"],
    ["`area:*` — the absence-default pattern", "area--the-absence-default-pattern"],
    ["The Floor (E1b, #1162) — successor", "the-floor-e1b-1162--successor"],
  ];
  for (const [h, want] of cases) assert.equal(dp.slugify(h), want, h);
});

test("a heading inside a fence offers no anchor", () => {
  const a = dp.anchorsInSource("## Real\n\n```sh\n# not a heading\n```\n");
  assert.deepEqual([...a], ["real"]);
});

// ── comment lexers ──────────────────────────────────────────────────────────

test("hash comments: a # inside quotes or a ${#var} is not a comment", () => {
  const src = 'echo "a # b"  # real one\nn=${#arr[@]}\n# whole line\nurl=http://x/#frag\n';
  assert.deepEqual(dp.hashComments(src).map((c) => [c.line, c.text.trim()]), [[1, "real one"], [3, "whole line"]]);
});

test("slash comments: // in a string, a regex or a template is not a comment", () => {
  const src = [
    'const u = "https://example.com"; // one',
    "const r = /\\/\\//g; // two",
    "const t = `a // b ${x}`; /* three",
    "   four */",
  ].join("\n");
  assert.deepEqual(dp.slashComments(src).map((c) => [c.line, c.text.trim()]), [[1, "one"], [2, "two"], [3, "three"], [4, "four"]]);
});

test("slash comments: an unterminated apostrophe does not swallow later lines, and line numbers hold", () => {
  // The measured bug: a stray quote consumed its newline uncounted, so every
  // later finding in the file was reported one line high.
  const src = "x = it's\ny = 1 // on line two\n";
  assert.deepEqual(dp.slashComments(src).map((c) => c.line), [2]);
});

test("rust: a lifetime is not a char literal and a raw string hides its //", () => {
  const src = 'fn f<\'a>(s: &\'a str) {} // lifetimes\nlet r = r#"no // comment"#; // raw\n';
  assert.deepEqual(dp.slashComments(src, { rust: true }).map((c) => c.text.trim()), ["lifetimes", "raw"]);
});

// ── candidates ──────────────────────────────────────────────────────────────

test("pathCandidates takes paths and leaves URLs, globs, placeholders, quoted code and fractions", () => {
  const take = (t) => dp.pathCandidates(t);
  assert.deepEqual(take("see `docs/a.md` and scripts/b.sh."), ["docs/a.md", "scripts/b.sh"]);
  assert.deepEqual(take("https://example.com/docs/a.md"), []);
  assert.deepEqual(take("every src/**/*.ts and docs/<name>.md"), []);
  assert.deepEqual(take("moving `src/x.ts` to `docs/x.md`"), []);
  assert.deepEqual(take('import("./readouts/code") and "node scripts/y.mjs"'), []);
  assert.deepEqual(take("3/4 of the time, on 10/28"), []);
  assert.deepEqual(take("climb ../../ twice"), []);
  assert.deepEqual(take("docs/README.md#the-matrix,"), ["docs/README.md#the-matrix"]);
  assert.deepEqual(take("uses actions/add-to-project@v2 and pkg/name@1.2"), []);
});

// ── the judge, over a real repository ───────────────────────────────────────

function judge(files, opts = {}) {
  const r = makeRepo();
  try {
    r.commit("init", files);
    const tracked = dp.trackedFiles(r.root);
    const { docs, code } = dp.selectCorpus(tracked, opts);
    return dp.findDeadPaths({ root: r.root, tracked, docs, code, ...opts });
  } finally {
    r.cleanup();
  }
}

test("a comment naming a missing file under a tracked top-level directory is a finding", () => {
  const { findings } = judge({ "src/a.ts": "// see src/gone.ts\n", "src/b.ts": "" });
  assert.deepEqual(findings.map((f) => [f.kind, f.target, f.line]), [["comment-path", "src/gone.ts", 1]]);
});

test("prose and other repos' names are not judged: no tracked first segment, or a foreign line", () => {
  const { findings } = judge({
    "src/a.ts": [
      "// read and/or write; owner/repo pairs are not paths",
      "// the shared workflow repo's `scripts/elsewhere.js`",
      "// other#12 moved `src/elsewhere.ts`",
      "// other-repo `src/far.ts`",
      "",
      "// unrelated line",
    ].join("\n"),
    "scripts/x.sh": "",
  }, { foreignNames: ["other-repo"] });
  assert.deepEqual(findings, []);
});

test("a path resolves with a module suffix, file-relative, from ./ either way, or by unique suffix", () => {
  const { findings } = judge({
    "src/lib/cache.ts": "",
    "src/__tests__/design/sky.test.ts": "",
    "src/lib/a.ts": "// src/lib/cache · ./cache.ts · lib/cache.ts · design/sky.test.ts\n",
    "scripts/run.sh": "# run as ./scripts/run.sh from the root\n",
  });
  assert.deepEqual(findings, []);
});

test("a gitignored output, file or directory, is not a finding", () => {
  const { findings, skippedIgnored } = judge({
    ".gitignore": "/public/out/\n/public/generated/\n",
    "public/keep.txt": "",
    "src/a.ts": "// the build writes public/out/index.html and public/generated/\n",
  });
  assert.deepEqual(findings, []);
  assert.equal(skippedIgnored, 2);
});

test("a doc link and a comment anchor are judged against headings", () => {
  const { findings } = judge({
    "docs/a.md": "# Title\n\n[ok](#title) [bad](#nope) [gone](missing.md)\n",
    "src/a.ts": "// docs/a.md#title is fine, docs/a.md#nope is not\n",
  });
  assert.deepEqual(findings.map((f) => [f.kind, f.target]).sort(), [
    ["anchor", "#nope"], ["comment-anchor", "docs/a.md#nope"], ["link", "missing.md"],
  ]);
});

test("dated records and changelogs are excused, and a config exemption needs its glob", () => {
  const tracked = ["docs/superpowers/plan.md", "docs/archive/old.md", "CHANGELOG.md", "changelog.d/1-x.md", "docs/legacy/a.md", "docs/live.md", "src/a.ts", "img.png"];
  const { docs, code, excused } = dp.selectCorpus(tracked, { exempt: [{ glob: "docs/legacy/", why: "an imported wiki" }] });
  assert.deepEqual(docs, ["docs/live.md"]);
  assert.deepEqual(code, ["src/a.ts"]);
  assert.equal(excused.length, 5);
  assert.match(excused.find((e) => e.file === "docs/legacy/a.md").reason, /an imported wiki/);
});

test("globToRegExp: ** crosses directories, * does not, a trailing / is the whole directory", () => {
  assert.ok(dp.globToRegExp("desktop/**").test("desktop/a/b.rs"));
  assert.ok(dp.globToRegExp("**").test("a/b/c"));
  assert.ok(dp.globToRegExp("src/*.ts").test("src/a.ts"));
  assert.ok(!dp.globToRegExp("src/*.ts").test("src/x/a.ts"));
  assert.ok(dp.globToRegExp("docs/").test("docs/x/y.md"));
  assert.ok(dp.globToRegExp("**/README.md").test("README.md"));
});

test("a parent of an ignored entry is NOT ignored: a deleted directory is still a dead path", () => {
  // Review finding E (#1561): a hand-written prefix rule skipped this.
  const { findings } = judge({
    ".gitignore": "scripts/old-tool/cache\n",
    "scripts/keep.sh": "",
    "src/a.ts": "// moved out of scripts/old-tool/\n",
  });
  assert.deepEqual(findings.map((f) => f.target), ["scripts/old-tool/"]);
});

test("a root-absolute doc link resolves from the repo root, not the doc's directory", () => {
  const { findings } = judge({ "src/x.ts": "", "docs/sub/a.md": "[ok](/src/x.ts) [bad](/src/nope.ts)\n" });
  assert.deepEqual(findings.map((f) => f.target), ["/src/nope.ts"]);
});

test("a stray % in a link is a finding, never a crash", () => {
  const { findings } = judge({ "docs/a.md": "# T\n\n[x](100%.md) [y](#50%off) [z](a.md#bad%)\n" });
  assert.deepEqual(findings.map((f) => f.target).sort(), ["#50%off", "100%.md", "a.md#bad%"]);
});

test("setext headings offer anchors; front matter, rules under a list or table, and fences do not", () => {
  const src = [
    "---", "title: not a heading", "---", "Setext One", "===", "",
    "Two lines", "of heading", "---", "", "- item", "---", "",
    "| a | b |", "|---|---|", "", "para", "", "---", "```", "Fenced", "===", "```", "## Atx", "",
  ].join("\n");
  assert.deepEqual([...dp.anchorsInSource(src)], ["setext-one", "two-lines-of-heading", "atx"]);
});

test("JSX close tags are not regexes: comments after them are read, on the right lines", () => {
  // Review finding A (#1561): `</div>` lexed as a regex jumped the newline uncounted.
  const src = [
    "const A = () => (",
    "  <div>{x}</div> // after a close tag",
    "  <Img {...p} /> // after a self-close",
    ");",
    "const d = a / b; // after a division",
  ].join("\n");
  assert.deepEqual(dp.slashComments(src).map((c) => [c.line, c.text.trim()]), [
    [2, "after a close tag"], [3, "after a self-close"], [5, "after a division"],
  ]);
});

test("a suffix shared by two tracked files resolves to neither", () => {
  const { findings } = judge({
    "a/design/x-css.test.ts": "", "b/design/x-css.test.ts": "", "src/k.ts": "// see design/x-css.test.ts\n",
    "design/keep.md": "",
  });
  assert.deepEqual(findings.map((f) => f.target), ["design/x-css.test.ts"]);
});

// ── the ratchet ─────────────────────────────────────────────────────────────

test("the ratchet is keyed by target: fixing one and adding another in the same file fails both ways", () => {
  // The count-shaped first version netted this to zero and passed (#1561).
  const r = dp.compareToBaseline({ "a.ts": ["src/new.ts"] }, { "a.ts": ["src/old.ts"] });
  assert.deepEqual(r.added, [{ file: "a.ts", target: "src/new.ts" }]);
  assert.deepEqual(r.removed, [{ file: "a.ts", target: "src/old.ts" }]);
});

test("a repeated target is a multiset: a second copy of a known dead path is new", () => {
  const r = dp.compareToBaseline({ "a.md": ["x.md", "x.md"] }, { "a.md": ["x.md"] });
  assert.deepEqual(r.added, [{ file: "a.md", target: "x.md" }]);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(dp.compareToBaseline({ "a.md": ["x.md", "x.md"] }, { "a.md": ["x.md", "x.md"] }), { added: [], removed: [], invalid: [] });
});

test("an empty entry, or the count shape this format replaced, is refused", () => {
  const r = dp.compareToBaseline({}, { "a.ts": [], "b.ts": 2 });
  assert.equal(r.invalid.length, 2);
  assert.deepEqual(r.removed, []);
});

test("a written baseline is deterministic, so regenerating an unchanged tree is an empty diff", () => {
  const f = (file, target) => ({ file, target });
  const a = dp.renderBaseline(dp.targetsByFile([f("z.ts", "src/b.ts"), f("a.md", "x.md"), f("z.ts", "src/a.ts")]));
  const b = dp.renderBaseline(dp.targetsByFile([f("a.md", "x.md"), f("z.ts", "src/a.ts"), f("z.ts", "src/b.ts")]));
  assert.equal(a, b);
  assert.equal(a, '{\n  "a.md": [\n    "x.md"\n  ],\n  "z.ts": [\n    "src/a.ts",\n    "src/b.ts"\n  ]\n}\n');
});

test("front matter needs a key on its first line: a doc opening with a rule keeps its headings", () => {
  assert.deepEqual([...dp.anchorsInSource("---\n\nIntro\n\n## A\n\nText\n\n---\n\n## B\n")], ["a", "b"]);
  assert.deepEqual([...dp.anchorsInSource("---\ntitle: x\n---\n## A\n")], ["a"]);
});

test("a setext heading may hold a pipe or open with inline HTML; continuations and indented code are no heading", () => {
  assert.deepEqual([...dp.anchorsInSource("Use a | b\n---\n")], ["use-a--b"]);
  assert.deepEqual([...dp.anchorsInSource("<kbd>Ctrl</kbd> keys\n===\n")], ["ctrl-keys"]);
  for (const src of [
    "- item\n  continued\n---\n",
    "> q\nlazy\n---\n",
    "Para\n\n    code\n---\n",
    "a | b\n--- | ---\n1 | 2\n---\n",
    "<div>\nblock\n</div>\n---\n",
  ]) assert.deepEqual([...dp.anchorsInSource(src)], [], src);
});

test("a regex after a keyword or a closing brace is a regex: its quote opens no string", () => {
  const src = [
    "function f(x) { return /\"/.test(x); } // see src/i.ts",
    "switch (x) { case 1: break; } /x'/.test(y) // src/q.ts",
    "const t = typeof /'/; // src/t.ts",
  ].join("\n");
  assert.deepEqual(dp.slashComments(src).map((c) => [c.line, c.text.trim()]), [
    [1, "see src/i.ts"], [2, "src/q.ts"], [3, "src/t.ts"],
  ]);
});

test("in JSX, an apostrophe inside a word is text, not a string", () => {
  const src = "const a = <p>Don't</p>; // see src/j.ts\n";
  assert.deepEqual(dp.commentsOf("src/a.tsx", src).map((c) => c.text.trim()), ["see src/j.ts"]);
  // Outside JSX files the rule is off: C's L'x' is a wide char literal.
  assert.deepEqual(dp.commentsOf("src/a.c", "char c = L'/'; // src/c.h\n").map((c) => c.text.trim()), ["src/c.h"]);
});

test("an @ drops a token only as a pinned ref: a file name holding @ is still a path", () => {
  assert.deepEqual(dp.pathCandidates("see assets/icon@2x.png and docs/a.md"), ["assets/icon@2x.png", "docs/a.md"]);
  for (const ref of ["actions/checkout@v7", "pkg/name@1.2.3", "org/action@0123abcd", "org/action@main"]) {
    assert.deepEqual(dp.pathCandidates(`uses ${ref} here`), [], ref);
  }
});
