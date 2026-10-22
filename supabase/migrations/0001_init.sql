-- Abestar translation broadcast: schema, access control, revisions, realtime, housekeeping.
-- See PLAN.md §0 and §6.
--
-- Access model:
--   * The extension (anon key, no user) writes only through start_session / upsert_segment / end_session,
--     which check the broadcast token against its stored sha256.
--   * Viewers sign in anonymously (role `authenticated`) and call join_session(pin); RLS then lets them read
--     the session they joined, and its segments only while it is live.
--   * No client may write tables directly.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.sessions (
  id               uuid primary key default gen_random_uuid(),
  title            text not null check (length(title) between 1 and 200),
  target_lang      text check (length(target_lang) <= 35),
  status           text not null default 'live' check (status in ('live', 'ended')),
  created_at       timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  ended_at         timestamptz
);
-- At most one live session.
create unique index sessions_one_live on public.sessions ((true)) where status = 'live';

create table public.segments (
  session_id uuid not null references public.sessions (id) on delete cascade,
  epoch      int  not null check (epoch >= 0),
  seq        int  not null check (seq >= 0),
  text       text not null check (length(text) between 1 and 5000),
  prev_text  text,
  version    int  not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, epoch, seq)
);
create index segments_session_updated on public.segments (session_id, updated_at);

