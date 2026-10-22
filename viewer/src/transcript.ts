// The lines a viewer has seen, merged from the initial fetch, Realtime events and gap re-fetches (PLAN.md §5.2).
import type { Segment } from '@abestar/shared';

export type Change =
  { kind: 'insert'; segment: Segment; index: number } | { kind: 'update'; segment: Segment };

const key = (s: Pick<Segment, 'epoch' | 'seq'>) => `${s.epoch}:${s.seq}`;
const before = (a: Segment, b: Segment) =>
  a.epoch < b.epoch || (a.epoch === b.epoch && a.seq < b.seq);

export class Transcript {
  private byKey = new Map<string, Segment>();
  private ordered: Segment[] = [];
  /** Newest `updated_at` seen, as the server wrote it; the gap re-fetch asks for rows at or after it. */
  lastUpdatedAt: string | null = null;

  get segments(): readonly Segment[] {
    return this.ordered;
  }

  /** Merges rows in any order. Duplicates and equal or lower versions are ignored. */
  merge(rows: readonly Segment[]): Change[] {
    const changes: Change[] = [];
    for (const row of rows) {
      if (!this.lastUpdatedAt || Date.parse(row.updated_at) > Date.parse(this.lastUpdatedAt)) {
        this.lastUpdatedAt = row.updated_at;
      }
      const known = this.byKey.get(key(row));
      if (known) {
        if (row.version <= known.version) continue;
        Object.assign(known, row);
        changes.push({ kind: 'update', segment: known });
        continue;
      }
      const segment = { ...row };
      let index = this.ordered.length;
      while (index > 0 && before(segment, this.ordered[index - 1] as Segment)) index--;
      this.ordered.splice(index, 0, segment);
      this.byKey.set(key(segment), segment);
      changes.push({ kind: 'insert', segment, index });
    }
    return changes;
  }
}
