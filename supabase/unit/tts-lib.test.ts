// Pure helpers of the Edge Function `tts` (docs/tts-plan.md §6).
import { describe, expect, it } from 'vitest';
import {
  base64,
  chunkText,
  elevenLabsBody,
  isJob,
  MAX_CHUNK,
  speechRequests,
  type SpeechRequest,
  type TtsJob,
} from '../functions/tts/lib';

const JOB: TtsJob = {
  session_id: '00000000-0000-4000-8000-000000000001',
  epoch: 0,
  seq: 5,
  text: 'The nine-in-one elections will be held on November 28th.',
  previous_text: 'Good morning.',
  next_text: 'Chiang Wan-an is only leading by 1.2 percentage points.',
  voice_id: 'voice-f',
  model_id: 'eleven_flash_v2_5',
  language_code: 'en',
};

describe('chunkText', () => {
  it('keeps a normal line whole, with whitespace tidied', () => {
    expect(chunkText('  Hello,\n world.  ')).toEqual(['Hello, world.']);
    expect(chunkText('   ')).toEqual([]);
  });

  it('splits long text at sentence ends, packing sentences up to the limit', () => {
    const sentence = 'Every sentence here is the same length.';
    const text = Array.from({ length: 25 }, () => sentence).join(' ');
    const chunks = chunkText(text);
    expect(chunks.every((c) => c.length <= MAX_CHUNK)).toBe(true);
    expect(chunks.every((c) => c.endsWith('.'))).toBe(true);
    expect(chunks.join(' ')).toBe(text);
    // As many whole sentences as fit, joined by spaces.
    const perChunk = Math.floor((MAX_CHUNK + 1) / (sentence.length + 1));
    expect(chunks[0]).toHaveLength(perChunk * (sentence.length + 1) - 1);
  });

  it('splits an over-long sentence at spaces, and a space-less run anywhere', () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkText(words, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join(' ')).toBe(words);
    expect(chunkText('x'.repeat(250), 100)).toEqual([
      'x'.repeat(100),
      'x'.repeat(100),
      'x'.repeat(50),
    ]);
  });

  it('treats CJK sentence ends as boundaries', () => {
    expect(chunkText('第一句。第二句！', 5)).toEqual(['第一句。', '第二句！']);
  });
});

describe('speechRequests', () => {
  it('gives a single chunk the neighbouring lines as context', () => {
    expect(speechRequests(JOB)).toEqual([
      { text: JOB.text, previous_text: JOB.previous_text, next_text: JOB.next_text },
    ]);
  });

  it('chains the chunks of a long line', () => {
    const job = { ...JOB, text: 'One one one. Two two two. Three three.', next_text: null };
    expect(speechRequests(job, 13)).toEqual([
      { text: 'One one one.', previous_text: 'Good morning.', next_text: 'Two two two.' },
      { text: 'Two two two.', previous_text: 'One one one.', next_text: 'Three three.' },
      { text: 'Three three.', previous_text: 'Two two two.', next_text: null },
    ]);
  });
});

describe('elevenLabsBody', () => {
  it('sends the model, language and context, leaving out empty fields', () => {
    expect(elevenLabsBody(JOB, speechRequests(JOB)[0] as SpeechRequest)).toEqual({
      text: JOB.text,
      model_id: 'eleven_flash_v2_5',
      language_code: 'en',
      previous_text: 'Good morning.',
      next_text: JOB.next_text,
    });
    const bare = { ...JOB, language_code: null, previous_text: null, next_text: null };
    expect(elevenLabsBody(bare, speechRequests(bare)[0] as SpeechRequest)).toEqual({
      text: JOB.text,
      model_id: 'eleven_flash_v2_5',
    });
  });
});

describe('isJob', () => {
  it('accepts what tts_enqueue posts and rejects anything else', () => {
    expect(isJob(JOB)).toBe(true);
    expect(isJob({ ...JOB, previous_text: null, next_text: null, language_code: null })).toBe(true);
    expect(isJob(null)).toBe(false);
    expect(isJob({ ...JOB, text: '' })).toBe(false);
    expect(isJob({ ...JOB, seq: '5' })).toBe(false);
    expect(isJob({ ...JOB, voice_id: undefined })).toBe(false);
  });
});

describe('base64', () => {
  it('matches Node for small and large buffers', () => {
    for (const size of [0, 1, 2, 3, 100_000]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 31) % 256);
      expect(base64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});
