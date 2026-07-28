#!/usr/bin/env bash
# Auto-deploy hook: commit any working-tree changes and push to the current
# branch. Netlify is connected to this repo, so a push triggers a new deploy.
# Runs on the Claude Code "Stop" event. Safe to run repeatedly — it exits
# quietly when there is nothing to commit.

set -uo pipefail

# Resolve the repo root (CLAUDE_PROJECT_DIR is set when run as a hook).
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}" 2>/dev/null || exit 0

# Nothing changed -> nothing to deploy.
if [ -z "$(git status --porcelain)" ]; then
  exit 0
fi

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"

# Never auto-push a detached HEAD or the default branch by accident.
if [ -z "$branch" ] || [ "$branch" = "HEAD" ]; then
  exit 0
fi

git add -A || exit 0
git commit -q -m "chore: auto-deploy site changes" || exit 0

# Push with a short retry for transient network hiccups.
for i in 1 2 3; do
  if git push -q origin "HEAD:$branch"; then
    echo "{\"systemMessage\": \"Auto-deployed: pushed to $branch (Netlify will redeploy).\"}"
    exit 0
  fi
  sleep $((i * 2))
done

echo "{\"systemMessage\": \"Auto-deploy: commit created but push failed — push $branch manually.\"}"
exit 0
