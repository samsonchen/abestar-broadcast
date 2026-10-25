#!/usr/bin/env bash
# Replaces the ElevenLabs API key and/or the voice IDs of the hosted project, without re-running the full setup
# (docs/elevenlabs-setup.md §7). Each language has a female and a male voice; Chinese (zh) serves both Traditional
# (zh-TW) and Simplified (zh-CN). Enter keeps the current value; `off` switches a voice off. New voices are tried with
# ElevenLabs before anything is saved (about 100 credits each). No redeploy is needed: the Edge Function reads the
# key and the database the voice on every line, so the change applies from the next spoken line, even mid-broadcast.
#
# Prerequisites: `supabase login`, and scripts/supabase-setup.sh --tts run once.
# Usage: scripts/tts-update.sh
# Runs on macOS's bash 3.2: no associative arrays.
set -euo pipefail
trap 'printf "\033[31mFailed at line %s:\033[0m %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
cd "$(dirname "$0")/.."

NAME=abestar-broadcast
LANGS='en zh'
lang_name() { case $1 in en) echo 'English' ;; zh) echo 'Chinese (Traditional and Simplified)' ;; esac; }
# A new voice's speaking rate (docs/tts-plan.md §6); Chinese voices read slower than their previews. null keeps the
# voice's stored setting. A replaced voice keeps the speed already set for its language.
speed() { case $1 in zh) echo 1.1 ;; *) echo null ;; esac; }
sample() { case $1 in en) echo 'This is the new read-aloud voice.' ;; zh) echo '這是新的朗讀聲音。' ;; esac; }

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "$1 is not installed. $2"; }
sbjson() { supabase --agent no --output-format json "$@"; }

need supabase 'Install it with: brew install supabase/tap/supabase'
need jq 'Install it with: brew install jq'
need curl ''

say "Looking for project \"$NAME\""
REF=$(sbjson projects list 2>/dev/null | jq -r --arg n "$NAME" '.projects[] | select(.name == $n) | .ref' | head -1) ||
  die 'Not logged in. Run `supabase login` in a normal Terminal window first.'
[[ -n $REF ]] || die "No project named $NAME; run scripts/supabase-setup.sh --tts first."
query() { supabase --agent no db query --linked --project-ref "$REF" "$1"; }
show_voices() { query "select lang, voice, voice_id, speed, enabled from private.tts_voices order by lang, voice"; }

say 'Current voices'
show_voices

echo
read -rsp 'New ElevenLabs API key (hidden; Enter keeps the current one): ' XI_KEY </dev/tty
echo
[[ -z $XI_KEY || $XI_KEY == sk_* ]] || echo 'Note: ElevenLabs keys usually start with sk_.'

# One line per change: "<lang> <female|male> <voice ID|off>".
CHANGES=''
for LANG_CODE in $LANGS; do
  echo
  echo "$(lang_name "$LANG_CODE") voices (Enter keeps the current one, off switches it off):"
  for KIND in female male; do
    read -rp "  $KIND voice ID: " V </dev/tty
    [[ -z $V ]] && continue
    [[ $V == off || $V =~ ^[A-Za-z0-9]+$ ]] || die "Not a voice ID: $V (copy it from the voice's ID button)"
    CHANGES="$CHANGES$LANG_CODE $KIND $V"$'\n'
  done
done
NEW_VOICES=$(printf %s "$CHANGES" | awk '$3 != "off"')
[[ -n $XI_KEY$CHANGES ]] || { echo 'Nothing to change.'; exit 0; }

# The stored key cannot be read back, so new voices alone are tried with a key typed here.
TEST_KEY=$XI_KEY
if [[ -z $TEST_KEY && -n $NEW_VOICES ]]; then
  read -rsp 'API key to try the new voices with (hidden; Enter skips the try): ' TEST_KEY </dev/tty
  echo
fi

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
if [[ -n $TEST_KEY ]]; then
  say 'Trying with ElevenLabs'
  CODE=$(curl -sS -o "$OUT/sub" -w '%{http_code}' https://api.elevenlabs.io/v1/user/subscription -H "xi-api-key: $TEST_KEY")
  case $CODE in
    200) echo "  Key OK: $(jq -r '"\(.character_limit - .character_count) of \(.character_limit) credits left, tier \(.tier)"' "$OUT/sub")" ;;
    401) grep -q missing_permissions "$OUT/sub" &&
      die 'The key lacks the User → Read permission (the extension shows the balance with it). Edit the key at elevenlabs.io and re-run.'
      die "Key refused: $(head -c 300 "$OUT/sub")" ;;
    *) die "Key check failed: HTTP $CODE $(head -c 300 "$OUT/sub")" ;;
  esac
  while read -r LANG_CODE KIND VOICE; do
    [[ -n $VOICE ]] || continue
    jq -n --arg text "$(sample "$LANG_CODE")" --arg lang "$LANG_CODE" \
      '{text: $text, model_id: "eleven_flash_v2_5", language_code: $lang}' >"$OUT/body"
    CODE=$(curl -sS -o "$OUT/speech" -w '%{http_code}' \
      "https://api.elevenlabs.io/v1/text-to-speech/$VOICE?output_format=mp3_44100_64" \
      -H "xi-api-key: $TEST_KEY" -H 'Content-Type: application/json' --data-binary "@$OUT/body")
    [[ $CODE == 200 ]] || die "$LANG_CODE $KIND voice $VOICE refused: HTTP $CODE $(head -c 300 "$OUT/speech") (nothing was changed)"
    echo "  $(lang_name "$LANG_CODE"), $KIND: $VOICE OK, playing…"
    afplay "$OUT/speech" 2>/dev/null || true
  done <<<"$NEW_VOICES"
else
  [[ -z $NEW_VOICES ]] || echo 'Not tried; scripts/elevenlabs-test.sh can try them later.'
fi
unset TEST_KEY

if [[ -n $XI_KEY ]]; then
  say 'Saving the API key'
  printf 'ELEVENLABS_API_KEY=%s\n' "$XI_KEY" >"$OUT/env"
  supabase --agent no secrets set --project-ref "$REF" --env-file "$OUT/env" >/dev/null
  rm -f "$OUT/env"
  unset XI_KEY
  echo '  Saved. Delete the old key at elevenlabs.io → Developers → API Keys once read-aloud works.'
fi

if [[ -n $CHANGES ]]; then
  say 'Saving the voices'
  while read -r LANG_CODE KIND VOICE; do
    [[ -n $VOICE ]] || continue
    if [[ $VOICE == off ]]; then
      query "update private.tts_voices set enabled = false where lang = '$LANG_CODE' and voice = '$KIND'" >/dev/null
    else
      query "insert into private.tts_voices (lang, voice, voice_id, language_code, speed)
        values ('$LANG_CODE', '$KIND', '$VOICE', '$LANG_CODE', $(speed "$LANG_CODE"))
        on conflict (lang, voice) do update set voice_id = excluded.voice_id, enabled = true" >/dev/null
    fi
  done <<<"$CHANGES"
  show_voices
  # Re-runs the language check of a live broadcast, so its viewers' read-aloud button follows the change now.
  query "update public.sessions set tts_voice = tts_voice where status = 'live'" >/dev/null
fi

say 'Done. The next spoken line uses the change; check the balance in the extension popup.'
