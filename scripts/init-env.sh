#!/usr/bin/env bash
# Creates .env from .env.example with freshly generated secrets.
# Safe to run any time: it never overwrites an existing .env.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -e .env ]; then
  echo ".env already exists, leaving it alone."
  exit 0
fi

command -v openssl >/dev/null || { echo "openssl is required to generate secrets" >&2; exit 1; }
api_key=$(openssl rand -hex 32)
db_password=$(openssl rand -hex 16)

# Replace the two placeholder values in .env.example.
sed -e "s/replace-with-output-of-openssl-rand-hex-32/${api_key}/" \
    -e "s/replace-with-a-password-you-choose/${db_password}/g" .env.example > .env
chmod 600 .env
echo "Created .env with a new API key and database password."