create table public.session_viewers (
  session_id uuid not null references public.sessions (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (session_id, user_id)
);
create index session_viewers_user on public.session_viewers (user_id);

create table private.session_pins (
  session_id uuid primary key references public.sessions (id) on delete cascade,
  pin        text not null check (pin ~ '^[0-9]{6}$')
);

create table private.broadcast_token (
  id         boolean primary key default true check (id), -- single row
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$')
);

create table private.join_attempts (
  id      bigint generated always as identity primary key,
  user_id uuid not null,
  at      timestamptz not null default now(),
  ok      boolean not null
);
create index join_attempts_user_at on private.join_attempts (user_id, at);

-- ---------------------------------------------------------------------------
-- Privileges and RLS: reads only, and only through the policies below.
-- ---------------------------------------------------------------------------

alter table public.sessions enable row level security;
alter table public.segments enable row level security;
alter table public.session_viewers enable row level security;

revoke all on public.sessions, public.segments, public.session_viewers from anon, authenticated;
grant select on public.sessions, public.segments, public.session_viewers to authenticated;

create policy "viewers read sessions they joined"
  on public.sessions for select to authenticated
  using (exists (
    select 1 from public.session_viewers v
    where v.session_id = sessions.id and v.user_id = (select auth.uid())
  ));

create policy "viewers read segments of a joined live session"
  on public.segments for select to authenticated
  using (exists (
    select 1 from public.session_viewers v
    join public.sessions s on s.id = v.session_id
    where v.session_id = segments.session_id
      and v.user_id = (select auth.uid())
      and s.status = 'live'
  ));

create policy "viewers read their own joins"
  on public.session_viewers for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Revisions (PLAN.md §6.4): the server owns version/prev_text; unchanged text is not written at all,
-- so a retried upsert produces no Realtime event.
-- ---------------------------------------------------------------------------

create function private.segments_before_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.text is not distinct from old.text then
    return null;
  end if;
  new.prev_text := old.text;
  new.version := old.version + 1;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;

create trigger segments_before_update
  before update on public.segments
  for each row execute function private.segments_before_update();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Errors use PostgREST's PTxxx SQLSTATEs, which become the HTTP status of the RPC call.
create function private.check_token(p_token text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_token is null or not exists (
    select 1 from private.broadcast_token
    where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  ) then
    raise exception 'invalid_token' using errcode = 'PT401';
  end if;
end;
$$;

create function private.random_pin() returns text
language sql volatile set search_path = '' as $$
  select lpad(
    (('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text,
    6, '0');
$$;

-- Stores the sha256 of a new broadcast token, replacing any previous one. Used by scripts/supabase-setup.sh.
create function private.set_broadcast_token(p_token text) returns void
language sql set search_path = '' as $$
  insert into private.broadcast_token (token_hash)
  values (encode(extensions.digest(p_token, 'sha256'), 'hex'))
  on conflict (id) do update set token_hash = excluded.token_hash;
$$;

-- ---------------------------------------------------------------------------
-- Broadcaster RPCs (called by the extension with the publishable key and the broadcast token)
-- ---------------------------------------------------------------------------

create function public.start_session(
  p_token text,
  p_title text,
  p_target_lang text default null,
  p_force boolean default false
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

  insert into public.sessions (title, target_lang) values (p_title, p_target_lang) returning id into v_id;
  insert into private.session_pins (session_id, pin) values (v_id, v_pin);
  return jsonb_build_object('id', v_id, 'pin', v_pin);
end;
$$;

create function public.upsert_segment(
  p_token text,
  p_session_id uuid,
  p_epoch int,
  p_seq int,
  p_text text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_token(p_token);
  if not exists (select 1 from public.sessions where id = p_session_id and status = 'live') then
    raise exception 'session_not_live' using errcode = 'PT410';
  end if;

  insert into public.segments (session_id, epoch, seq, text)
  values (p_session_id, p_epoch, p_seq, p_text)
  on conflict (session_id, epoch, seq) do update set text = excluded.text;

  -- Throttled so viewers don't get a sessions UPDATE event for every line.
  update public.sessions set last_activity_at = now()
  where id = p_session_id and last_activity_at < now() - interval '1 minute';
end;
$$;

create function public.end_session(p_token text, p_session_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_token(p_token);
  update public.sessions set status = 'ended', ended_at = now()
  where id = p_session_id and status = 'live';
end;
$$;

-- ---------------------------------------------------------------------------
-- Viewer RPC (called by an anonymously signed-in viewer)
-- Returns {"session": {...}} or {"error": "not_signed_in" | "too_many_attempts" | "invalid_pin"}.
-- It returns errors instead of raising them so the failed attempt is still recorded.
-- ---------------------------------------------------------------------------

create function public.join_session(p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_session public.sessions;
begin
  if v_uid is null then
    return jsonb_build_object('error', 'not_signed_in');
  end if;

  if (
    select count(*) from private.join_attempts
    where user_id = v_uid and not ok and at > now() - interval '10 minutes'
  ) >= 5 then
    return jsonb_build_object('error', 'too_many_attempts');
  end if;

  select s.* into v_session
  from public.sessions s join private.session_pins p on p.session_id = s.id
  where s.status = 'live' and p.pin = p_pin;

  insert into private.join_attempts (user_id, ok) values (v_uid, v_session.id is not null);
  if v_session.id is null then
    return jsonb_build_object('error', 'invalid_pin');
  end if;

  insert into public.session_viewers (session_id, user_id) values (v_session.id, v_uid)
  on conflict do nothing;
  return jsonb_build_object('session', to_jsonb(v_session));
end;
$$;

-- Supabase grants EXECUTE on new public functions to anon/authenticated by default; be explicit instead.
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function public.start_session(text, text, text, boolean) to anon, authenticated;
grant execute on function public.upsert_segment(text, uuid, int, int, text) to anon, authenticated;
grant execute on function public.end_session(text, uuid) to anon, authenticated;
grant execute on function public.join_session(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime (Postgres Changes); delivery respects the RLS policies above.
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.segments, public.sessions;

-- ---------------------------------------------------------------------------
-- Housekeeping (PLAN.md §6.5)
-- ---------------------------------------------------------------------------

create function private.auto_end_idle_sessions() returns void
language sql set search_path = '' as $$
  update public.sessions set status = 'ended', ended_at = now()
  where status = 'live' and last_activity_at < now() - interval '2 hours';
$$;

create function private.prune() returns void
language sql set search_path = '' as $$
  delete from private.join_attempts where at < now() - interval '1 day';
  -- Anonymous viewers are throwaway; their joins go with them (on delete cascade).
  delete from auth.users where is_anonymous and created_at < now() - interval '7 days';
$$;

select cron.schedule('auto-end-idle-sessions', '*/10 * * * *', 'select private.auto_end_idle_sessions()');
select cron.schedule('prune', '17 3 * * *', 'select private.prune()');
