-- Read-aloud per viewer language: the translation may switch language mid-talk (e.g. English → Chinese). Each viewer
-- listens in the language they turned read-aloud on in; a line is synthesized only when some viewer listens in its
-- language (R5), and the viewer pauses until its language returns (viewer/src/tts.ts).

-- The language a listening viewer wants (primary subtag, e.g. 'en'); null: any (viewers before this migration).
alter table public.session_viewers add column tts_lang text check (tts_lang ~ '^[a-z]{2,3}$');

drop function public.set_tts(uuid, boolean);
create function public.set_tts(p_session_id uuid, p_on boolean, p_lang text default null) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.session_viewers v
  set tts_until = case when p_on then now() + interval '90 seconds' end,
      tts_lang = case when p_on then nullif(lower(split_part(p_lang, '-', 1)), '') end
  where v.session_id = p_session_id and v.user_id = (select auth.uid())
    and exists (select 1 from public.sessions s where s.id = p_session_id and s.status = 'live');
  return found;
end;
$$;

create or replace function private.tts_enqueue(p_session_id uuid, p_epoch int, p_seq int, p_released_by text)
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
        and (tts_lang is null or tts_lang = v_voice.lang)
    ) then 'no_listeners'
  end;

  insert into private.tts_jobs (session_id, epoch, seq, status, skip_reason, released_by, voice, lang, text_version)
  values (p_session_id, p_epoch, p_seq, case when v_reason is null then 'queued' else 'skipped' end, v_reason,
    p_released_by, v_voice.voice, v_lang, v_segment.version)
  on conflict do nothing;
  if not found or v_reason is not null then
    return;
  end if;

  -- Neighbouring lines help ElevenLabs with intonation; not across a language switch.
  select text into v_previous from public.segments
  where session_id = p_session_id and (epoch, seq) < (p_epoch, p_seq)
    and lower(split_part(coalesce(lang, v_session.target_lang), '-', 1)) = v_voice.lang
  order by epoch desc, seq desc limit 1;
  select text into v_next from public.segments
  where session_id = p_session_id and (epoch, seq) > (p_epoch, p_seq)
    and lower(split_part(coalesce(lang, v_session.target_lang), '-', 1)) = v_voice.lang
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

revoke execute on function public.set_tts(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.set_tts(uuid, boolean, text) to authenticated;
revoke execute on function private.tts_enqueue(uuid, int, int, text) from public, anon, authenticated;
