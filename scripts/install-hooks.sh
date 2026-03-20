#!/bin/sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
for hook in "$SCRIPT_DIR/hooks"/*; do
  dst="$SCRIPT_DIR/../.git/hooks/$(basename "$hook")"
  cp "$hook" "$dst" && chmod +x "$dst"
  echo "Installed: .git/hooks/$(basename "$hook")"
done
