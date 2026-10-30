#!/usr/bin/env bash
# Fails a pull request that ADDS a file or a line that looks like a secret.
# Usage: check-no-secrets.sh <base-ref>        e.g. origin/main
# It never prints the secret itself: only the file, the line number and the first few characters.
set -euo pipefail
base="${1:-origin/main}"
range="$base...HEAD"
bad=0

# 1. files that should never be committed
while IFS= read -r f; do
  case "$f" in
    *.example|*.sample|*.template) ;;
    .env|*/.env|.env.*|*/.env.*) echo "FILE   $f is an environment file. Put secrets in Railway, Vercel or Supabase, never in git."; bad=1 ;;
    *.pem|*.key|*.p12|*service-account*.json|*credentials*.json) echo "FILE   $f looks like a key or credentials file."; bad=1 ;;
  esac
done < <(git diff --name-only --diff-filter=AM "$range")

# 2. added lines that look like secrets (placeholders such as YOUR-PASSWORD are allowed)
pattern='(sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(ql)?://[^[:space:]:@/]+:[^[:space:]@/]{6,}@[^[:space:]]+|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})'
placeholder='YOUR-|YOUR_|<[A-Za-z_-]+>|example\.(com|org)|placeholder|xxxx|\$\{|%s'
current=""
while IFS= read -r line; do
  case "$line" in
    "+++ b/"*) current="${line#+++ b/}" ;;
    "+++ "*|"--- "*|"@@ "*) ;;
    "+"*)
      text="${line#+}"
      if echo "$text" | grep -Eq "$pattern" && ! echo "$text" | grep -Eiq "$placeholder"; then
        hit="$(echo "$text" | grep -Eo "$pattern" | head -1)"
        echo "LINE   $current: looks like a secret (starts ${hit:0:10}...)"; bad=1
      fi ;;
  esac
done < <(git diff -U0 --diff-filter=AM "$range" -- . ':(exclude)package-lock.json' ':(exclude)*/package-lock.json' ':(exclude).github/scripts/check-no-secrets.sh')

if [ "$bad" -ne 0 ]; then
  echo
  echo "This change adds something that looks like a secret. Remove it, and if it was real, change that secret now: anything pushed to GitHub should be treated as exposed."
  exit 1
fi
echo "No secrets found in this change."
