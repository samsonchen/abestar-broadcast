#!/usr/bin/env bash
# One-off A/B test of pauses at Chinese punctuation: speaks one passage with full-width punctuation (as sent now),
# half-width punctuation, and half-width with a space after it, all as read-aloud sends them (Flash v2.5, zh,
# speed 1.1 with the voice's stored settings, 32 kbps). Prints the length and the total pause time of each, then
# plays it. About 100 credits per version.
# Usage: scripts/tts-pause-test.sh [voice ID]
set -euo pipefail
command -v ffmpeg >/dev/null || { echo 'ffmpeg is not installed: brew install ffmpeg' >&2; exit 1; }

TEXT='各位弟兄姊妹，大家早安。今天我們要看三段經文：約翰福音、羅馬書、以弗所書。神愛世人，甚至將他的獨生子賜給他們；叫一切信他的，不致滅亡，反得永生！你相信嗎？'
read -rsp 'ElevenLabs API key (hidden): ' KEY </dev/tty
echo
VOICE=${1:-}
[[ -n $VOICE ]] || read -rp 'Voice ID: ' VOICE </dev/tty

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

curl -sS "https://api.elevenlabs.io/v1/voices/$VOICE/settings" -H "xi-api-key: $KEY" >"$OUT/settings"
STORED=$(jq -c 'del(.detail)' "$OUT/settings")

half() { sed -e 's/，/,/g; s/、/,/g; s/。/./g; s/；/;/g; s/：/:/g; s/！/!/g; s/？/?/g'; }

speak() { # label, text
  jq -n --arg text "$2" --argjson s "$STORED" \
    '{text: $text, model_id: "eleven_flash_v2_5", language_code: "zh", voice_settings: ($s + {speed: 1.1})}' >"$OUT/body"
  CODE=$(curl -sS -o "$OUT/clip.mp3" -w '%{http_code}' \
    "https://api.elevenlabs.io/v1/text-to-speech/$VOICE?output_format=mp3_22050_32" \
    -H "xi-api-key: $KEY" -H 'Content-Type: application/json' --data-binary "@$OUT/body")
  if [[ $CODE != 200 ]]; then
    echo "$1: HTTP $CODE $(head -c 200 "$OUT/clip.mp3")"
    return
  fi
  SECS=$(afinfo "$OUT/clip.mp3" | awk '/estimated duration/ {print $3}')
  # Silences of at least 0.15 s, 35 dB below full scale, counted as pauses.
  PAUSE=$(ffmpeg -hide_banner -nostats -i "$OUT/clip.mp3" -af silencedetect=noise=-35dB:d=0.15 -f null - 2>&1 |
    awk '/silence_duration/ {sum += $NF; n++} END {printf "%.1f s in %d pauses", sum, n}')
  printf '%-30s %5.1f s long, %s\n' "$1" "$SECS" "$PAUSE"
  echo "  $2"
  afplay "$OUT/clip.mp3"
}

speak 'A full-width (now)' "$TEXT"
speak 'B half-width' "$(printf %s "$TEXT" | half)"
speak 'C half-width + space' "$(printf %s "$TEXT" | half | sed -e 's/\([,.;:!?]\)/\1 /g; s/ $//')"
