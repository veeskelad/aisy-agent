#!/usr/bin/env bash
# User-level managed Git bootstrap for Aisy (ADR-0106 / component 28).
set -euo pipefail

ORIGIN='https://github.com/veeskelad/aisy-agent.git'
BRANCH='master'
GIT_BIN='/usr/bin/git'
FLOCK_BIN='/usr/bin/flock'
if [ "$#" -ne 0 ]; then
  printf '%s\n' 'aisy install: операция отклонена (UPDATE_SOURCE_REFUSED)' >&2
  exit 1
fi
INSTALL_ROOT="${AISY_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/aisy}"
BIN_DIR="${AISY_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}"
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_TERMINAL_PROMPT=0

refuse() {
  printf '%s\n' "aisy install: операция отклонена (${1})" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || refuse UPDATE_SOURCE_REFUSED
}

git_safe() {
  /usr/bin/env -i \
    HOME="$HOME" \
    PATH='/usr/bin:/bin' \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_TERMINAL_PROMPT=0 \
    "$GIT_BIN" "$@"
}

ensure_directories() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const uid = process.geteuid();
    function check(current) {
      const info = fs.lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink() ||
          (info.uid !== 0 && info.uid !== uid) || (info.mode & 0o022) !== 0 ||
          fs.realpathSync(current) !== current) throw new Error("unsafe");
    }
    for (const target of process.argv.slice(1)) {
      const missing = [];
      let current = target;
      while (!fs.existsSync(current)) {
        missing.push(current);
        current = path.dirname(current);
      }
      for (let ancestor = current;; ancestor = path.dirname(ancestor)) {
        check(ancestor);
        if (path.dirname(ancestor) === ancestor) break;
      }
      for (const directory of missing.reverse()) {
        fs.mkdirSync(directory, { mode: 0o700 });
        check(directory);
      }
      check(target);
    }
  ' "$@"
}

