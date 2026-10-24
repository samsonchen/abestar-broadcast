#!/usr/bin/env bash
# Sets up the hosted Supabase project for abestar-broadcast (PLAN.md §6.6). Safe to re-run.
#
# Prerequisites: a Supabase account and `supabase login` (run it in a normal Terminal window).
#
# Usage: scripts/supabase-setup.sh [--new-token] [--tts] [--yes]
#   --new-token  replace the broadcast token (e.g. after a leak); the old one stops working
#   --tts        also set up read-aloud: ElevenLabs key, voices, Edge Function (docs/elevenlabs-setup.md)
#   --yes        apply auth config changes without asking
#
# Environment: SUPABASE_DB_PASSWORD   database password of an existing project (asked for if unset)
# Runs on macOS's bash 3.2: no empty arrays under `set -u`, no bash 4 features.
set -euo pipefail
trap 'printf "\033[31mFailed at line %s:\033[0m %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
cd "$(dirname "$0")/.."

NAME=abestar-broadcast
REGION=us-west-2
NEW_TOKEN=false
TTS=false
ASSUME_YES=false
for arg in "$@"; do
  case $arg in
    --new-token) NEW_TOKEN=true ;;
    --tts) TTS=true ;;
    --yes) ASSUME_YES=true ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
confirm() {
  [[ $ASSUME_YES == true ]] && return 0
  read -rp "$1 [y/N] " answer
  [[ $answer == y || $answer == Y ]]
}
need() { command -v "$1" >/dev/null || die "$1 is not installed. $2"; }
sb() { supabase --agent no "$@"; }
sbjson() { supabase --agent no --output-format json "$@"; }

need supabase 'Install it with: brew install supabase/tap/supabase'
need jq 'Install it with: brew install jq'
need openssl ''
need curl ''

say 'Checking Supabase login'
ORGS_JSON=$(sbjson orgs list 2>/dev/null) || die 'Not logged in. Run `supabase login` in a normal Terminal window first.'

# ---------------------------------------------------------------- 1. project
say "Looking for project \"$NAME\""
REF=$(sbjson projects list 2>/dev/null | jq -r --arg n "$NAME" '.projects[] | select(.name == $n) | .ref' | head -1)

if [[ -z $REF ]]; then
  ORGS=$(jq -r '.organizations[] | "\(.id)\t\(.name)"' <<<"$ORGS_JSON")
  [[ -n $ORGS ]] || die 'Your account has no organization. Create one at https://supabase.com/dashboard first.'
  if [[ $(wc -l <<<"$ORGS") -eq 1 ]]; then
    ORG=$(cut -f1 <<<"$ORGS")
  else
    echo "$ORGS" | nl
    read -rp 'Which organization (number)? ' n
    ORG=$(sed -n "${n}p" <<<"$ORGS" | cut -f1)
  fi
  SUPABASE_DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')
  say "Creating project $NAME in $REGION (organization $ORG)"
  sb projects create "$NAME" --org-id "$ORG" --region "$REGION" --db-password "$SUPABASE_DB_PASSWORD" >/dev/null
  printf '\n\033[33mDatabase password (save it in your password manager now; it is not stored anywhere):\033[0m\n  %s\n' "$SUPABASE_DB_PASSWORD"
  read -rp 'Press Enter once it is saved... '
  REF=$(sbjson projects list | jq -r --arg n "$NAME" '.projects[] | select(.name == $n) | .ref' | head -1)
else
  echo "Found project $REF."
  if [[ -z ${SUPABASE_DB_PASSWORD:-} ]]; then
    read -rsp 'Database password of this project: ' SUPABASE_DB_PASSWORD
    echo
  fi
fi
export SUPABASE_DB_PASSWORD

say 'Waiting for the project to be ready'
for _ in $(seq 1 60); do
  STATUS=$(sbjson projects list | jq -r --arg r "$REF" '.projects[] | select(.ref == $r) | .status')
  [[ $STATUS == ACTIVE_HEALTHY ]] && break
  [[ $STATUS == INACTIVE ]] && die 'The project is paused. Restore it in the dashboard (Project → Restore), then re-run.'
  printf '  status: %s\n' "$STATUS"
  sleep 10
