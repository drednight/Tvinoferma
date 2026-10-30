#!/usr/bin/env bash
# Informational audit: preserve cargo's status and make diagnostics visible as a
# check annotation even when GitHub's archived job logs cannot be downloaded.
set -uo pipefail
output=$(mktemp)
trap 'rm -f "$output"' EXIT
cargo audit --file src-tauri/Cargo.lock 2>&1 | tee "$output"
status=${PIPESTATUS[0]}
if ((status != 0)); then
  python3 - "$output" <<'PY'
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8', errors='replace')[-6000:]
text = re.sub(r'\x1b\[[0-9;]*m', '', text)
text = text.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
print('::warning title=Informational Cargo audit::' + text)
PY
fi
exit "$status"
