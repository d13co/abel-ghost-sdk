#!/bin/sh
# Creates or updates the `npm` environment that dt.yml's publish job runs in (and npm's trusted publisher names):
#   - each release waits for a required reviewer to approve it on GitHub before anything is published
#   - self-review is allowed, since the reviewer is usually the one who pushed the tag
#   - only v*-dt.* tags can deploy to it
# Needs gh, logged in as a repository admin. The reviewer must have access to the repository.
# Usage: scripts/ci/apply-npm-environment.sh [owner/repo, default d13co/abel-ghost-sdk] [reviewer login, default you]
set -eu
repo=${1:-d13co/abel-ghost-sdk}
reviewer=${2:-$(gh api user --jq .login)}
reviewer_id=$(gh api "users/$reviewer" --jq .id)

gh api --method PUT "repos/$repo/environments/npm" --input - --jq '"environment \(.name): reviewers \([.protection_rules[] | select(.type == "required_reviewers") | .reviewers[].reviewer.login] | join(", "))"' <<EOF
{
  "reviewers": [{ "type": "User", "id": $reviewer_id }],
  "prevent_self_review": false,
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
EOF

policies=$(gh api "repos/$repo/environments/npm/deployment-branch-policies" --jq '.branch_policies[] | "\(.type) \(.name)"')
if printf '%s\n' "$policies" | grep -qx 'tag v\*-dt\.\*'; then
  echo "deployment policy: tag v*-dt.* (exists)"
else
  gh api --method POST "repos/$repo/environments/npm/deployment-branch-policies" \
    -f name='v*-dt.*' -f type=tag --jq '"deployment policy: \(.type) \(.name) (created)"'
fi
