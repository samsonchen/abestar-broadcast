-- M1 acceptance tests (PLAN.md §8). Run with `supabase test db`. Everything runs in one transaction and is
-- rolled back. Starts from its own state rather than the seed, which other tests change.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select private.set_broadcast_token('local-dev-token');
update public.sessions set status = 'ended', ended_at = now() where status = 'live';
insert into public.sessions (id, title, target_lang)
values ('00000000-0000-4000-8000-000000000001', 'Demo talk', 'en-US')
on conflict (id) do update set status = 'live', ended_at = null;
insert into private.session_pins (session_id, pin)
values ('00000000-0000-4000-8000-000000000001', '123456')
on conflict (session_id) do update set pin = excluded.pin;

insert into auth.users (id, aud, role, is_anonymous) values
  ('11111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', true),
  ('22222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', true);

-- ---------------------------------------------------------------- not signed in (extension's role)
set local role anon;

select throws_ok($$select * from public.sessions$$, '42501', null, 'anon cannot read sessions');
select throws_ok($$select * from public.segments$$, '42501', null, 'anon cannot read segments');
select throws_ok(
  $$insert into public.segments (session_id, epoch, seq, text)
    values ('00000000-0000-4000-8000-000000000001', 0, 99, 'x')$$,
  '42501', null, 'anon cannot insert segments directly');
select throws_ok($$select public.join_session('123456')$$, '42501', null, 'anon cannot join');
select throws_ok($$select private.set_broadcast_token('x')$$, '42501', null, 'anon cannot set the token');

-- ---------------------------------------------------------------- broadcast token
select throws_ok($$select public.start_session('wrong', 'Talk')$$,
  'PT401', 'invalid_token', 'wrong token cannot start a session');
select throws_ok(
  $$select public.upsert_segment('wrong', '00000000-0000-4000-8000-000000000001', 0, 1, 'x')$$,
  'PT401', 'invalid_token', 'wrong token cannot write segments');
select throws_ok($$select public.end_session('wrong', '00000000-0000-4000-8000-000000000001')$$,
  'PT401', 'invalid_token', 'wrong token cannot end a session');

-- ---------------------------------------------------------------- one live session
select throws_ok($$select public.start_session('local-dev-token', 'New talk')$$,
  'PT409', 'session_live', 'starting while another session is live needs force');

select set_config('test.new',
  public.start_session('local-dev-token', 'New talk', 'en-US', true)::text, true);
select set_config('test.sid', current_setting('test.new')::jsonb ->> 'id', true);
select set_config('test.pin', current_setting('test.new')::jsonb ->> 'pin', true);
select set_config('test.wrong_pin',
  lpad(((current_setting('test.pin')::int + 1) % 1000000)::text, 6, '0'), true);

reset role;
select is((select status from public.sessions where id = '00000000-0000-4000-8000-000000000001'),
  'ended', 'force ends the previous live session');
select is((select count(*)::int from public.sessions where status = 'live'), 1, 'exactly one live session');
select matches(current_setting('test.pin'), '^[0-9]{6}$', 'PIN has 6 digits');
select isnt(current_setting('test.pin'), '123456', 'new PIN differs from the previous session''s');

-- ---------------------------------------------------------------- segments and revisions
set local role anon;
select lives_ok(
  $$select public.upsert_segment('local-dev-token', current_setting('test.sid')::uuid, 0, 1, 'Hello world.')$$,
  'token holder writes a segment');

reset role;
select set_config('test.ctid',
  (select ctid::text from public.segments where session_id = current_setting('test.sid')::uuid), true);

set local role anon;
select public.upsert_segment('local-dev-token', current_setting('test.sid')::uuid, 0, 1, 'Hello world.');
reset role;
select is((select ctid::text from public.segments where session_id = current_setting('test.sid')::uuid),
  current_setting('test.ctid'), 'identical text writes nothing');
select is((select version from public.segments where session_id = current_setting('test.sid')::uuid),
  1, 'identical text keeps version 1');

set local role anon;
select public.upsert_segment('local-dev-token', current_setting('test.sid')::uuid, 0, 1, 'Hello, world.');
reset role;
select results_eq(
  $$select text, prev_text, version from public.segments where session_id = current_setting('test.sid')::uuid$$,
  $$values ('Hello, world.', 'Hello world.', 2)$$,
  'changed text bumps version and keeps prev_text');

-- ---------------------------------------------------------------- viewers
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","is_anonymous":true}', true);

select is((select count(*)::int from public.sessions), 0, 'viewer sees no session before joining');
select is(public.join_session(current_setting('test.wrong_pin')) ->> 'error', 'invalid_pin', 'wrong PIN rejected');
select is(public.join_session('123456') ->> 'error', 'invalid_pin', 'PIN of an ended session rejected');
select is(public.join_session(current_setting('test.pin')) -> 'session' ->> 'id', current_setting('test.sid'),
  'correct PIN joins the live session');
select is((select count(*)::int from public.sessions), 1, 'joined viewer sees only the joined session');
select is((select count(*)::int from public.segments), 1, 'joined viewer reads the live session''s segments');
select throws_ok(
  $$insert into public.session_viewers (session_id, user_id)
    values ('00000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111')$$,
  '42501', null, 'viewer cannot join by writing tables');
select throws_ok($$update public.sessions set title = 'x'$$, '42501', null, 'viewer cannot update sessions');

select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","is_anonymous":true}', true);
select is((select count(*)::int from public.segments), 0, 'a viewer who has not joined reads nothing');
select count(public.join_session(current_setting('test.wrong_pin'))) from generate_series(1, 5);
select is(public.join_session(current_setting('test.pin')) ->> 'error', 'too_many_attempts',
  'five wrong PINs in 10 minutes lock the viewer out, even with the right PIN');

-- ---------------------------------------------------------------- ending
reset role;
set local role anon;
select public.end_session('local-dev-token', current_setting('test.sid')::uuid);
select throws_ok(
  $$select public.upsert_segment('local-dev-token', current_setting('test.sid')::uuid, 0, 2, 'Late line.')$$,
  'PT410', 'session_not_live', 'no writes after the session ends');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","is_anonymous":true}', true);
select is((select status from public.sessions where id = current_setting('test.sid')::uuid), 'ended',
  'joined viewer still sees the session row, now ended');
select is((select count(*)::int from public.segments), 0, 'no segment reads after the session ends');
select is(public.join_session(current_setting('test.pin')) ->> 'error', 'invalid_pin',
  'cannot join an ended session');

-- ---------------------------------------------------------------- auto-end
reset role;
select public.start_session('local-dev-token', 'Idle talk');
update public.sessions set last_activity_at = now() - interval '3 hours' where status = 'live';
select private.auto_end_idle_sessions();
select is((select count(*)::int from public.sessions where status = 'live'), 0,
  'sessions idle for 2 hours are ended automatically');

select * from finish();
rollback;
