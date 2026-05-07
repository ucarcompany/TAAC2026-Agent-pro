#!/usr/bin/env bash
set -euo pipefail

# Example entrypoint only. Keep the real command owned by your project.
# Taiji template Jobs can keep this file stable while each experiment replaces
# code.zip and config.yaml.

CONFIG_PATH="${CONFIG_PATH:-config.yaml}"
CODE_DIR="${CODE_DIR:-code}"

if [ -f code.zip ] && [ ! -d "$CODE_DIR" ]; then
  python3 - <<'PY'
from pathlib import Path
from zipfile import ZipFile

target = Path("code")
target.mkdir(parents=True, exist_ok=True)
with ZipFile("code.zip") as archive:
    archive.extractall(target)
PY
fi

echo "Running training with config: ${CONFIG_PATH}"
echo "Replace this placeholder command with your project entrypoint."
python3 "${CODE_DIR}/train.py" --config "${CONFIG_PATH}"
