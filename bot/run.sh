#!/bin/sh
# Keeps the bot alive across disconnects and watchdog restarts.
# First run: BOT_NONCE=<code> ./run.sh   (the bot saves its own token afterwards)
cd "$(dirname "$0")"
while true; do
  BOT_NAME="${BOT_NAME:-Primey}" BOT_AB="${BOT_AB:-}" npm start
  echo "[run.sh] exited with $?; restarting in 2 s"
  sleep 2
done
