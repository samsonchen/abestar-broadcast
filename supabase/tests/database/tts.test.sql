-- TTS acceptance tests (docs/tts-plan.md §11). Run with `supabase test db`. Everything runs in one transaction
-- and is rolled back; pg_net requests queued here are rolled back too, so nothing is sent.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select private.set_broadcast_token('local-dev-token');
update private.tts_settings set enabled = true, quiet_flush_seconds = 3, function_url = 'http://tts.invalid/tts';
delete from private.tts_voices;
insert into private.tts_voices (lang, voice, voice_id, language_code) values
  ('en', 'female', 'voice-f', 'en'),
  ('en', 'male', 'voice-m', 'en');
delete from vault.secrets where name = 'tts_function_secret';
select vault.create_secret('test-secret', 'tts_function_secret');

insert into auth.users (id, aud, role, is_anonymous) values
  ('11111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', true),
  ('22222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', true);

create function pg_temp.as_viewer(p_user text) returns void language sql as $$
  select set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","is_anonymous":true}', p_user), true);
$$;
create function pg_temp.line(p_seq int, p_text text, p_lang text default 'en-US') returns void language sql as $$
  select public.upsert_segment('local-dev-token', current_setting('test.sid')::uuid, 0, p_seq, p_text, p_lang);
$$;
create function pg_temp.job(p_seq int) returns private.tts_jobs language sql as $$
  select * from private.tts_jobs where session_id = current_setting('test.sid')::uuid and epoch = 0 and seq = p_seq;
$$;
create function pg_temp.requests() returns int language sql as $$
  select count(*)::int from net.http_request_queue;
$$;

-- ---------------------------------------------------------------- session, language, voice
set local role anon;
select set_config('test.new', public.start_session('local-dev-token', 'TTS talk', null, true, 'male', true)::text, true);
select set_config('test.sid', current_setting('test.new')::jsonb ->> 'id', true);
select set_config('test.pin', current_setting('test.new')::jsonb ->> 'pin', true);
reset role;

select results_eq($$select tts_on, tts_voice, tts_lang from public.sessions where id = current_setting('test.sid')::uuid$$,
  $$values (true, 'male', null::text)$$, 'start_session stores read-aloud and the voice; no language yet, so no TTS');
select throws_ok($$select public.start_session('local-dev-token', 'x', null, true, 'robot')$$, '23514', null,
  'start_session rejects an unknown voice');

select pg_temp.line(1, 'Good morning.');
select results_eq($$select target_lang, tts_lang from public.sessions where id = current_setting('test.sid')::uuid$$,
  $$values ('en-US', 'en')$$, 'the first line sets the session language and enables TTS for English');
select is((select lang from public.segments where session_id = current_setting('test.sid')::uuid and seq = 1),
  'en-US', 'the line stores its language');
select is((pg_temp.job(1)).status, null, 'the newest line waits for the next one');

-- ---------------------------------------------------------------- listeners (R5)
set local role anon;
select throws_ok($$select public.set_tts(current_setting('test.sid')::uuid, true)$$, '42501', null,
  'anon cannot call set_tts');
set local role authenticated;
select pg_temp.as_viewer('22222222-2222-4222-8222-222222222222');
select is(public.set_tts(current_setting('test.sid')::uuid, true), false, 'set_tts is refused before joining');
select pg_temp.as_viewer('11111111-1111-4111-8111-111111111111');
select is(public.join_session(current_setting('test.pin')) -> 'session' ->> 'tts_lang', 'en',
  'join_session returns tts_lang');
select is(public.set_tts(current_setting('test.sid')::uuid, true), true, 'a joined viewer turns TTS on');
reset role;
select ok((select tts_until between now() + interval '80 seconds' and now() + interval '100 seconds'
  from public.session_viewers where user_id = '11111111-1111-4111-8111-111111111111'),
  'TTS on lasts 90 seconds until the next heartbeat');

