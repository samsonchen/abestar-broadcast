// Renders the transcript and status into index.html: cards, revision marks, auto-scroll and the "New lines" pill.
import type { Segment } from '@abestar/shared';
import { revisionParts } from './diff';
import type { Status, View } from './live';
import type { Change } from './transcript';

const STATUS_TEXT: Record<Status, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
  ended: 'Ended',
};

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

const atBottom = () =>
  window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 64;

const scrollToBottom = (smooth: boolean) =>
  window.scrollTo({
    top: document.documentElement.scrollHeight,
    behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto',
  });

export function domView(lang: string | null, onStatus: (status: Status) => void): View {
  const lines = byId<HTMLOListElement>('lines');
  const pill = byId<HTMLButtonElement>('new-lines');
  const status = byId('status');
  const rows = new Map<Segment, HTMLLIElement>();

  window.addEventListener('scroll', () => {
    if (atBottom()) pill.hidden = true;
  });
  pill.addEventListener('click', () => {
    pill.hidden = true;
    scrollToBottom(true);
  });

  function render(li: HTMLLIElement, segment: Segment) {
    li.replaceChildren();
    for (const part of revisionParts(segment.prev_text, segment.text, lang)) {
      if (!part.revised) li.append(part.text);
      else li.append(Object.assign(document.createElement('mark'), { textContent: part.text }));
    }
    if (segment.version > 1) {
      li.append(
        Object.assign(document.createElement('span'), { className: 'tag', textContent: 'revised' }),
      );
    }
  }

  return {
    changes(changes: Change[]) {
      const follow = atBottom();
      for (const change of changes) {
        if (change.kind === 'insert') {
          const li = document.createElement('li');
          li.className = 'line';
          render(li, change.segment);
          lines.insertBefore(li, lines.children[change.index] ?? null);
          rows.set(change.segment, li);
        } else {
          const li = rows.get(change.segment);
          if (!li) continue;
          render(li, change.segment);
          li.classList.remove('flash');
          void li.offsetWidth; // restart the animation
          li.classList.add('flash');
        }
      }
      byId('empty').hidden = true;
      if (follow) scrollToBottom(false);
      else pill.hidden = false;
    },
    status(next: Status) {
      status.dataset.status = next;
      status.textContent = STATUS_TEXT[next];
      if (next === 'ended') {
        byId('ended').hidden = false;
        byId('empty').hidden = true;
      }
      onStatus(next);
    },
    idle(idle: boolean) {
      byId('idle').hidden = !idle;
    },
  };
}
