#!/bin/sh
# watch-loop.sh — auto-re-arming supervisor for watch.js.
#
# watch.js is a one-shot edge detector: it exits the moment the board changes (so a
# turn-based agent can react), which means SOMETHING has to re-arm it after every fire.
# When many independent sessions each watch the board, a single missed re-arm silently
# blinds that session to all future changes — no error, it just stops waking.
#
# This loop decouples "watcher alive" from "agent attentive": it relaunches watch.js
# after each exit and appends every fire to a wake log the agent tails on its turn,
# instead of the agent having to relaunch the watcher itself. watch.js is gap-safe
# (it reloads its persisted baseline), so the instant re-arm catches anything that
# landed during the restart.
#
#   ./watch-loop.sh <project> [watch.js args...]
#   ./watch-loop.sh metronaut-v2 --ignore-actor pm-m1
#
# Env:
#   WAKE     wake-log path (default ~/.clambake_wake_<project>.log). Tail it each turn;
#            its last "re-arming" line (UTC) doubles as the supervisor's own liveness
#            signal — if it's older than ~2x your heartbeat, the supervisor itself died.
#   MIN_GAP  floor seconds between relaunches (default 1) — stops a watcher that
#            crash-exits instantly from spinning the loop hot.
#
# Detach from the turn it was launched in by backgrounding with stdin closed:
#   nohup ./watch-loop.sh metronaut-v2 --ignore-actor pm-m1 >/dev/null 2>&1 &
set -u

project="${1:-}"
if [ -z "$project" ]; then
  echo "usage: ./watch-loop.sh <project> [watch.js args...]" >&2
  exit 1
fi
shift

here="$(cd "$(dirname "$0")" && pwd)"
WAKE="${WAKE:-$HOME/.clambake_wake_${project}.log}"
MIN_GAP="${MIN_GAP:-1}"

echo "[$(date -u +%FT%TZ)] supervisor up: project=$project wake=$WAKE" >> "$WAKE"
while true; do
  # stdin from /dev/null so the watcher doesn't die when a parent's stdin closes.
  node "$here/watch.js" "$project" "$@" < /dev/null >> "$WAKE" 2>&1
  echo "[$(date -u +%FT%TZ)] watcher exited $?; re-arming" >> "$WAKE"
  sleep "$MIN_GAP"
done
