#!/usr/bin/env bash
# Secret scan for this PUBLIC repository. Run before every push: npm run scan:secrets
#  1. gitleaks over git history + staged changes (via Docker if not installed)
#  2. values of sensitive variables in the local .env must not appear in tracked/staged files
#  3. Google credential patterns in tracked/staged files
# Prints file names and value *names* only, never the values.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0

echo "== 1/3 gitleaks"
# Only what git will publish: committed history and the staged index (ignored files like .env are skipped).
has_commits=$(git rev-parse --verify -q HEAD >/dev/null && echo 1 || echo 0)
if command -v gitleaks >/dev/null 2>&1; then
  gl() { gitleaks "$@"; }
elif command -v docker >/dev/null 2>&1; then
  gl() { docker run --rm -v "$PWD:/repo" -w /repo zricethezav/gitleaks:latest "$@"; }
fi
if declare -F gl >/dev/null; then
  [[ $has_commits == 1 ]] && { gl git --redact --no-banner . || fail=1; }
  gl git --staged --redact --no-banner . || fail=1
else
  echo "   gitleaks not available (install it or Docker) — skipping"
fi

files=$( (git ls-files; git diff --cached --name-only; git ls-files --others --exclude-standard) | sort -u | grep -v '^package-lock.json$' || true)

echo "== 2/3 values from .env"
if [[ -f .env ]]; then
  while IFS='=' read -r name value; do
    [[ -z "$name" || "$name" =~ ^# || ${#value} -lt 8 ]] && continue
    [[ "$name" =~ (SECRET|TOKEN|KEY|PASSWORD|CLIENT_ID|CUSTOMER_ID|DOMAIN|PUBLIC_URL) ]] || continue
    value="${value%\"}"; value="${value#\"}"
    for f in $files; do
      [[ -f "$f" ]] || continue
      if grep -qF -- "$value" "$f"; then echo "   LEAK: value of $name found in $f"; fail=1; fi
    done
  done < .env
else
  echo "   no .env here — skipping"
fi

echo "== 3/3 Google credential patterns"
patterns='GOCSPX-[A-Za-z0-9_-]{20,}|1//0[A-Za-z0-9_-]{30,}|ya29\.[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|[0-9]{8,}-[a-z0-9]{32}\.apps\.googleusercontent\.com'
for f in $files; do
  [[ -f "$f" ]] || continue
  if grep -qE -- "$patterns" "$f"; then echo "   PATTERN in $f"; fail=1; fi
done

if [[ $fail -ne 0 ]]; then echo "❌ secret scan FAILED — do not push"; exit 1; fi
echo "✅ secret scan passed"
