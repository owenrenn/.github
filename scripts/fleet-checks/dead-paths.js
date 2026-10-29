"use strict";

/**
 * Dead paths: a path in a live doc or a code comment that resolves to nothing
 * in the repository it sits in (#867 Phase 1 for docs, the D7 ruling on #1555
 * for comments, built in #1561).
 *
 * Source of truth: the operations repo's `scripts/fleet-checks/`. The copy in
 * the shared workflow repo is written by `publish.sh` there and is never
 * hand-edited. Everything in this file is published, so it names roles, never
 * repositories, and its issue refs are bare `#N` (#1243).
 *
 * ── PRECISION OVER RECALL ───────────────────────────────────────────────────
 *
 * A detector that invents findings gets switched off, or weakened until it
 * reports nothing (#409). The link checker's first draft reported 54 dangling
 * anchors and one was real: it kept em-dashes in heading slugs, and GitHub
 * strips them (#867). So every rule below that decides "this is a path" errs
 * toward NOT judging a token, and each one is pinned by a test:
 *
 *   - A comment token is judged only when its first segment is a tracked
 *     top-level entry of the repo, or it starts `./` / `../`. Prose such as
 *     `and/or`, an `owner/repo` pair, or an import alias like `@/lib/x` has
 *     no tracked first segment, so it is never read as a path.
 *   - A token touching a glob or template character (`*`, `<`, `{`, `$`, `[`)
 *     is a pattern, not a path, and is skipped whole rather than cut short.
 *   - A gitignored path is a build output or a per-machine file. A comment may
 *     name one ("the build writes target/release/…"), so it is skipped.
 *   - A path that resolves file-relative, or with a source extension added
 *     (`src/lib/cache-headers` → `.ts`), resolves.
 *
 * ── THE SLUG ALGORITHM ──────────────────────────────────────────────────────
 *
 * GitHub's heading → anchor rule, in order (pinned in dead-paths.test.js):
 *   1. strip inline code backticks and any HTML tags
 *   2. lowercase
 *   3. drop every character that is not a letter, number, space, `-` or `_`
 *      (this step eats `—`, `·`, `:`, `.`, `(`, `⚠`, `/`)
 *   4. spaces → `-`
 *   5. a repeated slug gets `-1`, `-2`, … in document order
 *
 * ── WHAT COUNTS AS A FINDING ────────────────────────────────────────────────
 *
 * Tracked-ness decides, not filesystem presence. A doc link to a file that is
 * on this machine but not in git is broken for every other reader, and the
 * reason string says which of the two defects it is (#867).
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// ── git ─────────────────────────────────────────────────────────────────────

/** Every tracked file under `root`, from git: a filesystem walk would judge worktree copies (#867). */
function trackedFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const files = out.split("\0").filter(Boolean);
  // An empty answer from a repo is impossible; a clean verdict over zero files is the vacuous green (#867).
  if (files.length === 0) throw new Error(`trackedFiles(): git ls-files returned nothing under ${root}`);
  return files;
}

/** The subset of `paths` git would ignore. `check-ignore` matches patterns, so the paths need not exist. */
function ignoredPaths(root, paths) {
  if (paths.length === 0) return new Set();
  let out = "";
  try {
    out = execFileSync("git", ["check-ignore", "-z", "--stdin"], {
      cwd: root, input: paths.join("\0"), encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    // Exit 1 means "none of these are ignored", which is an answer, not a failure.
    if (e.status === 1) return new Set();
    throw e;
  }
  return new Set(out.split("\0").filter(Boolean));
}

// ── scope ───────────────────────────────────────────────────────────────────

/**
 * Files that state what was true at a date. Editing one to agree with today
 * destroys the record that made it worth keeping, so no detector judges them
 * (#867; the vault convention `archived-documents-get-pointers-not-edits`).
 *
 * The dated-audit rule matches the FILENAME, not the content: a content
 * heuristic is a judgment call, and a mechanical detector does not make those.
 */
const DATED_RECORD_EXEMPTIONS = [
  {
    reason: "dated record (docs/superpowers/) — states what was true at its date",
    test: (f) => f.startsWith("docs/superpowers/"),
  },
  {
    reason: "archived (docs/archive/) — the vault convention archived-documents-get-pointers-not-edits",
    test: (f) => f.startsWith("docs/archive/"),
  },
  {
    // Anchored on a four-digit year, so a live doc whose name merely contains "audit" stays in scope.
    reason: "dated audit — the filename carries the date of its own measurement",
    test: (f) => /(?:^|[/-])(?:[A-Z-]*AUDIT|audit)-\d{4}-\d{2}(?:-\d{2})?\.md$/.test(path.basename(f)) ||
                 /-audit-\d{4}-\d{2}(?:-\d{2})?\.md$/i.test(f),
  },
];

/**
 * Release history is a dated record too: an entry saying a file was removed
 * names a file that no longer exists, correctly (D8 ruling on #1555).
 */
const CHANGELOG_EXEMPTIONS = [
  {
    reason: "release history (CHANGELOG.md) — each section states what shipped at its date",
    test: (f) => path.posix.basename(f) === "CHANGELOG.md",
  },
  {
    reason: "changelog fragment (changelog.d/) — states what one PR shipped",
    test: (f) => f.startsWith("changelog.d/"),
  },
];

const DEFAULT_EXEMPTIONS = [...DATED_RECORD_EXEMPTIONS, ...CHANGELOG_EXEMPTIONS];

const DOC_EXTENSIONS = [".md", ".md.tmpl"];

/**
 * Comment syntax by extension. A file type not listed here is not read for
 * comments at all: guessing a syntax would read code as prose.
 */
const SLASH = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".rs", ".go", ".java",
  ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".css", ".scss", ".jsonc"]);
