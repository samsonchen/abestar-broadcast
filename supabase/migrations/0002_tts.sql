-- Text-to-speech (docs/tts-plan.md): which line is spoken and when, listener tracking, voices, and delivery.
--
-- Flow: a segment INSERT (or a pause, via pg_cron) makes the previous line eligible. tts_enqueue records a
-- tts_jobs row and, when someone is listening, posts the job to the Edge Function `tts` with pg_net (sent after
-- commit, so the extension's upsert_segment does not wait). The function calls ElevenLabs and hands each clip
-- back through tts_deliver, which pushes it with realtime.send to the private channel `tts:<session_id>`.
-- Nothing here may break the text path: the trigger swallows TTS errors.

create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.segments add column lang text check (length(lang) <= 35);

alter table public.sessions
  -- The broadcaster's read-aloud checkbox (off unless they turn it on); switchable while live.
  add column tts_on boolean not null default false,
  add column tts_voice text not null default 'female' check (tts_voice in ('female', 'male')),
  -- Language with an enabled voice (e.g. 'en') while tts_on, else null; set by a trigger. The viewer shows its
  -- toggle only when it is set.
  add column tts_lang text;

-- Null when this viewer's TTS is off; kept in the future by the viewer's heartbeat while it is on.
alter table public.session_viewers add column tts_until timestamptz;

-- ---------------------------------------------------------------------------
-- Configuration and jobs
-- ---------------------------------------------------------------------------

create table private.tts_voices (
  lang          text not null check (lang ~ '^[a-z]{2,3}$'), -- primary language subtag: en-US → en
  voice         text not null check (voice in ('female', 'male')),
  voice_id      text not null check (length(voice_id) between 1 and 100),
  model_id      text not null default 'eleven_flash_v2_5',
  language_code text,
  enabled       boolean not null default true,
  primary key (lang, voice)
);

create table private.tts_settings (
  id                  boolean primary key default true check (id), -- single row
  enabled             boolean not null default false,             -- global switch; the setup script turns it on
  quiet_flush_seconds int not null default 3 check (quiet_flush_seconds between 0 and 60),
  function_url        text                                        -- the Edge Function `tts`
);
insert into private.tts_settings default values;

create table private.tts_jobs (
  session_id   uuid not null,
  epoch        int  not null,
  seq          int  not null,
  status       text not null check (status in ('queued', 'done', 'skipped', 'failed')),
  skip_reason  text check (skip_reason in ('disabled', 'off', 'language', 'stale', 'no_listeners')),
  released_by  text not null check (released_by in ('next_line', 'pause')),
  voice        text,
  lang         text,
  text_version int  not null,
  chars        int  not null default 0,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  error        text,
  primary key (session_id, epoch, seq),
  foreign key (session_id, epoch, seq) references public.segments on delete cascade
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The voice for a line's language: the session's kind if enabled, else the other kind; no row when TTS is off
-- or the language has no voice.
create function private.tts_voice_for(p_lang text, p_voice text) returns private.tts_voices
language sql stable set search_path = '' as $$
  select v.*
  from private.tts_voices v cross join private.tts_settings s
  where s.enabled and v.enabled and v.lang = lower(split_part(p_lang, '-', 1))
  order by v.voice = p_voice desc
  limit 1;
$$;

-- Shared with the Edge Function (its TTS_FUNCTION_SECRET); stored in Vault by scripts/supabase-setup.sh --tts.
create function private.tts_secret() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'tts_function_secret';
$$;

create function private.check_tts_secret(p_secret text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_secret is null or p_secret is distinct from private.tts_secret() then
    raise exception 'invalid_secret' using errcode = 'PT401';
  end if;
end;
$$;

create function private.sessions_tts_lang() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.tts_lang := case when new.tts_on then (private.tts_voice_for(new.target_lang, new.tts_voice)).lang end;
  return new;
end;
$$;

create trigger sessions_tts_lang
  before insert or update of target_lang, tts_voice, tts_on on public.sessions
  for each row execute function private.sessions_tts_lang();

-- ---------------------------------------------------------------------------
-- Deciding what is spoken
-- ---------------------------------------------------------------------------

-- Records the job for one line (at most once) and, if it is to be spoken, posts it to the Edge Function.
create function private.tts_enqueue(p_session_id uuid, p_epoch int, p_seq int, p_released_by text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_segment public.segments;
  v_session public.sessions;
  v_settings private.tts_settings;
  v_voice private.tts_voices;
  v_lang text;
  v_reason text;
  v_previous text;
  v_next text;
begin
  if exists (
    select 1 from private.tts_jobs
    where session_id = p_session_id and epoch = p_epoch and seq = p_seq
  ) then
    return;
  end if;

  select * into v_segment from public.segments
  where session_id = p_session_id and epoch = p_epoch and seq = p_seq;
  select * into v_session from public.sessions where id = p_session_id;
  if v_segment.session_id is null or v_session.status is distinct from 'live' then
    return;
  end if;

  select * into v_settings from private.tts_settings;
  -- Lines from extensions before 0.2.0 carry no language; the session's applies.
  v_lang := coalesce(v_segment.lang, v_session.target_lang);
  v_voice := private.tts_voice_for(v_lang, v_session.tts_voice);
  v_reason := case
    when not v_settings.enabled then 'disabled'
    when not v_session.tts_on then 'off'
    when v_voice.voice_id is null then 'language'
    when v_segment.created_at < now() - interval '2 minutes' then 'stale'
    when not exists (
      select 1 from public.session_viewers
      where session_id = p_session_id and tts_until > now()
    ) then 'no_listeners'
  end;

  insert into private.tts_jobs (session_id, epoch, seq, status, skip_reason, released_by, voice, lang, text_version)
  values (p_session_id, p_epoch, p_seq, case when v_reason is null then 'queued' else 'skipped' end, v_reason,
    p_released_by, v_voice.voice, v_lang, v_segment.version)
  on conflict do nothing;
  if not found or v_reason is not null then
    return;
  end if;

  -- Neighbouring lines help ElevenLabs with intonation.
  select text into v_previous from public.segments
  where session_id = p_session_id and (epoch, seq) < (p_epoch, p_seq)
  order by epoch desc, seq desc limit 1;
  select text into v_next from public.segments
  where session_id = p_session_id and (epoch, seq) > (p_epoch, p_seq)
  order by epoch, seq limit 1;

  perform net.http_post(
    url := v_settings.function_url,
    body := jsonb_build_object(
      'session_id', p_session_id, 'epoch', p_epoch, 'seq', p_seq,
      'text', v_segment.text, 'previous_text', v_previous, 'next_text', v_next,
      'voice_id', v_voice.voice_id, 'model_id', v_voice.model_id, 'language_code', v_voice.language_code),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-tts-secret', private.tts_secret()),
    timeout_milliseconds := 60000);
end;
$$;

-- One line behind (R4): a new line releases the line before it. A line inserted out of order behind a newer
-- one is released at once.
create function private.segments_tts_release() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_previous record;
begin
  begin
    select epoch, seq into v_previous from public.segments
    where session_id = new.session_id and (epoch, seq) < (new.epoch, new.seq)
    order by epoch desc, seq desc limit 1;
    if found then
      perform private.tts_enqueue(new.session_id, v_previous.epoch, v_previous.seq, 'next_line');
    end if;
    if exists (
      select 1 from public.segments
      where session_id = new.session_id and (epoch, seq) > (new.epoch, new.seq)
    ) then
      perform private.tts_enqueue(new.session_id, new.epoch, new.seq, 'next_line');
    end if;
  exception when others then
    raise warning 'tts release failed: %', sqlerrm;
  end;
  return null;
end;
$$;

create trigger segments_tts_release
  after insert on public.segments
  for each row execute function private.segments_tts_release();

-- Pause flush: the newest line of a live session is released once it has not changed for quiet_flush_seconds.
create function private.tts_flush() returns void
language plpgsql set search_path = '' as $$
declare
  v_settings private.tts_settings;
  v_last record;
begin
  select * into v_settings from private.tts_settings;
  if not v_settings.enabled or v_settings.quiet_flush_seconds = 0 then
    return;
  end if;
  for v_last in
    select g.session_id, g.epoch, g.seq, g.updated_at
    from public.sessions s
    cross join lateral (
      select session_id, epoch, seq, updated_at from public.segments
      where session_id = s.id order by epoch desc, seq desc limit 1
    ) g
    where s.status = 'live'
  loop
    if v_last.updated_at <= now() - make_interval(secs => v_settings.quiet_flush_seconds) then
      perform private.tts_enqueue(v_last.session_id, v_last.epoch, v_last.seq, 'pause');
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Broadcaster RPCs: replaced to carry the language and the voice
-- ---------------------------------------------------------------------------

drop function public.start_session(text, text, text, boolean);
create function public.start_session(
  p_token text,
  p_title text,
  p_target_lang text default null,
  p_force boolean default false,
  p_voice text default 'female',
  p_tts boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_live uuid;
  v_prev_pin text;
  v_pin text;
  v_id uuid;
begin
  perform private.check_token(p_token);

  select id into v_live from public.sessions where status = 'live' for update;
  if found then
    if not p_force then
      raise exception 'session_live' using errcode = 'PT409';
    end if;
    update public.sessions set status = 'ended', ended_at = now() where id = v_live;
  end if;

  -- A new PIN never equals the previous session's, so an old QR code cannot open the new talk.
  select p.pin into v_prev_pin
  from private.session_pins p join public.sessions s on s.id = p.session_id
  order by s.created_at desc limit 1;
  loop
    v_pin := private.random_pin();
    exit when v_pin is distinct from v_prev_pin;
  end loop;

  insert into public.sessions (title, target_lang, tts_voice, tts_on)
  values (p_title, p_target_lang, coalesce(p_voice, 'female'), coalesce(p_tts, false)) returning id into v_id;
  insert into private.session_pins (session_id, pin) values (v_id, v_pin);
  return jsonb_build_object('id', v_id, 'pin', v_pin);
end;
$$;

drop function public.upsert_segment(text, uuid, int, int, text);
create function public.upsert_segment(
  p_token text,
  p_session_id uuid,
  p_epoch int,
  p_seq int,
  p_text text,
  p_lang text default null
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_token(p_token);
  if not exists (select 1 from public.sessions where id = p_session_id and status = 'live') then
    raise exception 'session_not_live' using errcode = 'PT410';
  end if;

  insert into public.segments (session_id, epoch, seq, text, lang)
  values (p_session_id, p_epoch, p_seq, p_text, p_lang)
  on conflict (session_id, epoch, seq) do update set text = excluded.text;

  -- Extensions before 0.2.0 send no language; keep what start_session set.
  if p_lang is not null then
    update public.sessions set target_lang = p_lang
    where id = p_session_id and target_lang is distinct from p_lang;
  end if;

  -- Throttled so viewers don't get a sessions UPDATE event for every line.
  update public.sessions set last_activity_at = now()
  where id = p_session_id and last_activity_at < now() - interval '1 minute';
end;
$$;

-- Turns read-aloud on or off and sets the voice of a live session; lines released from now on follow it.
create function public.set_session_tts(p_token text, p_session_id uuid, p_on boolean, p_voice text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_token(p_token);
  if p_on is null or p_voice is null or p_voice not in ('female', 'male') then
    raise exception 'invalid_voice' using errcode = 'PT400';
  end if;
  update public.sessions set tts_on = p_on, tts_voice = p_voice where id = p_session_id and status = 'live';
  if not found then
    raise exception 'session_not_live' using errcode = 'PT410';
  end if;
end;
$$;

-- Lets the Edge Function `tts-credits` check the broadcast token before it reports the ElevenLabs balance.
create function public.check_broadcast_token(p_token text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_token(p_token);
end;
$$;

-- ---------------------------------------------------------------------------
-- Viewer RPC: TTS on/off and heartbeat (R5). Returns false when not joined or the session is not live.
-- ---------------------------------------------------------------------------

create function public.set_tts(p_session_id uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.session_viewers v
  set tts_until = case when p_on then now() + interval '90 seconds' end
  where v.session_id = p_session_id and v.user_id = (select auth.uid())
    and exists (select 1 from public.sessions s where s.id = p_session_id and s.status = 'live');
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Edge Function RPCs (called with the publishable key and the shared secret)
-- ---------------------------------------------------------------------------

-- Pushes one clip (part p_part of p_parts) of a queued line to its listeners.
create function public.tts_deliver(
  p_secret text,
  p_session_id uuid,
  p_epoch int,
  p_seq int,
  p_part int,
  p_parts int,
  p_audio text,
  p_chars int
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_job private.tts_jobs;
begin
  perform private.check_tts_secret(p_secret);
  select * into v_job from private.tts_jobs
  where session_id = p_session_id and epoch = p_epoch and seq = p_seq and status = 'queued'
  for update;
  if v_job.session_id is null
    or not exists (select 1 from public.sessions where id = p_session_id and status = 'live') then
    return; -- ended meanwhile: when it ends, it ends
  end if;

  perform realtime.send(
    jsonb_build_object(
      'session_id', p_session_id, 'epoch', p_epoch, 'seq', p_seq, 'part', p_part, 'parts', p_parts,
      'lang', v_job.lang, 'text_version', v_job.text_version, 'format', 'mp3_22050_32', 'audio', p_audio),
    'audio',
    'tts:' || p_session_id,
    true);

  update private.tts_jobs
  set chars = chars + p_chars,
      status = case when p_part >= p_parts - 1 then 'done' else status end,
      finished_at = case when p_part >= p_parts - 1 then now() end
  where session_id = p_session_id and epoch = p_epoch and seq = p_seq;
end;
$$;

create function public.tts_fail(p_secret text, p_session_id uuid, p_epoch int, p_seq int, p_error text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_tts_secret(p_secret);
  update private.tts_jobs set status = 'failed', error = left(p_error, 1000), finished_at = now()
  where session_id = p_session_id and epoch = p_epoch and seq = p_seq and status = 'queued';
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function public.start_session(text, text, text, boolean, text, boolean) to anon, authenticated;
grant execute on function public.upsert_segment(text, uuid, int, int, text, text) to anon, authenticated;
grant execute on function public.end_session(text, uuid) to anon, authenticated;
grant execute on function public.set_session_tts(text, uuid, boolean, text) to anon, authenticated;
grant execute on function public.check_broadcast_token(text) to anon;
grant execute on function public.join_session(text) to authenticated;
grant execute on function public.set_tts(uuid, boolean) to authenticated;
grant execute on function public.tts_deliver(text, uuid, int, int, int, int, text, int) to anon;
grant execute on function public.tts_fail(text, uuid, int, int, text) to anon;

-- Joined viewers of a live session may receive on its private audio channel; no client may send on it.
create policy "tts listeners receive audio"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() like 'tts:%'
    and exists (
      select 1 from public.session_viewers v
      join public.sessions s on s.id = v.session_id
      where s.id::text = substr(realtime.topic(), 5)
        and v.user_id = (select auth.uid())
        and s.status = 'live'
    )
  );

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------

-- The flush job runs every second; keep its run log from growing without bound.
create or replace function private.prune() returns void
language sql set search_path = '' as $$
  delete from private.join_attempts where at < now() - interval '1 day';
  -- Anonymous viewers are throwaway; their joins go with them (on delete cascade).
  delete from auth.users where is_anonymous and created_at < now() - interval '7 days';
  delete from cron.job_run_details where end_time < now() - interval '1 day';
$$;

select cron.schedule('tts-flush', '1 seconds', 'select private.tts_flush()');