case "$INSTALL_ROOT" in
  /*) ;;
  *) refuse UPDATE_SOURCE_REFUSED ;;
esac
case "$BIN_DIR" in
  /*) ;;
  *) refuse UPDATE_SOURCE_REFUSED ;;
esac

if [ "${EUID:-$(id -u)}" -eq 0 ]; then
  refuse UPDATE_SOURCE_REFUSED
fi

need node
need corepack
if [ ! -x "$GIT_BIN" ] || [ ! -x "$FLOCK_BIN" ]; then
  refuse UPDATE_SOURCE_REFUSED
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  refuse UPDATE_SOURCE_REFUSED
fi

CANONICAL_INSTALL_ROOT="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$INSTALL_ROOT")"
CANONICAL_BIN_DIR="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$BIN_DIR")"
if [ "$CANONICAL_INSTALL_ROOT" != "$INSTALL_ROOT" ] || [ "$CANONICAL_BIN_DIR" != "$BIN_DIR" ]; then
  refuse UPDATE_SOURCE_REFUSED
fi
case "$BIN_DIR/" in
  "$INSTALL_ROOT/"*) refuse UPDATE_SOURCE_REFUSED ;;
esac

umask 077
if [ -e "$INSTALL_ROOT" ] && [ ! -d "$INSTALL_ROOT" ]; then
  refuse UPDATE_NOT_MANAGED
fi
ensure_directories "$INSTALL_ROOT" "$BIN_DIR" || refuse UPDATE_SOURCE_REFUSED
if ! node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const uid = process.geteuid();
  for (const start of process.argv.slice(1)) {
    let current = start;
    while (true) {
      const info = fs.lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink() ||
          (info.uid !== 0 && info.uid !== uid) || (info.mode & 0o022) !== 0 ||
          fs.realpathSync(current) !== current) process.exit(1);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
' "$INSTALL_ROOT" "$BIN_DIR"; then
  refuse UPDATE_SOURCE_REFUSED
fi

REPOSITORY="$INSTALL_ROOT/repository.git"
RELEASES="$INSTALL_ROOT/releases"
GENERATIONS="$INSTALL_ROOT/generations"
BOOTSTRAP_LOCK="$INSTALL_ROOT/bootstrap.lock"

exec 9>>"$BOOTSTRAP_LOCK"
if ! node -e '
  const fs = require("node:fs");
  const named = fs.lstatSync(process.argv[1]);
  const opened = fs.fstatSync(9);
  if (!opened.isFile() || named.isSymbolicLink() || !named.isFile() ||
      opened.dev !== named.dev || opened.ino !== named.ino ||
      opened.uid !== process.geteuid() || opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600) process.exit(1);
' "$BOOTSTRAP_LOCK"; then
  refuse UPDATE_SOURCE_REFUSED
fi
set +e
"$FLOCK_BIN" -E 75 -n 9
LOCK_STATUS="$?"
set -e
if [ "$LOCK_STATUS" -eq 75 ]; then
  refuse UPDATE_BUSY
fi
if [ "$LOCK_STATUS" -ne 0 ]; then
  refuse UPDATE_SOURCE_REFUSED
fi

if [ -e "$REPOSITORY" ]; then
  if [ ! -d "$REPOSITORY" ] || [ -L "$REPOSITORY" ]; then
    refuse UPDATE_NOT_MANAGED
  fi
  CURRENT_ORIGIN="$(git_safe --git-dir="$REPOSITORY" config --get remote.origin.url)"
  if [ "$CURRENT_ORIGIN" != "$ORIGIN" ]; then
    refuse UPDATE_SOURCE_REFUSED
  fi
else
  if ! node -e '
    const fs = require("node:fs");
    const entries = fs.readdirSync(process.argv[1]).filter(name => name !== "bootstrap.lock");
    process.exit(entries.length === 0 ? 0 : 1);
  ' "$INSTALL_ROOT"; then
    refuse UPDATE_NOT_MANAGED
  fi
  git_safe clone --bare --single-branch --branch "$BRANCH" --no-tags -- "$ORIGIN" "$REPOSITORY"
fi

ensure_directories "$RELEASES" "$GENERATIONS" || refuse UPDATE_SOURCE_REFUSED

if [ -L "$INSTALL_ROOT/active" ]; then
  ACTIVE_TARGET="$(readlink "$INSTALL_ROOT/active")"
  if [[ ! "$ACTIVE_TARGET" =~ ^generations/g-[a-f0-9]{16,64}$ ]]; then
    refuse UPDATE_STATE_REFUSED
  fi
  CURRENT_TARGET="$(readlink "$INSTALL_ROOT/active/current")"
  case "$CURRENT_TARGET" in
    ../../releases/[a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9]) ;;
    *) refuse UPDATE_STATE_REFUSED ;;
  esac
  ACTIVE_COMMIT="${CURRENT_TARGET##*/}"
  ACTIVE_RELEASE="$RELEASES/$ACTIVE_COMMIT"
  ACTIVE_BOOTSTRAP="$ACTIVE_RELEASE/packages/app/dist/bin/managed-bootstrap.js"
  if [ -L "$ACTIVE_BOOTSTRAP" ] || [ ! -f "$ACTIVE_BOOTSTRAP" ]; then
    refuse UPDATE_STATE_REFUSED
  fi
  if [ "$(git_safe -C "$ACTIVE_RELEASE" rev-parse HEAD)" != "$ACTIVE_COMMIT" ]; then
    refuse UPDATE_STATE_REFUSED
  fi
  if [ -n "$(git_safe -C "$ACTIVE_RELEASE" status --porcelain)" ]; then
    refuse UPDATE_SOURCE_REFUSED
  fi
  node "$ACTIVE_BOOTSTRAP" \
    "--install-root=$INSTALL_ROOT" \
    "--bin-dir=$BIN_DIR" \
    "--commit=$ACTIVE_COMMIT"
  exec "$BIN_DIR/aisy" update
fi
if [ -e "$INSTALL_ROOT/active" ]; then
  refuse UPDATE_STATE_REFUSED
fi

git_safe --git-dir="$REPOSITORY" fetch --prune --no-tags origin \
  "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
TARGET="$(git_safe --git-dir="$REPOSITORY" rev-parse "refs/remotes/origin/$BRANCH")"
case "$TARGET" in
  *[!a-f0-9]*|'') refuse UPDATE_SOURCE_REFUSED ;;
esac