const HASH = new Set([".sh", ".bash", ".zsh", ".py", ".rb", ".yml", ".yaml", ".toml"]);
const HASH_NAMES = new Set(["Dockerfile", "Makefile", ".gitignore"]);

function commentSyntax(f) {
  const base = path.posix.basename(f);
  if (HASH_NAMES.has(base)) return "hash";
  const ext = path.posix.extname(f);
  if (SLASH.has(ext)) return "slash";
  if (HASH.has(ext)) return "hash";
  return null;
}

/** Minimal glob: `**` crosses `/`, `*` and `?` do not; a trailing `/` means the whole directory. */
function globToRegExp(glob) {
  if (glob.endsWith("/")) glob += "**";
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const matchesAny = (f, globs) => globs.some((g) => globToRegExp(g).test(f));

/**
 * Split the tracked set into the docs and code files the detector judges.
 *
 * `exempt` entries come from the repo's config and each must carry a `why`:
 * an exemption is a coverage gap, and an unexplained one is indistinguishable
 * from a mistake (#867). Exempt files are returned with their reasons so a
 * report can say what it did not look at rather than shrinking the
 * denominator in silence.
 */
function selectCorpus(tracked, { exempt = [], comments = true } = {}) {
  const rules = [
    ...DEFAULT_EXEMPTIONS,
    ...exempt.map(({ glob, why }) => ({ reason: `repo config — ${why}`, test: (f) => globToRegExp(glob).test(f) })),
  ];
  const docs = [];
  const code = [];
  const excused = [];
  for (const f of tracked) {
    const isDoc = DOC_EXTENSIONS.some((e) => f.endsWith(e));
    const syntax = comments && !isDoc ? commentSyntax(f) : null;
    if (!isDoc && !syntax) continue;
    const rule = rules.find((r) => r.test(f));
    if (rule) { excused.push({ file: f, reason: rule.reason }); continue; }
    (isDoc ? docs : code).push(f);
  }
  return { docs, code, excused };
}

// ── markdown ────────────────────────────────────────────────────────────────

const FENCE = /^ {0,3}(```|~~~)[\s\S]*?^ {0,3}\1[^\n]*$/gm;

/** GitHub's heading → anchor slug. See the header for the enumerated rules. */
function slugify(heading) {
  return heading
    .replace(/`/g, "")
    .replace(/<[^>]*>/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/**
 * Every anchor a markdown source offers: deduplicated heading slugs plus
 * explicit `<a name>` / `<a id>` targets. Fenced code is stripped first, since
 * a `#` comment in a shell block is not a heading and would invent an anchor.
 */
function anchorsInSource(src) {
  const prose = src.replace(FENCE, "");
  const seen = new Map();
  const anchors = new Set();
  for (const m of prose.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slugify(m[1]);
    if (base === "") continue;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const m of prose.matchAll(/<a\s+(?:name|id)=["']([^"']+)["']/g)) anchors.add(m[1]);
  return anchors;
}

const anchorsOf = (relPath, root) => anchorsInSource(fs.readFileSync(path.join(root, relPath), "utf8"));

/**
 * Markdown inline links. Fenced code is blanked rather than deleted, so line
 * numbers survive; a label may hold one level of brackets (`[`#475`]`).
 */
function linksOf(src) {
  const prose = src.replace(FENCE, (b) => b.replace(/[^\n]/g, " "));
  const out = [];
  for (const m of prose.matchAll(/\[((?:[^\][]|\[[^\][]*\])*)\]\(([^()\s]+)\)/g)) {
    out.push({ label: m[1], target: m[2], line: prose.slice(0, m.index).split("\n").length });
  }
  return out;
}

// ── comments ────────────────────────────────────────────────────────────────

/**
 * The comment text of a `#`-syntax file, per line. A `#` opens a comment at
 * the start of a line or after whitespace, outside quotes: `${#arr[@]}` and a
 * URL fragment are not comments.
 */
function hashComments(src) {
  const out = [];
  src.split("\n").forEach((text, i) => {
    let quote = null;
    for (let j = 0; j < text.length; j++) {
      const c = text[j];
      if (quote) {
        if (c === "\\" && quote === '"') j++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === "#" && (j === 0 || /\s/.test(text[j - 1]))) {
        out.push({ line: i + 1, text: text.slice(j + 1) });
        return;
      }
    }
  });
  return out;
}

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "\n", "+", "-", "*", "%", "<", ">", "~", "^"]);