-- ---------------------------------------------------------------- one line behind (R4)
select set_config('test.requests', pg_temp.requests()::text, true);
select pg_temp.line(2, 'The cat sat on the mat.');
select results_eq($$select status, skip_reason, released_by, voice, lang, text_version from pg_temp.job(1)$$,
  $$values ('queued', null::text, 'next_line', 'male', 'en-US', 1)$$, 'the next line releases the previous one');
select is(pg_temp.requests(), current_setting('test.requests')::int + 1, 'one request is posted to the function');
select ok((select convert_from(body, 'utf8')::jsonb @> jsonb_build_object('seq', 1, 'text', 'Good morning.', 'voice_id', 'voice-m',
    'model_id', 'eleven_flash_v2_5', 'next_text', 'The cat sat on the mat.')
    and headers @> '{"x-tts-secret": "test-secret"}'
  from net.http_request_queue order by id desc limit 1), 'the request carries the line, voice, context and secret');
select is((pg_temp.job(2)).status, null, 'the new line itself waits');

select pg_temp.line(1, 'Good morning, everyone.');
select is((select count(*)::int from private.tts_jobs where session_id = current_setting('test.sid')::uuid and seq = 1),
  1, 'a revision after the line was released does not speak it again');
select is((pg_temp.job(1)).text_version, 1, 'the job keeps the version it spoke');

select pg_temp.line(2, 'The dog sat on the mat.');
select pg_temp.line(3, 'Third line.');
select is((pg_temp.job(2)).text_version, 2, 'a revision before release is spoken in its latest version');
select ok((select convert_from(body, 'utf8')::jsonb ->> 'text' = 'The dog sat on the mat.' from net.http_request_queue order by id desc limit 1),
  'the latest text is posted');

-- ---------------------------------------------------------------- skip reasons
set local role authenticated;
select pg_temp.as_viewer('11111111-1111-4111-8111-111111111111');
select public.set_tts(current_setting('test.sid')::uuid, false);
reset role;
select set_config('test.requests', pg_temp.requests()::text, true);
select pg_temp.line(4, 'Nobody listens.');
select results_eq($$select status, skip_reason from pg_temp.job(3)$$, $$values ('skipped', 'no_listeners')$$,
  'no listener: skipped');
select is(pg_temp.requests(), current_setting('test.requests')::int, 'no listener: no request');

update public.session_viewers set tts_until = now() - interval '1 second'
where user_id = '11111111-1111-4111-8111-111111111111';
select pg_temp.line(5, 'Heartbeat expired.');
select is((pg_temp.job(4)).skip_reason, 'no_listeners', 'an expired heartbeat counts as no listener');

update public.session_viewers set tts_until = now() + interval '1 minute'
where user_id = '11111111-1111-4111-8111-111111111111';
select pg_temp.line(6, '你好。', 'zh-TW');
select is((select tts_lang from public.sessions where id = current_setting('test.sid')::uuid), null,
  'switching to a language without a voice disables TTS for the session');
select pg_temp.line(7, 'Back to English.');
select results_eq($$select status, skip_reason from pg_temp.job(6)$$, $$values ('skipped', 'language')$$,
  'a line in a language without a voice is skipped');
select is((pg_temp.job(5)).status, 'queued', 'English lines are still spoken');

insert into public.segments (session_id, epoch, seq, text, lang, created_at, updated_at)
values (current_setting('test.sid')::uuid, 0, 8, 'Old line.', 'en-US', now() - interval '3 minutes',
  now() - interval '3 minutes');
select pg_temp.line(9, 'After a backlog.');
select is((pg_temp.job(8)).skip_reason, 'stale', 'a line older than 2 minutes is not spoken');

update private.tts_settings set enabled = false;
select pg_temp.line(10, 'Switched off.');
select is((pg_temp.job(9)).skip_reason, 'disabled', 'the global switch stops speech');
update private.tts_settings set enabled = true;

-- ---------------------------------------------------------------- voice switch
select throws_ok($$select public.set_session_tts('wrong', current_setting('test.sid')::uuid, true, 'female')$$,
  'PT401', 'invalid_token', 'set_session_tts needs the token');
