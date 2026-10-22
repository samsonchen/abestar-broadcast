import { describe, expect, it } from 'vitest';
import { revisionParts } from '../src/diff';

describe('revisionParts', () => {
  it('leaves a first version unmarked', () => {
    expect(revisionParts(null, 'Hello there.')).toEqual([{ text: 'Hello there.', revised: false }]);
  });

  it('marks changed and added words and drops removed ones', () => {
    const parts = revisionParts('The cat sat on the mat.', 'The dog sat on the red mat.', 'en-US');
    expect(parts.map((p) => p.text).join('')).toBe('The dog sat on the red mat.');
    expect(parts.filter((p) => p.revised).map((p) => p.text.trim())).toEqual(['dog', 'red']);
  });

  it('marks nothing when only words were removed', () => {
    const parts = revisionParts('Really very good.', 'Really good.', 'en-US');
    expect(parts.every((p) => !p.revised)).toBe(true);
    expect(parts.map((p) => p.text).join('')).toBe('Really good.');
  });

  it('finds words in Chinese, which has no spaces', () => {
    const parts = revisionParts('我們今天開會。', '我們明天開會。', 'zh-TW');
    expect(parts.map((p) => p.text).join('')).toBe('我們明天開會。');
    expect(parts.filter((p) => p.revised).map((p) => p.text)).toEqual(['明天']);
  });
});