/**
 * The comment text of a `//` + block-comment file, per line. A small lexer
 * rather than a regex, because `"https://…"` in a string and `/\/\//` in a
 * regex both contain `//` and neither is a comment.
 *
 * `rust` changes two rules: `'a` is a lifetime unless it closes as a char
 * literal, and `r#"…"#` is a raw string.
 */
function slashComments(src, { rust = false } = {}) {
  const out = [];
  let line = 1;
  let i = 0;
  let lastSig = "\n";
  const push = (text, at) => { if (text.trim()) out.push({ line: at, text }); };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "\n") { line++; i++; lastSig = "\n"; continue; }
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      push(src.slice(i + 2, stop), line);
      i = stop;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end;
      const body = src.slice(i + 2, stop).split("\n");
      body.forEach((t, k) => push(t.replace(/^\s*\*(?!\/)/, ""), line + k));
      line += body.length - 1;
      i = stop + 2;
      lastSig = "/";
      continue;
    }
    if (rust && c === "r" && /^r#*"/.test(src.slice(i, i + 40)) && !/[\w]/.test(src[i - 1] ?? "")) {
      const hashes = /^r(#*)"/.exec(src.slice(i))[1];
      const close = `"${hashes}`;
      const end = src.indexOf(close, i + 2 + hashes.length);
      const stop = end === -1 ? src.length : end + close.length;
      line += (src.slice(i, stop).match(/\n/g) || []).length;
      i = stop;
      lastSig = '"';
      continue;
    }
    if (c === '"' || c === "`" || (c === "'" && !rust) || (c === "'" && rust && /^'(?:\\.[^']{0,8}|[^\\'])'/.test(src.slice(i, i + 12)))) {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        // A plain quote does not cross a line; an unterminated one is a stray
        // apostrophe, and swallowing the rest of the file would hide every comment.
        else if (src[j] === "\n" && c !== "`") break;
        j++;
      }
      line += (src.slice(i, j).match(/\n/g) || []).length;
      // Stopped at a newline: leave it for the top of the loop, which counts it.
      i = src[j] === c ? j + 1 : j;
      lastSig = c;
      continue;
    }
    if (c === "/" && !rust && REGEX_PRECEDERS.has(lastSig)) {
      let j = i + 1;
      let cls = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) break;
        j++;
      }
      i = j + 1;
      lastSig = "/";
      continue;
    }
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out;
}

function commentsOf(file, src) {
  const syntax = commentSyntax(file);
  if (syntax === "hash") return hashComments(src);
  if (syntax === "slash") return slashComments(src, { rust: file.endsWith(".rs") });
  return [];
}

/** Basenames that stand for "some file" in an example, never a file. */
const PLACEHOLDER = /^(?:x|y|z|foo|bar|baz|qux|example|placeholder|name|thing)(?:\.[a-z]+)?$/i;

