#!/usr/bin/env bash
# precheck.sh — decide whether the working tree is safe to commit unattended.
#
# Usage: precheck.sh [repo_dir]        (default: current directory)
#
# Prints a report and ends with exactly one verdict line:
#   VERDICT: clean    nothing to commit
#   VERDICT: ok       changes look ordinary; safe to stage and commit
#   VERDICT: review   something needs a human; see the FLAG lines above it
#
# Environment:
#   NIGHTLY_COMMIT_MAX_MB         size limit per file (default 5)
#   NIGHTLY_COMMIT_MAX_DELETES    tracked-file deletions before flagging (default 20)
#   NIGHTLY_COMMIT_SECRET_ALLOW   space-separated paths to skip in the secret scan
#                                 (files you intentionally track credentials in)
set -euo pipefail

cd "${1:-.}"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "FLAG: not a git repository"; echo "VERDICT: review"; exit 0; }

MAX_MB="${NIGHTLY_COMMIT_MAX_MB:-5}"
MAX_DELETES="${NIGHTLY_COMMIT_MAX_DELETES:-20}"
ALLOW=" ${NIGHTLY_COMMIT_SECRET_ALLOW:-} "
GIT_DIR_PATH="$(git rev-parse --git-dir)"
flags=0
flag() { echo "FLAG: $*"; flags=$((flags + 1)); }

# Half-finished state
for marker in MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD rebase-merge rebase-apply; do
  [[ -e "$GIT_DIR_PATH/$marker" ]] && flag "git operation in progress ($marker)"
done
if [[ -e "$GIT_DIR_PATH/index.lock" ]]; then
  flag "index.lock exists — another git process may be running"
fi

porcelain="$(git status --porcelain --untracked-files=all)"
if [[ -z "$porcelain" ]]; then
  echo "Working tree clean."
  echo "VERDICT: clean"
  exit 0
fi

echo "== git status =="
echo "$porcelain"
echo

# Conflict markers left in the index
if grep -qE '^(UU|AA|DD|AU|UA|DU|UD) ' <<<"$porcelain"; then
  flag "unmerged paths in the index"
fi

# Mass deletion
deletes="$(grep -cE '^( D|D ) ' <<<"$porcelain" || true)"
if (( deletes > MAX_DELETES )); then
  flag "$deletes tracked files deleted (limit $MAX_DELETES)"
fi

secret_re='(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{10,}|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----|(password|passwd|secret|api[_-]?key|token)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9/+_.-]{16,})'

while IFS= read -r line; do
  status="${line:0:2}"
  path="${line:3}"
  path="${path#* -> }"          # rename: keep the new path
  path="${path%\"}"; path="${path#\"}"
  [[ "$status" == *D* ]] && continue
  [[ -f "$path" ]] || continue

  size_mb=$(( ($(wc -c < "$path") + 1048575) / 1048576 ))
  if (( size_mb > MAX_MB )); then
    flag "$path is ~${size_mb} MB (limit ${MAX_MB} MB)"
    continue
  fi
  [[ "$ALLOW" == *" $path "* ]] && continue

  if [[ "$status" == "??" ]]; then
    content="$(grep -I -E "$secret_re" "$path" 2>/dev/null | head -1 || true)"
  else
    content="$(git diff HEAD --no-color -U0 -- "$path" | grep -E '^\+[^+]' | grep -E "$secret_re" | head -1 || true)"
  fi
  [[ -n "$content" ]] && flag "possible secret in $path"
done <<<"$porcelain"

echo
if (( flags > 0 )); then
  echo "VERDICT: review"
else
  echo "VERDICT: ok"
fi
