-- Clips back at 22.05 kHz, 32 kbps: at 64 kbps a clip held half as much text, and the shorter pieces read worse
-- than the duller sound. Chinese keeps speed 1.1 (0005).
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