select throws_ok($$select public.set_session_tts('local-dev-token', current_setting('test.sid')::uuid, true, 'robot')$$,
  'PT400', 'invalid_voice', 'set_session_tts rejects an unknown voice');
select throws_ok($$select public.set_session_tts('local-dev-token', current_setting('test.sid')::uuid, null, 'male')$$,
  'PT400', 'invalid_voice', 'set_session_tts rejects a missing on/off');
set local role anon;
select public.set_session_tts('local-dev-token', current_setting('test.sid')::uuid, true, 'female');
reset role;
select pg_temp.line(11, 'Now female.');
select is((pg_temp.job(10)).voice, 'female', 'lines released after the switch use the new voice');
select is((pg_temp.job(5)).voice, 'male', 'earlier jobs keep their voice');

update private.tts_voices set enabled = false where voice = 'female';
select pg_temp.line(12, 'Fallback.');
select is((pg_temp.job(11)).voice, 'male', 'without a voice of the chosen kind, the other kind is used');
update private.tts_voices set enabled = true where voice = 'female';

-- ---------------------------------------------------------------- pause flush (D2)
insert into public.segments (session_id, epoch, seq, text, lang, created_at, updated_at)
values (current_setting('test.sid')::uuid, 0, 13, 'Just said.', 'en-US', now() - interval '2 seconds',
  now() - interval '2 seconds');
select private.tts_flush();
select is((pg_temp.job(13)).status, null, 'no flush before 3 seconds');

insert into public.segments (session_id, epoch, seq, text, lang, created_at, updated_at)
values (current_setting('test.sid')::uuid, 0, 14, 'Then a pause.', 'en-US', now() - interval '4 seconds',
  now() - interval '4 seconds');
select private.tts_flush();
select results_eq($$select status, released_by from pg_temp.job(14)$$, $$values ('queued', 'pause')$$,
  'the newest line is released after a 3-second pause');
select pg_temp.line(15, 'After the pause.');
select is((select count(*)::int from private.tts_jobs where session_id = current_setting('test.sid')::uuid and seq = 14),
  1, 'a flushed line is not released again by the next line');

update private.tts_settings set quiet_flush_seconds = 0;
insert into public.segments (session_id, epoch, seq, text, lang, created_at, updated_at)
values (current_setting('test.sid')::uuid, 0, 16, 'Strict lag.', 'en-US', now() - interval '1 minute',
  now() - interval '1 minute');
select private.tts_flush();
select is((pg_temp.job(16)).status, null, 'quiet_flush_seconds = 0 keeps the strict one-line lag');
update private.tts_settings set quiet_flush_seconds = 3;

select pg_temp.line(20, 'No language given.', null);
select pg_temp.line(21, 'Next.');
select results_eq($$select status, lang from pg_temp.job(20)$$, $$values ('queued', 'en-US')$$,
  'a line without a language (extension before 0.2.0) uses the session''s');

-- ---------------------------------------------------------------- broadcaster's read-aloud switch
set local role anon;
select public.set_session_tts('local-dev-token', current_setting('test.sid')::uuid, false, 'female');
reset role;
select results_eq($$select tts_on, tts_lang from public.sessions where id = current_setting('test.sid')::uuid$$,
  $$values (false, null::text)$$, 'turning read-aloud off clears tts_lang, so viewers hide their toggle');
select set_config('test.requests', pg_temp.requests()::text, true);
select pg_temp.line(22, 'Read-aloud off.');
select results_eq($$select status, skip_reason from pg_temp.job(21)$$, $$values ('skipped', 'off')$$,
  'with read-aloud off, lines are skipped');
select is(pg_temp.requests(), current_setting('test.requests')::int, 'read-aloud off: no request');
set local role anon;
select public.set_session_tts('local-dev-token', current_setting('test.sid')::uuid, true, 'female');
reset role;
select is((select tts_lang from public.sessions where id = current_setting('test.sid')::uuid), 'en',
  'turning it back on offers read-aloud again');
select pg_temp.line(23, 'Back on.');
select is((pg_temp.job(22)).status, 'queued', 'lines released after turning it on are spoken');

