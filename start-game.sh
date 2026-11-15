#!/usr/bin/env bash
# Avvia tutto il gioco con un comando (macOS / Linux). Doppio clic o ./start-game.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js non trovato. Installa la versione LTS da https://nodejs.org e riprova."; exit 1
fi
exec node scripts/launch.mjs "$@"
