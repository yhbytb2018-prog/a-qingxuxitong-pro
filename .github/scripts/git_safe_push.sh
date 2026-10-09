#!/usr/bin/env bash
set -euo pipefail

BRANCH="${1:-${GITHUB_REF_NAME:-main}}"
MAX_RETRIES="${2:-3}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git repository." >&2
  exit 1
fi

for attempt in $(seq 1 "$MAX_RETRIES"); do
  echo "Push attempt $attempt/$MAX_RETRIES to origin/$BRANCH"
  if git push origin "HEAD:$BRANCH"; then
    echo "Push succeeded."
    exit 0
  fi

  echo "Push rejected; fetching remote branch and rebasing local commit(s)"
  git fetch origin "$BRANCH" --prune

  if git rebase "origin/$BRANCH"; then
    echo "Rebase succeeded; retrying push."
    sleep 2
    continue
  fi

  git rebase --abort || true
  echo "Rebase failed due to conflicts. Please resolve the branch state and retry." >&2
  exit 1
done

echo "Push failed after $MAX_RETRIES attempts." >&2
exit 1