/**
 * Path-shaped tokens in a line of comment text. Deliberately narrow: a token
 * needs a `/`, must not be part of a URL, and must not touch a glob or template
 * character. Whether it is judged at all is decided later, against the repo.
 *
 * Two shapes are dropped here because they name a file correctly and still
 * resolve to nothing in this file's context: a token inside quotes is quoted
 * CODE (`import("./readouts/x")`, `"build": "node scripts/y.mjs"`), whose path
 * is relative to the code's file, and a placeholder basename (`src/x.ts`) is an
 * example. Both were measured false positives (#1561).
 */
function pathCandidates(text) {
  const out = [];
  const re = /[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@()-]+)+\/?(?:#[A-Za-z0-9_-]+)?|\.{1,2}\/[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@()-]+)*\/?/g;
  for (const m of text.matchAll(re)) {
    const before = text[m.index - 1] ?? " ";
    const after = text[m.index + m[0].length] ?? " ";
    if (/[\w/@:$<{*\\]/.test(before) || before === ".") continue;   // mid-token, a URL, a template
    if (/[*<>{}$[\]\w\\]/.test(after)) continue;                    // a glob or a placeholder
    if (before === '"' || before === "'") continue;                   // quoted code
    let token = m[0].replace(/[.,;:)]+$/, "").replace(/\(+$/, "");
    if (token.includes("(") && !token.includes(")")) token = token.slice(0, token.indexOf("("));
    if (/^\d+(?:\/\d+)+$/.test(token)) continue;                      // a fraction or a date, 3/4 or 10/28
    if (!token.includes("/")) continue;
    if (!token.split("/").some((seg) => /[^.]/.test(seg))) continue;   // `../../` names no file
    if (PLACEHOLDER.test(path.posix.basename(token.split("#")[0].replace(/\/$/, "")))) continue;
    out.push(token);
  }
  return out;
}

// ── resolution ──────────────────────────────────────────────────────────────

/** Extensions tried when a comment names a module without one, as imports do. */
const MODULE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json", ".md", ".rs", ".sh", ".py",
  "/index.ts", "/index.tsx", "/index.js", "/mod.rs"];

function makeIndex(tracked) {
  const files = tracked instanceof Set ? tracked : new Set(tracked);
  const dirs = new Set();
  const top = new Set();
  for (const f of files) {
    top.add(f.split("/")[0]);
    for (let d = path.posix.dirname(f); d && d !== "."; d = path.posix.dirname(d)) dirs.add(d);
  }
  const uniqueSuffix = (tail) => {
    const hits = [];
    for (const f of files) if (f.endsWith(`/${tail}`) && hits.push(f) > 1) return undefined;
    return hits[0];
  };
  return { files, dirs, top, has: (p) => files.has(p) || dirs.has(p), uniqueSuffix };
}

/**
 * A comment that names a path in ANOTHER repository says so nearby: "the
 * shared workflow repo's `scripts/x.js`", "other#508, `docs/y.md`". That path
 * is correct and unresolvable here, and it was the largest false-positive class
 * when this check was first measured (#1561). So a comment line is not judged
 * when it, or the comment line on either side of it, says "repo", carries a
 * repo-qualified issue ref (`name#N`), names an `owner/.github` repo, or names
 * one of the repo's configured `foreignNames`.
 *
 * Skipping costs recall, a real dead path beside one of those words, and that
 * is the side this detector errs on.
 */
function foreignContext(foreignNames = []) {
  const words = ["\\brepo(?:s|'s|sitory|sitories)?\\b", "[A-Za-z0-9_.-]+#\\d+", "\\b[\\w-]+/\\.github\\b",
    ...foreignNames.map((n) => `(?<![\\w-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`)];
  return new RegExp(words.join("|"), "i");
}

/**
 * Parents of gitignored output, from every tracked `.gitignore`: `desktop/out/`
 * makes `desktop/out` a build output even on a checkout that has not built yet,
 * and `/public/maplibre/` makes `public/maplibre` one. `git check-ignore` alone
 * cannot see the second shape when only children are ignored.
 */
