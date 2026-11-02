// Wires the toolbar of mock-abestar.html to the mock. Lines live in sessionStorage so a reload shows them again, like
// the real page's history, and `?picker` starts on the language picker.
import { mountMock, type MockLine } from './mock-abestar';
import { RECORDED_FROM, RECORDED_TO, timelineFromLog } from './timeline';
import type { RawRecord } from './raw-logger';
import log from './logs/v2-session-1.json';

const STORAGE = 'mock-lines';
const CORRECTION_MS = 800;
const params = new URLSearchParams(location.search);
const saved = JSON.parse(sessionStorage.getItem(STORAGE) ?? '[]') as MockLine[];

const mock = mountMock(document.querySelector<HTMLElement>('#app') as HTMLElement, {
  picker: params.has('picker'),
  history: saved,
});
const save = () => sessionStorage.setItem(STORAGE, JSON.stringify(mock.lines()));
const textInput = document.querySelector<HTMLInputElement>('#text') as HTMLInputElement;
const on = (id: string, fn: () => void) =>
  document.querySelector(`#${id}`)?.addEventListener('click', fn);

const nextSeq = () =>
  Math.max(0, ...saved.map((l) => l.seq), ...mock.lines().map((l) => l.seq)) + 1;

/** One line's life: interim, then draft, then corrected with different text. */
on('say', () => {
  const seq = nextSeq();
  const text = textInput.value || `Sentence number ${seq}.`;
  mock.setInterim(`Interim ${text}`);
  mock.setInterim(null);
  mock.addLine({ seq, status: 'draft', text: `Draft ${text}`, lang: 'en' });
  save();
  setTimeout(() => {
    mock.updateLine(seq, 'corrected', text);
    save();
  }, CORRECTION_MS);
});
/** A line that stays a draft, for the 10 s fallback. */
on('stuck', () => {
  const seq = nextSeq();
  mock.addLine({ seq, status: 'draft', text: textInput.value || `Stuck ${seq}.`, lang: 'en' });
  save();
});
const replay = () => mock.play(timelineFromLog(log as RawRecord[], RECORDED_FROM, RECORDED_TO));
on('play', replay);
on('forget', () => sessionStorage.removeItem(STORAGE));

if (params.has('autoplay')) replay();
