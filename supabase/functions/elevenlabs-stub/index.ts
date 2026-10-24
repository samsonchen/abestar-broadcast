// Local stand-in for ElevenLabs' text-to-speech and subscription endpoints, used by tests and local development;
// never deployed (scripts/supabase-setup.sh deploys only `tts` and `tts-credits`). Any text gets a short quiet beep
// (MP3, 22.05 kHz, 32 kbps). A wrong key gives 401 and text containing "TTS-FAIL" gives 500, so the failure path
// can be tested. The subscription reports fixed numbers: 1,234 of 10,000 credits used.

const BEEP =
  'SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYzLjEuMTAyAAAAAAAAAAAAAAD/83DAAAAAAAAAAAAASW5mbwAAAA8AAAAQAAAHPgAnJycnJyc1NTU1NTVERERERERSUlJSUlJhYWFhYWFhb29vb29vfn5+fn5+jIyMjIyMmpqampqamqmpqampqbe3t7e3t8bGxsbGxtTU1NTU1NTj4+Pj4+Px8fHx8fH///////8AAAAATGF2YzYzLjEuAAAAAAAAAAAAAAAAJAOaAAAAAAAABz4S6wKTAAAAAAAAAAAAAAAAAP/zQMQAE2CqPAzGkohBAIrpFpjpjpjpjpjpjqDoqIqFsC2BiIABGWQBRuevCeB0aosBhBbRIhUjEGcO4BsEwTDYrFYrRo0CBAgQMAgCYPg+D793//////yB/oVOXYuXLly46MjIxMSS//NCxA0TmH5oGGaMhSSIIIrtAiM4DhUKVr+v6AQCRIkSRIlQUFBIKCgoKFBQUFBIKCgoKFBQUFBIKCgoKFBQUFBIKCgoLCCgoKCQUFBSaoAAABLK1Y4R/7/91IbpIbUAAIExg40KU4kw//NAxBoTWHYGXte4gMJkLcx9EjD8oStDeWa3S5g4YBcGo6MLeCJyixfdo9SbVW+L/3J+pOrXbVZo//V/9O/rRXWgAC7H1/75/b0Wa6nKMgBAGko8QIIJijA0F9MX26g/ramTCQG9MyP/80LEJxSYefWS37KEEMMN4G0wZwNDyXNcYFGpJPlJIzaduR2HaK+Mt0fX9nb17Vf/T7Xf//fnPQr//n1HTUoa2oIYeGmUExpaSb48Hr6Zg1QN0YpeTbnPDlHxidQCqYK0DkGALgWogAX/80DEMBR4eegA3/KEYgpHUiQVVBgb9wijdu+xVq/R/Rd9rv///Rutf/+mvdY/1dAALIfn/rn8vwllyNxADkAsIy8KLAXszALHSMTrdU+msriqP0Z1AipiCg5GDwBufrRvEgpZEVz4/P/zQsQ5FJh58ZLfsoQ1Sv3JZsb9F6en4z7e3ZfYv//dZ//1Yvt9av//1XdBabSFLzDgYykhNKPjfWs9a6MGtBezFSB7g6NAiDMTrAtjAqQecwAcDEMAAAXwLgFFxUZO1pECPnRP/2Uf/v/zQMRCFIB56ADf8oT7G/s/9q/TX6d27//4/ZTq0AA9gpA/9d/Ocg9kqNpYCBGNgQ0MHYTEr4wDR6TCp44Ou3SUwpx8TOvDsMQIGEweQLj8VN0QHKo1N5HIjTOhEbbSRfs8b6Pv/d/f//NCxEsVSHnxlN+yhHbb8b6N1v//7s/V7AAAI1wuttD+lLHAI27i6wcABh6IJ06KQTaQjMxiUzWCV39CdLNOn//t/32K9Ht/v//ZV91GhYAJzD/338Iu3isQhAQ6FwIMDB5TMSJAx/Dz//NAxFENoGI+XhdyZgF4KaMARSzTIoEX4wYwJ6MTMBBTBUwG4wKAA5OqcNYJBSoWErPeOAqU9FfpPL10xyOnpu/fs96Gq79b9SfY7/9nvz3llf1j2xK2YKHsKRiARQZiMmnGxv6+elP/80LEdReQeejq5/SExgz4IWYosBbndJDZJiQoMIYKoEZmA3gdxgHADyaGAZA+YMUX9gJ+XGgWesW6l0RGQTFTTl7v30XotHIZ6uv/+PQn3f//V6Nf2oAAAHIon/nz85Y87JUZRQOAJKb/80DEche4jeQA3/SEHIRkrqaNvGEGRGYrXqBiH8mmjYjn8JIGhghmPYPGHgGgIOgwFUgmaQBHaY7Fduln93o6VP+b7PfZ//9r//9WO2eqgAAApguZf/P1H26PCxUSCwEUGWhpqA8cmf/zQsRuFTB56jLfuoCZgmwAsYgGQWHAkkDh8EXZw2xxjgUJhaJhgkEpgGBwMAFSqDaOKz3Mm334/ut/6frT/T/us9////qZTQgN//r+23kZslsKhYAHjETkypkNXwzC2HeMonJs1Od7jP/zQMR1FOh94jLf+oAJtk9kCMz7CAxyA0w3AAHBiHAcnC28BzVXQWEzpnd3f+/qx3/6f//6v//0ZVWQABnLdv8NSzVgwVrkFrQAQGa5en7d4ddGUB6c0E1D4ZNMjG1I0CvSLIdrMPYl//NCxHwTUH3QMN+6gFc39aan9nV/rO3NU4kp9+r1V56WyypYAOYQ1K5BDz6wQ3yJpe5YZQVBYHBMojVMxaYwTcCwDByAvBMcqMyPBSwWNkwhFpiqSKqyh6gC128CwQHFlFmWiBqXaK0R//NAxIoQyF4Nngj2Ch/1U0xBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80LEoRI4pWGIxoyNVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=';
const audio = Uint8Array.from(atob(BEEP), (c) => c.charCodeAt(0));

const SUBSCRIPTION = {
  tier: 'stub',
  character_count: 1234,
  character_limit: 10000,
  next_character_count_reset_unix: 1894708800, // 2030-01-15 12:00 UTC
};

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname;
  const speech = req.method === 'POST' && path.includes('/v1/text-to-speech/');
  const subscription = req.method === 'GET' && path.endsWith('/v1/user/subscription');
  if (!speech && !subscription) return new Response('not found', { status: 404 });
  if (req.headers.get('xi-api-key') !== 'local-stub-key') {
    return Response.json({ detail: { status: 'invalid_api_key' } }, { status: 401 });
  }
  if (subscription) return Response.json(SUBSCRIPTION);
  const { text } = (await req.json()) as { text?: string };
  if (text?.includes('TTS-FAIL')) {
    return Response.json({ detail: { status: 'stub_failure' } }, { status: 500 });
  }
  return new Response(audio, { headers: { 'Content-Type': 'audio/mpeg' } });
});