done
[[ $STATUS == ACTIVE_HEALTHY ]] || die "Project is still $STATUS after 10 minutes; re-run later."

# ---------------------------------------------------------------- 2. schema and config
say 'Linking and pushing the database schema'
sb link --project-ref "$REF"
sb db push --linked

say 'Pushing auth settings from supabase/config.toml'
sb config diff --project-ref "$REF" | grep -E '\[update\]|\[remote-only\]|differences found' || true
if confirm 'Apply these auth settings?'; then
  sb config push --project-ref "$REF" --yes
else
  die 'Auth settings not applied; viewers cannot sign in without them. Re-run and answer y.'
fi

# ---------------------------------------------------------------- 3. broadcast token
query() { sb db query --linked "$1"; }
HAS_TOKEN=$(query "select case when exists (select 1 from private.broadcast_token) then 'token:yes' else 'token:no' end as t" | grep -o 'token:[a-z]*' | head -1)
if [[ $HAS_TOKEN == token:no || $NEW_TOKEN == true ]]; then
  say 'Creating the broadcast token'
  TOKEN=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
  # Only the hash leaves this machine.
  HASH=$(printf %s "$TOKEN" | openssl dgst -sha256 -r | cut -d' ' -f1)
  query "insert into private.broadcast_token (token_hash) values ('$HASH') on conflict (id) do update set token_hash = excluded.token_hash" >/dev/null
  printf '\n\033[33mBroadcast token (save it in your password manager; paste it into the extension options):\033[0m\n  %s\n' "$TOKEN"
  read -rp 'Press Enter once it is saved... '
else
  echo 'A broadcast token already exists; keeping it (use --new-token to replace it).'
fi

# ---------------------------------------------------------------- 4. public config
say 'Writing shared/public-config.json'
URL="https://$REF.supabase.co"
KEY=$(sbjson projects api-keys --project-ref "$REF" | jq -r '[.. | strings | select(startswith("sb_publishable_"))][0] // empty')
[[ -n $KEY ]] || die 'No publishable key found. Create one in the dashboard (Project Settings → API Keys) and re-run.'
jq -n --arg url "$URL" --arg key "$KEY" --arg viewer 'https://samsonchen.github.io/abestar-broadcast/' \
  '{supabaseUrl: $url, publishableKey: $key, viewerUrl: $viewer}' >shared/public-config.json
cat shared/public-config.json

# ---------------------------------------------------------------- 5. verify
say 'Verifying'
FAIL=0
check() { if [[ $2 == "$3" ]]; then echo "  PASS  $1"; else echo "  FAIL  $1 (expected $3, got $2)"; FAIL=1; fi; }
http() { curl -s -o /dev/null -w '%{http_code}' -H "apikey: $KEY" -H 'Content-Type: application/json' "$@"; }

check 'not signed in cannot read sessions' "$(http "$URL/rest/v1/sessions")" 401
check 'wrong token cannot start a session' \
  "$(http -X POST "$URL/rest/v1/rpc/start_session" -d '{"p_token":"wrong","p_title":"x"}')" 401
check 'anonymous sign-in works' "$(http -X POST "$URL/auth/v1/signup" -d '{}')" 200
check 'email sign-up is disabled' \
  "$(http -X POST "$URL/auth/v1/signup" -d '{"email":"setup-check@example.com","password":"Xx-123456789"}')" 400
check 'realtime publishes segments and sessions' \
  "$(query "select count(*) || ' tables' as n from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('segments', 'sessions')" | grep -o '[0-9]* tables' | head -1)" '2 tables'
check 'scheduled jobs auto-end, prune and tts-flush' \
  "$(query "select 'jobs:' || count(*) as n from cron.job where jobname in ('auto-end-idle-sessions', 'prune', 'tts-flush')" | grep -o 'jobs:[0-9]*' | head -1)" 'jobs:3'

