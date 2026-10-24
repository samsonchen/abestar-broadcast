#!/usr/bin/env bash
# Replaces the ElevenLabs API key and/or the voice IDs of the hosted project, without re-running the full setup
# (docs/elevenlabs-setup.md §7). Enter keeps the current value. New voices are tried with ElevenLabs before they are
# saved (about 100 credits each). No redeploy is needed: the Edge Function reads the key and the database the voice on
# every line, so the change applies from the next spoken line, even during a broadcast.
#
# Prerequisites: `supabase login`, and scripts/supabase-setup.sh --tts run once.
# Usage: scripts/tts-update.sh
# Runs on macOS's bash 3.2.
set -euo pipefail
trap 'printf "\033[31mFailed at line %s:\033[0m %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
cd "$(dirname "$0")/.."

NAME=abestar-broadcast
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
query() { supabase --agent no db query --project-ref "$REF" "$1"; }

say 'Current voices'
query "select voice, voice_id, enabled from private.tts_voices where lang = 'en' order by voice"

echo
read -rsp 'New ElevenLabs API key (hidden; Enter keeps the current one): ' XI_KEY </dev/tty
echo
[[ -z $XI_KEY || $XI_KEY == sk_* ]] || echo 'Note: ElevenLabs keys usually start with sk_.'
read -rp 'New female voice ID (Enter keeps the current one): ' VOICE_FEMALE </dev/tty
read -rp 'New male voice ID (Enter keeps the current one): ' VOICE_MALE </dev/tty
for v in "$VOICE_FEMALE" "$VOICE_MALE"; do
  [[ -z $v || $v =~ ^[A-Za-z0-9]+$ ]] || die "Not a voice ID: $v (copy it from the voice's ID button)"
done
[[ -n $XI_KEY$VOICE_FEMALE$VOICE_MALE ]] || { echo 'Nothing to change.'; exit 0; }

# The stored key cannot be read back, so new voices alone are tried with a key typed here.
TEST_KEY=$XI_KEY
if [[ -z $TEST_KEY && -n $VOICE_FEMALE$VOICE_MALE ]]; then
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
  for VOICE in $VOICE_FEMALE $VOICE_MALE; do
    CODE=$(curl -sS -o "$OUT/speech" -w '%{http_code}' \
      "https://api.elevenlabs.io/v1/text-to-speech/$VOICE?output_format=mp3_22050_32" \
      -H "xi-api-key: $TEST_KEY" -H 'Content-Type: application/json' \
      -d '{"text":"This is the new read-aloud voice.","model_id":"eleven_flash_v2_5","language_code":"en"}')
    [[ $CODE == 200 ]] || die "Voice $VOICE refused: HTTP $CODE $(head -c 300 "$OUT/speech") (nothing was changed)"
    echo "  Voice $VOICE OK, playing…"
    afplay "$OUT/speech" 2>/dev/null || true
  done
else
  echo 'Not tried; scripts/elevenlabs-test.sh can try them later.'
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

set_voice() {
  [[ -z $2 ]] && return
  query "insert into private.tts_voices (lang, voice, voice_id, language_code)
    values ('en', '$1', '$2', 'en')
    on conflict (lang, voice) do update set voice_id = excluded.voice_id, enabled = true" >/dev/null
}
if [[ -n $VOICE_FEMALE$VOICE_MALE ]]; then
  say 'Saving the voices'
  set_voice female "$VOICE_FEMALE"
  set_voice male "$VOICE_MALE"
  query "select voice, voice_id, enabled from private.tts_voices where lang = 'en' order by voice"
fi

say 'Done. The next spoken line uses the change; check the balance in the extension popup.'