function ignoredPrefixes(root, tracked) {
  const out = [];
  for (const f of tracked) {
    if (path.posix.basename(f) !== ".gitignore") continue;
    const dir = path.posix.dirname(f) === "." ? "" : `${path.posix.dirname(f)}/`;
    let src = "";
    try { src = fs.readFileSync(path.join(root, f), "utf8"); } catch { continue; }
    for (let l of src.split("\n")) {
      l = l.trim();
      if (!l || l.startsWith("#") || l.startsWith("!") || /[*?[]/.test(l)) continue;
      out.push(dir + l.replace(/^\//, "").replace(/\/$/, ""));
    }
  }
  return out;
}

// ── the judge ───────────────────────────────────────────────────────────────

/**
 * Judge docs' links and code comments' paths.
 *
 * @param {object} o
 * @param {string} o.root                 repository root
 * @param {Set<string>|string[]} o.tracked tracked files (repo-relative)
 * @param {string[]} [o.docs]             markdown files whose links are judged
 * @param {string[]} [o.code]             code files whose comments are judged
 * @param {Set<string>} [o.linksResolveElsewhere] docs whose relative links resolve
 *        at a destination (a seeded template), so only their anchors are judged
 * @param {string[]} [o.foreignNames]  names of other repositories this repo's
 *        comments cite; a line near one is not judged (see foreignContext)
 * @returns {{findings:object[], skippedIgnored:number}}
 */
function findDeadPaths({ root, tracked, docs = [], code = [], linksResolveElsewhere = new Set(), foreignNames = [] }) {
  const idx = makeIndex(tracked);
  const foreign = foreignContext(foreignNames);
  const findings = [];
  const anchorCache = new Map();
  const anchors = (f) => {
    if (!anchorCache.has(f)) anchorCache.set(f, anchorsOf(f, root));
    return anchorCache.get(f);
  };

  for (const file of docs) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    const dir = path.posix.dirname(file);
    for (const { target, line } of linksOf(src)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
      if (target.startsWith("#")) {
        if (!anchors(file).has(decodeURIComponent(target.slice(1)))) {
          findings.push({ file, line, target, kind: "anchor", reason: "no heading in this file slugs to it" });
        }
        continue;
      }
      const [rawPath, frag] = target.split("#");
      if (rawPath === "" || linksResolveElsewhere.has(file)) continue;
      const resolved = path.posix.normalize(path.posix.join(dir, decodeURIComponent(rawPath))).replace(/\/$/, "");
      if (resolved.startsWith("..")) {
        findings.push({ file, line, target, resolved, kind: "link", reason: "resolves outside the repository" });
        continue;
      }
      if (idx.has(resolved)) {
        if (frag && resolved.endsWith(".md") && idx.files.has(resolved) && !anchors(resolved).has(decodeURIComponent(frag))) {
          findings.push({ file, line, target, kind: "anchor", reason: `no heading in ${resolved} slugs to it` });
        }
        continue;
      }
      const onDisk = fs.existsSync(path.join(root, resolved));
      findings.push({
        file, line, target, resolved, kind: "link",
        reason: onDisk
          ? "target exists on this machine but is NOT tracked — gitignored or per-machine, so broken for every other reader"
          : "target does not exist in the repository",
      });
    }
  }

  // Comments: collect unresolved candidates first, so the gitignore question is
  // one `git check-ignore` call rather than one per token.
  const pending = [];
  for (const file of code) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    const dir = path.posix.dirname(file);
    const comments = commentsOf(file, src);
    const byLine = new Map(comments.map((c) => [c.line, c.text]));
    for (const { line, text } of comments) {
      if ([line - 1, line, line + 1].some((l) => byLine.has(l) && foreign.test(byLine.get(l)))) continue;
      for (const token of pathCandidates(text)) {
        const [raw, frag] = token.split("#");
        const relative = raw.startsWith("./") || raw.startsWith("../");
        const clean = raw.replace(/\/$/, "");
        if (!relative && !idx.top.has(clean.split("/")[0])) continue;
        // `./x` is read both ways: a script's comment means its cwd (the repo root) as often as its own directory.
        const bases = raw.startsWith("../") ? [path.posix.join(dir, clean)]
          : raw.startsWith("./") ? [path.posix.join(dir, clean), clean.slice(2)]
          : [clean, path.posix.join(dir, clean)];
        const norm = bases.map((b) => path.posix.normalize(b));
        if (norm[0].startsWith("..")) continue;   // leaves the repo: another checkout's path, not judged
        // A unique tracked file ending in the token resolves too: `design/x.test.ts`
        // written from inside `src/__tests__/` is findable, if imprecise (#1561).
        const hit = norm.flatMap((b) => MODULE_SUFFIXES.map((s) => b + s)).find((p) => idx.has(p)) ??
          (relative ? undefined : idx.uniqueSuffix(clean));
        if (hit) {
          if (frag && hit.endsWith(".md") && idx.files.has(hit) && !anchors(hit).has(frag)) {
            findings.push({ file, line, target: token, kind: "comment-anchor", reason: `no heading in ${hit} slugs to it` });
          }
          continue;
        }
        pending.push({ file, line, target: token, resolved: norm[0] });
      }
    }
  }
  const probes = [...new Set(pending.flatMap((p) => [p.resolved, `${p.resolved}/`]))];
  const ignored = ignoredPaths(root, probes);
  const prefixes = ignoredPrefixes(root, idx.files);
  const isIgnored = (p) => ignored.has(p) || ignored.has(`${p}/`) ||
    prefixes.some((x) => x === p || x.startsWith(`${p}/`) || p.startsWith(`${x}/`));
  let skippedIgnored = 0;
  for (const p of pending) {
    if (isIgnored(p.resolved)) { skippedIgnored++; continue; }
    findings.push({ file: p.file, line: p.line, target: p.target, resolved: p.resolved, kind: "comment-path", reason: "names a path that does not exist in the repository" });
  }
  return { findings, skippedIgnored };
}

// ── the ratchet ─────────────────────────────────────────────────────────────

/**
 * Where a repo records the dead paths it already had when it adopted the check.
 *
 * The D7 comment rule binds new and touched comments only, with no sweep of
 * existing ones (#1555), and a check that failed on every existing dead path
 * would turn each repo's rollout PR red on its first run. So the check is a
 * ratchet, in both directions: a new dead path fails, and a fixed one fails
 * until the baseline is regenerated in the same PR, so the record stays true
 * rather than becoming a ceiling that drifts away from the tree.
 *
 * Each entry is a file's dead TARGETS, not a count of them: with a count,
 * fixing one dead path and adding another in the same file nets to zero and
 * passes (#1561). Line numbers are left out because every edit above a line
 * moves it, and a baseline that changed on unrelated edits would be
 * regenerated by reflex. A target repeated in a file is listed once per
 * occurrence, so a second copy of a known dead path is still new.
 */
const BASELINE_PATH = ".github/dead-paths-baseline.json";

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Each file's dead targets, files and targets sorted, so regenerating an unchanged tree is an empty diff. */
function targetsByFile(findings) {
  const map = {};
  for (const f of findings) (map[f.file] ??= []).push(f.target);
  return Object.fromEntries(Object.keys(map).sort(byCodePoint).map((k) => [k, map[k].sort(byCodePoint)]));
}

/** The file a baseline is written as: deterministic, one trailing newline. */
const renderBaseline = (targets) => `${JSON.stringify(targets, null, 2)}\n`;

/** `a` minus `b`, as multisets: each element of `b` cancels one equal element of `a`. */
function multisetMinus(a, b) {
  const left = new Map();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  const out = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

/**
 * Live dead targets against the recorded ones, in both directions.
 *
 * @returns {{added:{file:string,target:string}[], removed:{file:string,target:string}[], invalid:string[]}}
 */
function compareToBaseline(live, baseline) {
  const invalid = [];
  const recorded = {};
  for (const [f, list] of Object.entries(baseline)) {
    // An empty list is a file that was cleaned without its entry being removed;
    // a number is the count-shaped baseline this format replaced (#1561).
    if (!Array.isArray(list) || list.length === 0 || list.some((t) => typeof t !== "string" || !t)) {
      invalid.push(`${f}: ${JSON.stringify(list)} is not a list of dead targets — regenerate with --write-baseline`);
      continue;
    }
    recorded[f] = list;
  }
  const added = [];
  const removed = [];
  for (const f of [...new Set([...Object.keys(live), ...Object.keys(recorded)])].sort(byCodePoint)) {
    for (const target of multisetMinus(live[f] ?? [], recorded[f] ?? [])) added.push({ file: f, target });
    for (const target of multisetMinus(recorded[f] ?? [], live[f] ?? [])) removed.push({ file: f, target });
  }
  return { added, removed, invalid };
}

module.exports = {
  DATED_RECORD_EXEMPTIONS, CHANGELOG_EXEMPTIONS, DEFAULT_EXEMPTIONS, DOC_EXTENSIONS,
  trackedFiles, ignoredPaths, ignoredPrefixes, foreignContext, selectCorpus, globToRegExp, matchesAny, commentSyntax,
  slugify, anchorsInSource, anchorsOf, linksOf,
  hashComments, slashComments, commentsOf, pathCandidates,
  findDeadPaths, BASELINE_PATH, targetsByFile, renderBaseline, compareToBaseline,
};