# ---------------------------------------------------------------- 6. read-aloud (--tts)
if [[ $TTS == true ]]; then
  say 'Setting up read-aloud (ElevenLabs)'
  # Secret names, whatever the shape of the CLI's JSON.
  secret_names() { sbjson secrets list --project-ref "$REF" | jq -r '[.. | objects | select(has("name")) | .name]'; }
  HAS_KEY=$(secret_names | jq -r 'index("ELEVENLABS_API_KEY") != null')
  read -rsp "ElevenLabs API key$([[ $HAS_KEY == true ]] && echo ' (Enter keeps the current one)'): " XI_KEY
  echo
  [[ -n $XI_KEY || $HAS_KEY == true ]] || die 'An ElevenLabs API key is needed; see docs/elevenlabs-setup.md §2.'
  read -rp 'Female voice ID (Enter keeps the current one): ' VOICE_FEMALE
  read -rp 'Male voice ID (Enter keeps the current one): ' VOICE_MALE
  for v in "$VOICE_FEMALE" "$VOICE_MALE"; do
    [[ -z $v || $v =~ ^[A-Za-z0-9]+$ ]] || die "Not a voice ID: $v"
  done

  # A fresh shared secret for the database → function calls; nobody needs to see it.
  FN_SECRET=$(openssl rand -hex 32)
  ENV_FILE=$(mktemp)
  trap 'rm -f "$ENV_FILE"' EXIT
  {
    echo "TTS_FUNCTION_SECRET=$FN_SECRET"
    echo "PUBLISHABLE_KEY=$KEY"
    [[ -z $XI_KEY ]] || echo "ELEVENLABS_API_KEY=$XI_KEY"
  } >"$ENV_FILE"
  sb secrets set --project-ref "$REF" --env-file "$ENV_FILE" >/dev/null
  rm -f "$ENV_FILE"
  unset XI_KEY

  say 'Deploying the Edge Functions tts and tts-credits'
  sb functions deploy tts --project-ref "$REF" --no-verify-jwt --use-api
  sb functions deploy tts-credits --project-ref "$REF" --no-verify-jwt --use-api

  query "delete from vault.secrets where name = 'tts_function_secret';
    select vault.create_secret('$FN_SECRET', 'tts_function_secret');" >/dev/null
  unset FN_SECRET
  [[ -z $VOICE_FEMALE ]] || query "insert into private.tts_voices (lang, voice, voice_id, language_code)
    values ('en', 'female', '$VOICE_FEMALE', 'en')
    on conflict (lang, voice) do update set voice_id = excluded.voice_id, enabled = true" >/dev/null
  [[ -z $VOICE_MALE ]] || query "insert into private.tts_voices (lang, voice, voice_id, language_code)
    values ('en', 'male', '$VOICE_MALE', 'en')
    on conflict (lang, voice) do update set voice_id = excluded.voice_id, enabled = true" >/dev/null
  query "update private.tts_settings set enabled = true, function_url = '$URL/functions/v1/tts'" >/dev/null

  say 'Verifying read-aloud'
  SECRETS=$(secret_names | jq -r 'map(select(. == "ELEVENLABS_API_KEY" or . == "TTS_FUNCTION_SECRET")) | length')
  check 'function secrets ELEVENLABS_API_KEY and TTS_FUNCTION_SECRET are set' "$SECRETS" 2
  check 'function tts refuses calls without the secret' \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/functions/v1/tts" -d '{}')" 401
  check 'function tts-credits refuses calls without the broadcast token' \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/functions/v1/tts-credits" -d '{}')" 401
  check 'English voices female and male are enabled' \
    "$(query "select 'voices:' || count(*) as n from private.tts_voices where lang = 'en' and enabled" | grep -o 'voices:[0-9]*' | head -1)" 'voices:2'
  check 'read-aloud is switched on' \
    "$(query "select 'tts:' || enabled as n from private.tts_settings" | grep -o 'tts:[a-z]*' | head -1)" 'tts:true'
fi

if [[ $FAIL == 0 ]]; then
  say 'Done. Commit shared/public-config.json, then follow docs/supabase-setup.md from "Install the extension".'
else
  die 'Some checks failed; see "Troubleshooting" in docs/supabase-setup.md.'
fi
