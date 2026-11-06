#!/bin/sh
# Creates the repository rulesets in .github/rulesets/, or updates the ones that exist (matched by name):
#   dtalgorand           changes land on dtalgorand through merged pull requests that pass the Test check, never by
#                        force push; repository admins can bypass it
#   dtalgorand deletion  dtalgorand can't be deleted
#   release tags         v*-dt.* tags can't be moved or deleted
#   main                 changes land on main through merged pull requests, never by force push; repository admins
#                        can bypass it (main has no CI, so no check is required)
#   main deletion        main can't be deleted
# Needs gh, logged in as a repository admin.
# Usage: scripts/ci/apply-rulesets.sh [owner/repo, default d13co/abel-ghost-sdk]
set -eu
repo=${1:-d13co/abel-ghost-sdk}
dir=$(dirname "$0")/../../.github/rulesets
for file in "$dir"/*.json; do
  name=$(node -p "require(process.argv[1]).name" "$(realpath "$file")")
  id=$(gh api "repos/$repo/rulesets" --paginate --jq ".[] | select(.name == \"$name\") | .id")
  if [ -n "$id" ]; then
    gh api --method PUT "repos/$repo/rulesets/$id" --input "$file" --jq '"updated \(.name) (\(.id))"'
  else
    gh api --method POST "repos/$repo/rulesets" --input "$file" --jq '"created \(.name) (\(.id))"'
  fi
done
