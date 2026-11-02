-- When a line is spoken, per session. 'next_line' (the default): one line behind, for the Abestar v1 extension, whose
-- lines may still change. 'final': as soon as it is inserted, for the Abestar v2 extension, which sends only final
-- lines. An update never speaks a line again, in either mode.

alter table public.sessions
  add column tts_release text not null default 'next_line'
  check (tts_release in ('next_line', 'final'));

alter table private.tts_jobs drop constraint tts_jobs_released_by_check;
alter table private.tts_jobs
  add constraint tts_jobs_released_by_check check (released_by in ('next_line', 'pause', 'final'));

drop function public.start_session(text, text, text, boolean, text, boolean);
create function public.start_session(
  p_token text,
  p_title text,
  p_target_lang text default null,
  p_force boolean default false,
  p_voice text default 'female',
  p_tts boolean default false,
  p_tts_release text default 'next_line'
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

  insert into public.sessions (title, target_lang, tts_voice, tts_on, tts_release)
  values (p_title, p_target_lang, coalesce(p_voice, 'female'), coalesce(p_tts, false), coalesce(p_tts_release, 'next_line'))
  returning id into v_id;
  insert into private.session_pins (session_id, pin) values (v_id, v_pin);
  return jsonb_build_object('id', v_id, 'pin', v_pin);
end;
$$;
revoke execute on function public.start_session(text, text, text, boolean, text, boolean, text) from public, anon, authenticated;
grant execute on function public.start_session(text, text, text, boolean, text, boolean, text) to anon, authenticated;

create or replace function private.segments_tts_release() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_previous record;
begin
  begin
    if (select tts_release from public.sessions where id = new.session_id) = 'final' then
      perform private.tts_enqueue(new.session_id, new.epoch, new.seq, 'final');
      return null;
    end if;

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

create or replace function private.tts_flush() returns void
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
    where s.status = 'live' and s.tts_release = 'next_line'
  loop
    if v_last.updated_at <= now() - make_interval(secs => v_settings.quiet_flush_seconds) then
      perform private.tts_enqueue(v_last.session_id, v_last.epoch, v_last.seq, 'pause');
    end if;
  end loop;
end;
$$;
