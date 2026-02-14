#!/usr/bin/env bash
# sync-vercel-env.sh
# Deletes all existing Vercel env vars and re-uploads from a local .env file.
#
# Usage:
#   ./sync-vercel-env.sh              # defaults to .env
#   ./sync-vercel-env.sh frontend/.env
#   ./sync-vercel-env.sh .env production

set -euo pipefail

ENV_FILE="${1:-.env}"
ENVIRONMENT="${2:-production}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: env file '$ENV_FILE' not found."
  exit 1
fi

echo ">>> Syncing '$ENV_FILE' to Vercel ($ENVIRONMENT)"
echo ""

# ── 1. Delete all existing env vars ──────────────────────────────────────────
echo "Step 1: Removing existing Vercel env vars..."

EXISTING=$(vercel env ls 2>/dev/null | tail -n +3 | awk '{print $1}' | grep -v '^$' || true)

if [[ -z "$EXISTING" ]]; then
  echo "  (no existing vars found)"
else
  while IFS= read -r key; do
    echo "  Removing: $key"
    vercel env rm "$key" "$ENVIRONMENT" -y 2>/dev/null || true
  done <<< "$EXISTING"
fi

echo ""

# ── 2. Upload from .env file ──────────────────────────────────────────────────
echo "Step 2: Uploading vars from '$ENV_FILE'..."

while IFS='=' read -r key value; do
  # Skip comments and blank lines
  [[ "$key" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${key// }" ]] && continue

  # Strip inline comments
  value="${value%%#*}"

  # Strip surrounding whitespace
  key="${key// /}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"

  # Strip surrounding quotes
  value="${value%\"}" && value="${value#\"}"
  value="${value%\'}" && value="${value#\'}"

  echo "  Adding: $key"
  echo "$value" | vercel env add "$key" "$ENVIRONMENT"
done < "$ENV_FILE"

echo ""
echo "Done. All vars from '$ENV_FILE' have been synced to Vercel ($ENVIRONMENT)."
