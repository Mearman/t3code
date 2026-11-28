#!/usr/bin/env bash
# Usage: check-apk-signer.sh <sha256-hex> < `apksigner verify --print-certs` output
# Succeeds only when the output has at least one signer digest line and every one carries the
# pinned digest. Accepts "Signer #1 certificate ..." and "V3.0 Signer: certificate ..." forms.
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "usage: $0 <sha256-hex>" >&2
  exit 2
fi

awk -v pin="$1" '
  /^(V[0-9]+(\.[0-9]+)? )?Signer( #[0-9]+)?:? certificate SHA-256 digest: [0-9A-Fa-f]+$/ {
    seen++
    if ($NF != pin) other++
  }
  END { exit (seen > 0 && other == 0) ? 0 : 1 }
'
