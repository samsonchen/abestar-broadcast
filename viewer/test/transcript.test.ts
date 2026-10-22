import { describe, expect, it } from 'vitest';
import { Transcript } from '../src/transcript';
import { row } from './rows';

const texts = (t: Transcript) => t.segments.map((s) => s.text);

describe('Transcript', () => {
  it('orders by epoch then seq, whatever the arrival order', () => {
    const t = new Transcript();
    t.merge([row(1, 2, 'b'), row(0, 5, 'old page')]);
    const changes = t.merge([row(1, 1, 'a'), row(1, 3, 'c')]);
    expect(texts(t)).toEqual(['old page', 'a', 'b', 'c']);
    expect(changes.map((c) => c.kind === 'insert' && c.index)).toEqual([1, 3]);
  });

  it('ignores duplicates and equal or lower versions', () => {
    const t = new Transcript();
    t.merge([row(0, 1, 'Second take.', 2)]);
    expect(t.merge([row(0, 1, 'Second take.', 2), row(0, 1, 'First take.', 1)])).toEqual([]);
    expect(texts(t)).toEqual(['Second take.']);
  });

  it('applies a higher version as an update of the same line', () => {
    const t = new Transcript();
    t.merge([row(0, 1, 'Helo.')]);
    const [change] = t.merge([{ ...row(0, 1, 'Hello.', 2, 9), prev_text: 'Helo.' }]);
    expect(change).toMatchObject({ kind: 'update', segment: { text: 'Hello.', version: 2 } });
    expect(t.segments).toHaveLength(1);
  });

  it('tracks the newest updated_at for the gap re-fetch', () => {
    const t = new Transcript();
    expect(t.lastUpdatedAt).toBeNull();
    t.merge([row(0, 1, 'a', 1, 30), row(0, 2, 'b', 1, 10)]);
    expect(t.lastUpdatedAt).toBe('2026-10-22T10:00:30.000000+00:00');
  });
});
