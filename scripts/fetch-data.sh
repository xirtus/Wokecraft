#!/usr/bin/env bash
# Generate the 100% original XIRTUS-owned Celandia game data (`WoW/Data/`) via
# `scripts/build-celandia-data.mjs`. Owned by XIRTUS.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/WoW/Data"

if [ -f "$DATA/DBFilesClient/Spell.dbc" ] && [ -f "$DATA/World/Maps/Celandia/Celandia.wdt" ]; then
    echo "XIRTUS Celandia game data already present at $DATA"
    echo "  --data $DATA"
    exit 0
fi

echo "Building XIRTUS Celandia game data into ${DATA}…"
node "$ROOT/scripts/build-celandia-data.mjs"

echo "XIRTUS Celandia game data ready at $DATA"
echo "  --data $DATA"
