#!/usr/bin/env bash
# Tests an ElevenLabs API key and voice ID with the same request the Edge Function `tts` sends, then shows the
# account balance (docs/elevenlabs-setup.md §4). Spends about 100 credits. The key is read from the terminal, never
# from arguments, so it stays out of shell history.
#
# Usage: scripts/elevenlabs-test.sh [voice-id …]
set -euo pipefail

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

read -rsp 'ElevenLabs API key (hidden): ' XI_KEY </dev/tty
echo
[[ $XI_KEY == sk_* ]] || echo 'Note: ElevenLabs keys usually start with sk_.'

VOICES=("$@")
if [[ ${#VOICES[@]} == 0 ]]; then
  read -rp 'Voice ID: ' VOICE </dev/tty
  VOICES=("$VOICE")
fi

for VOICE in "${VOICES[@]}"; do
  if [[ ! $VOICE =~ ^[A-Za-z0-9]+$ ]]; then
    echo "Voice ID '$VOICE': letters and digits only (copy it from the voice's ID button)."
    continue
  fi
  CODE=$(curl -sS -o "$OUT/speech" -w '%{http_code}' \
    "https://api.elevenlabs.io/v1/text-to-speech/$VOICE?output_format=mp3_44100_64" \
    -H "xi-api-key: $XI_KEY" -H 'Content-Type: application/json' \
    -d '{"text":"The nine-in-one elections will be held on November 28th.","model_id":"eleven_flash_v2_5","language_code":"en"}')
  if [[ $CODE == 200 ]]; then
    echo "Voice $VOICE: OK (HTTP 200), playing…"
    afplay "$OUT/speech" 2>/dev/null || echo "(saved MP3 could not be played: $(file -b "$OUT/speech"))"
  else
    echo "Voice $VOICE: HTTP $CODE — $(head -c 400 "$OUT/speech")"
  fi
done

CODE=$(curl -sS -o "$OUT/sub" -w '%{http_code}' https://api.elevenlabs.io/v1/user/subscription \
  -H "xi-api-key: $XI_KEY")
if [[ $CODE == 200 ]]; then
  echo "Balance (account): $(jq -r '"\(.character_limit - .character_count) of \(.character_limit) credits left, tier \(.tier)"' "$OUT/sub")"
else
  echo "Balance: HTTP $CODE — $(head -c 400 "$OUT/sub")"
  grep -q missing_permissions "$OUT/sub" && echo 'The key needs the User permission for the balance.'
  true
fi
unset XI_KEY
