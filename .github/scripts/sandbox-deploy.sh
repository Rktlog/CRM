#!/usr/bin/env bash
# Claims, updates or releases the SANDBOX. Called by .github/workflows/deploy-to-sandbox.yml.
# Everything it needs arrives as environment variables (never pasted into the commands).
#
#   claim   (label added, or more commits pushed to a labelled pull request): the sandbox copies this pull request, if nobody else has it.
#   release (labelled pull request closed or merged): the label comes off and the sandbox goes back to the live code (main).
#
# Only ONE pull request can hold the sandbox, and the rule is the same for everybody (the owner too). To take it over, take the label off the other pull request first.
set -euo pipefail
: "${REPO:?}" "${PR:?}" "${ACTION:?}"
LABEL="sandbox"
SANDBOX_URL="${SANDBOX_URL:-https://crm-snowy-ten-25.vercel.app}"
stamp() { TZ=Australia/Melbourne date '+%-d %b, %-I:%M %p Melbourne time'; }
say() { local to="$1" body="$2"; gh pr comment "$to" --repo "$REPO" --edit-last --create-if-none --body "$body" >/dev/null 2>&1 || gh pr comment "$to" --repo "$REPO" --body "$body" >/dev/null; }
holders() { gh pr list --repo "$REPO" --state open --label "$LABEL" --json number --jq '.[].number'; }

case "$ACTION" in
  labeled|synchronize)
    others="$(holders | grep -vx "$PR" || true)"
    if [ -n "$others" ]; then
      first="$(echo "$others" | head -n1)"
      gh pr edit "$PR" --repo "$REPO" --remove-label "$LABEL" >/dev/null
      say "$PR" "The sandbox is in use by pull request #$first, so the label was taken off again. There is one sandbox and it holds one change at a time. Add the label again when #$first has been merged or closed, or when its label has been taken off."
      exit 0
    fi
    git fetch --no-tags origin "+pull/${PR}/head:pr-head"
    sha="$(git rev-parse --short pr-head)"
    git push --force origin pr-head:refs/heads/staging
    say "$PR" "The sandbox now holds this pull request at commit \`$sha\` ($(stamp)). Railway and Vercel need about 3 to 5 minutes to rebuild. Then open $SANDBOX_URL and press Ctrl+F5. Pushing more commits here updates the sandbox by itself. The sandbox is released when this pull request is closed or merged, or when the label is taken off."
    ;;
  closed)
    gh pr edit "$PR" --repo "$REPO" --remove-label "$LABEL" >/dev/null
    git fetch --no-tags origin +refs/heads/main:main-head
    git push --force origin main-head:refs/heads/staging
    say "$PR" "The sandbox has been released and now shows the live code (main) again. Another pull request can use it. ($(stamp))"
    ;;
  *) echo "Nothing to do for: $ACTION"; ;;
esac
