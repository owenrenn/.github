"use strict";

/**
 * A throwaway git repository for the fleet-checks suites (#1561). Every git
 * fact these tools read (tracked files, ignore rules, adding commits, tags) is
 * built for real rather than mocked, because a mock of git agrees with
 * whatever the code under test assumes about git.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Identity and signing come from the environment, so a developer's global git
// config (a signing key, a hook path) cannot change what a fixture commit is.
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1",
};

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-checks-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, env: ENV, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  const write = (files) => {
    for (const [p, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.writeFileSync(path.join(root, p), text);
    }
  };
  const commit = (subject, files = {}) => {
    write(files);
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", subject);
    return git("rev-parse", "HEAD").trim();
  };
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { root, git, write, commit, cleanup, env: ENV };
}

module.exports = { makeRepo, ENV };