-- ---------------------------------------------------------------- delivery
select throws_ok(
  $$select public.tts_deliver('wrong', current_setting('test.sid')::uuid, 0, 5, 0, 1, 'AAAA', 10)$$,
  'PT401', 'invalid_secret', 'tts_deliver needs the shared secret');
set local role authenticated;
select throws_ok(
  $$select public.tts_deliver('test-secret', current_setting('test.sid')::uuid, 0, 5, 0, 1, 'AAAA', 10)$$,
  '42501', null, 'viewers cannot call tts_deliver');
reset role;

set local role anon;
select public.tts_deliver('test-secret', current_setting('test.sid')::uuid, 0, 5, 0, 2, 'AAAA', 10);
reset role;
select results_eq($$select status, chars from pg_temp.job(5)$$, $$values ('queued', 10)$$,
  'a first part keeps the job open');
select is((select payload ->> 'audio' from realtime.messages
    where topic = 'tts:' || current_setting('test.sid') order by inserted_at desc limit 1), 'AAAA',
  'the clip is sent on the session''s audio channel');
set local role anon;
select public.tts_deliver('test-secret', current_setting('test.sid')::uuid, 0, 5, 1, 2, 'BBBB', 7);
select public.tts_fail('test-secret', current_setting('test.sid')::uuid, 0, 7, 'ElevenLabs HTTP 401');
reset role;
select results_eq($$select status, chars from pg_temp.job(5)$$, $$values ('done', 17)$$,
  'the last part completes the job');
select results_eq($$select status, error from pg_temp.job(7)$$, $$values ('failed', 'ElevenLabs HTTP 401')$$,
  'tts_fail records the error');

set local role anon;
select public.tts_deliver('test-secret', current_setting('test.sid')::uuid, 0, 3, 0, 1, 'CCCC', 5);
reset role;
select is((select count(*)::int from realtime.messages where payload ->> 'audio' = 'CCCC'), 0,
  'a skipped line is never delivered');

-- ---------------------------------------------------------------- audio channel access
select set_config('realtime.topic', 'tts:' || current_setting('test.sid'), true);
set local role authenticated;
select pg_temp.as_viewer('11111111-1111-4111-8111-111111111111');
select ok((select count(*) from realtime.messages where extension = 'broadcast') > 0,
  'a joined viewer may receive the audio channel');
select throws_ok(
  $$insert into realtime.messages (topic, extension, event, payload, private)
    values (current_setting('realtime.topic'), 'broadcast', 'audio', '{}', true)$$,
  '42501', null, 'a viewer cannot send on the audio channel');
select pg_temp.as_viewer('22222222-2222-4222-8222-222222222222');
select is((select count(*)::int from realtime.messages where extension = 'broadcast'), 0,
  'a viewer who has not joined may not receive it');
reset role;

-- ---------------------------------------------------------------- end
set local role anon;
select public.end_session('local-dev-token', current_setting('test.sid')::uuid);
select public.tts_deliver('test-secret', current_setting('test.sid')::uuid, 0, 10, 0, 1, 'DDDD', 5);
reset role;
select is((select count(*)::int from realtime.messages where payload ->> 'audio' = 'DDDD'), 0,
  'nothing is delivered after the session ends');
set local role authenticated;
select pg_temp.as_viewer('11111111-1111-4111-8111-111111111111');
select is(public.set_tts(current_setting('test.sid')::uuid, true), false, 'set_tts is refused after the end');
select is((select count(*)::int from realtime.messages where extension = 'broadcast'), 0,
  'the audio channel closes when the session ends');
reset role;

-- ---------------------------------------------------------------- default
set local role anon;
select set_config('test.sid', public.start_session('local-dev-token', 'Plain talk', 'en-US') ->> 'id', true);
reset role;
select results_eq($$select tts_on, tts_lang from public.sessions where id = current_setting('test.sid')::uuid$$,
  $$values (false, null::text)$$, 'read-aloud is off unless the broadcaster turns it on');

