-- The read-aloud languages a viewer can pick when joining (viewer start dialog): those with an enabled voice, while
-- read-aloud is switched on globally. Primary subtags, e.g. {en,zh}.
create function public.tts_languages() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct v.lang order by v.lang), '{}')
  from private.tts_voices v cross join private.tts_settings s
  where s.enabled and v.enabled;
$$;

revoke execute on function public.tts_languages() from public, anon, authenticated;
grant execute on function public.tts_languages() to authenticated;