RELEASE="$RELEASES/$TARGET"
if ! node -e '
  const { execFileSync } = require("node:child_process");
  const fs = require("node:fs");
  const [git, repository, release, target] = process.argv.slice(1);
  const clean = {
    PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  };
  const run = args => execFileSync(git, [`--git-dir=${repository}`, ...args], {
    cwd: "/", env: clean, stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
  const registered = () => {
    const fields = run(["worktree", "list", "--porcelain", "-z"])
      .toString("utf8").split("\0");
    let path = null, oid = null, detached = false, locked = null;
    const finish = () => {
      if (path !== release) return null;
      if (!detached) throw new Error("registry");
      if (locked === null) {
        if (oid !== target) throw new Error("registry");
        return { initializing: false };
      }
      if (locked !== "initializing" ||
          (oid !== target && !/^(?:0{40}|0{64})$/.test(oid || ""))) {
        throw new Error("registry");
      }
      return { initializing: true };
    };
    for (const field of fields) {
      if (field === "") {
        const found = finish();
        if (found !== null) return found;
        path = null; oid = null; detached = false; locked = null;
      } else if (field.startsWith("worktree ")) path = field.slice(9);
      else if (field.startsWith("HEAD ")) oid = field.slice(5);
      else if (field.startsWith("locked ")) locked = field.slice(7);
      else if (field === "detached") detached = true;
    }
    return finish();
  };
  run(["worktree", "prune", "--expire", "now"]);
  const present = fs.existsSync(release);
  const entry = registered();
  if (present) {
    const info = fs.lstatSync(release);
    if (!info.isDirectory() || info.isSymbolicLink() || entry === null) {
      throw new Error("residue");
    }
    run(["worktree", "remove", "--force", ...(entry.initializing ? ["--force"] : []), release]);
    run(["worktree", "prune", "--expire", "now"]);
    if (fs.existsSync(release) || registered() !== null) throw new Error("remove");
  } else if (entry !== null) {
    if (!entry.initializing) throw new Error("missing registry");
    run(["worktree", "remove", "--force", "--force", release]);
    run(["worktree", "prune", "--expire", "now"]);
    if (registered() !== null) throw new Error("remove registry");
  }
  run(["worktree", "add", "--detach", release, target]);
' "$GIT_BIN" "$REPOSITORY" "$RELEASE" "$TARGET"; then
  refuse UPDATE_SOURCE_REFUSED
fi
if [ "$(git_safe -C "$RELEASE" rev-parse HEAD)" != "$TARGET" ]; then
  refuse UPDATE_SOURCE_REFUSED
fi
if [ -n "$(git_safe -C "$RELEASE" status --porcelain)" ]; then
  refuse UPDATE_SOURCE_REFUSED
fi
if ! node -e '
  const { execFileSync } = require("node:child_process");
  const git = process.argv[1];
  const repository = process.argv[2];
  const commit = process.argv[3];
  const clean = {
    PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  };
  const run = (args, input) => execFileSync(git, [`--git-dir=${repository}`, ...args], {
    input, maxBuffer: 64 * 1024 * 1024,
    env: clean, stdio: ["pipe", "pipe", "ignore"],
  });
  const records = run([
    "ls-tree", "-rz", "--full-tree",
    "--format=%(objectmode) %(objecttype) %(objectname) %(objectsize)", commit,
  ]).toString("utf8").split("\0").filter(Boolean);
  const small = new Map();
  for (const record of records) {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64}) (-|\d+)$/.exec(record);
    if (!match || match[1] === "160000" || match[2] !== "blob") process.exit(1);
    const size = Number(match[4]);
    if (!Number.isSafeInteger(size) || size < 0) process.exit(1);
    if (size <= 4096) small.set(match[3], size);
  }
  if (small.size === 0) process.exit(0);
  const objects = [...small.keys()];
  const batch = run(["cat-file", "--batch"], Buffer.from(objects.join("\n") + "\n"));
  const lfs = Buffer.from("version https://git-lfs.github.com/spec/v1\n");
  let offset = 0;
  for (const object of objects) {
    const lineEnd = batch.indexOf(10, offset);
    if (lineEnd < 0) process.exit(1);
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob (\d+)$/.exec(
      batch.subarray(offset, lineEnd).toString("ascii"),
    );
    const size = match ? Number(match[2]) : -1;
    if (!match || match[1] !== object || size !== small.get(object)) process.exit(1);
    offset = lineEnd + 1;
    const raw = batch.subarray(offset, offset + size);
    if (raw.length !== size || batch[offset + size] !== 10) process.exit(1);
    if (raw.subarray(0, lfs.length).equals(lfs)) process.exit(1);
    offset += size + 1;
  }
  if (offset !== batch.length) process.exit(1);
' "$GIT_BIN" "$REPOSITORY" "$TARGET"; then
  refuse UPDATE_SOURCE_REFUSED
fi

if ! corepack pnpm --dir "$RELEASE" install --frozen-lockfile --config.package-import-method=copy; then
  refuse UPDATE_BUILD_FAILED
fi
if ! corepack pnpm --dir "$RELEASE" -r build; then
  refuse UPDATE_BUILD_FAILED
fi

node "$RELEASE/packages/app/dist/bin/managed-bootstrap.js" \
  "--install-root=$INSTALL_ROOT" \
  "--bin-dir=$BIN_DIR" \
  "--commit=$TARGET" \
  "--record-integrity=yes"

printf '%s\n' 'Aisy installed. Next: aisy init && aisy doctor'