-- ---------------------------------------------------------------- Chinese: one voice set for zh-TW and zh-CN
insert into private.tts_voices (lang, voice, voice_id, language_code) values
  ('zh', 'female', 'voice-zh-f', 'zh'),
  ('zh', 'male', 'voice-zh-m', 'zh');
set local role anon;
select set_config('test.new', public.start_session('local-dev-token', 'Chinese talk', null, true, 'male', true)::text,
  true);
select set_config('test.sid', current_setting('test.new')::jsonb ->> 'id', true);
reset role;
select pg_temp.line(1, '各位早安。', 'zh-TW');
select is((select tts_lang from public.sessions where id = current_setting('test.sid')::uuid), 'zh',
  'a Traditional Chinese line selects the Chinese voices');
select pg_temp.line(2, '各位早安。', 'zh-CN');
select is((pg_temp.job(1)).voice, 'male', 'and is spoken with the chosen Chinese voice');
select is((select tts_lang from public.sessions where id = current_setting('test.sid')::uuid), 'zh',
  'Simplified Chinese uses the same voices');
select is((private.tts_voice_for('zh-Hant-TW', 'female')).voice_id, 'voice-zh-f',
  'longer Chinese tags (zh-Hant-TW) too');

-- ---------------------------------------------------------------- per-viewer language (the talk switches language)
set local role authenticated;
select pg_temp.as_viewer('11111111-1111-4111-8111-111111111111');
select ok(public.join_session(current_setting('test.new')::jsonb ->> 'pin') is not null, 'the viewer joins');
select is(public.set_tts(current_setting('test.sid')::uuid, true, 'en-US'), true,
  'a viewer turns read-aloud on in English');
reset role;
select is((select tts_lang from public.session_viewers where user_id = '11111111-1111-4111-8111-111111111111'
  and session_id = current_setting('test.sid')::uuid), 'en', 'its language is stored as the primary subtag');
select pg_temp.line(3, '第三句。', 'zh-TW');
select is((pg_temp.job(2)).skip_reason, 'no_listeners', 'a Chinese line is not synthesized for an English listener');

set local role authenticated;
select pg_temp.as_viewer('11111111-1111-4111-8111-111111111111');
select public.set_tts(current_setting('test.sid')::uuid, true, 'zh-TW');
reset role;
select set_config('test.requests', pg_temp.requests()::text, true);
select pg_temp.line(4, 'Back to English.', 'en-US');
select is((pg_temp.job(3)).status, 'queued', 'it is for a Chinese listener');
select is(pg_temp.requests(), current_setting('test.requests')::int + 1, 'and is sent to the Edge Function');
select is((select convert_from(body, 'utf8')::jsonb ->> 'next_text' from net.http_request_queue order by id desc limit 1), null,
  'without the English line after it as context');
select pg_temp.line(5, 'Still English.', 'en-US');
select is((pg_temp.job(4)).skip_reason, 'no_listeners', 'an English line is not synthesized for a Chinese listener');

set local role authenticated;
select pg_temp.as_viewer('11111111-1111-4111-8111-111111111111');
select public.set_tts(current_setting('test.sid')::uuid, true); -- a viewer page from before migration 0003
reset role;
select pg_temp.line(6, 'Any language.', 'en-US');
select is((pg_temp.job(5)).status, 'queued', 'a viewer without a language listens to every language');

-- ---------------------------------------------------------------- languages to pick from
set local role anon;
select throws_ok($$select public.tts_languages()$$, '42501', null, 'anon cannot list the read-aloud languages');
set local role authenticated;
select is(public.tts_languages(), '{en,zh}', 'a viewer lists the languages with an enabled voice');
reset role;
update private.tts_voices set enabled = false where lang = 'zh';
set local role authenticated;
select is(public.tts_languages(), '{en}', 'a language whose voices are off is not offered');
reset role;
update private.tts_settings set enabled = false;
set local role authenticated;
select is(public.tts_languages(), '{}', 'none while read-aloud is switched off for everyone');
reset role;

select * from finish();
rollback;
