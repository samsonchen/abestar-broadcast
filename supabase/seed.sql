-- Local development only (`supabase start` / `supabase db reset`); never pushed to the hosted project.
-- Broadcast token: local-dev-token   ·   Live demo session PIN: 123456

select private.set_broadcast_token('local-dev-token');

insert into public.sessions (id, title, target_lang)
values ('00000000-0000-4000-8000-000000000001', 'Demo talk', 'en-US');
insert into private.session_pins (session_id, pin)
values ('00000000-0000-4000-8000-000000000001', '123456');

-- Texts from fixtures/logs/settled-events.json.
insert into public.segments (session_id, epoch, seq, text) values
  ('00000000-0000-4000-8000-000000000001', 0, 5,
   'The nine-in-one elections will be held on November 28th.'),
  ('00000000-0000-4000-8000-000000000001', 0, 24,
   'Chiang Wan-an is only leading by 1.2 percentage points. He finds it unbelievable—how could he only be leading by 1.2 percentage points?'),
  ('00000000-0000-4000-8000-000000000001', 0, 25,
   'Chen Shih-chung is practically about to overtake him; the figures released today show a gap of over ten percentage points between the two.'),
  ('00000000-0000-4000-8000-000000000001', 0, 31,
   'It is already evident that this is indeed');
