-- Chinese read-aloud at speed 1.1 and clips at 44.1 kHz, 64 kbps (docs/tts-plan.md §6). Chinese voices speak slower
-- than their Voice Library previews; 32 kbps sounded dull.

-- ElevenLabs' speaking rate for this voice, 0.7–1.2; null keeps the voice's stored setting.
alter table private.tts_voices add column speed numeric(3, 2) check (speed between 0.7 and 1.2);
update private.tts_voices set speed = 1.1 where lang = 'zh';

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
      'voice_id', v_voice.voice_id, 'model_id', v_voice.model_id, 'language_code', v_voice.language_code,
      'speed', v_voice.speed),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-tts-secret', private.tts_secret()),
    timeout_milliseconds := 60000);
end;
$$;

create or replace function public.tts_deliver(
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
      'lang', v_job.lang, 'text_version', v_job.text_version, 'format', 'mp3_44100_64', 'audio', p_audio),
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
