// Wires the toolbar of mock-abestar.html to the mock.
import { mountMock, SESSION_1 } from './mock-abestar';

// Typed with animation frames like the real page, so a background tab pauses it the same way.
const mock = mountMock(
  document.querySelector<HTMLElement>('#app') as HTMLElement,
  'en-US',
  'zh-TW',
  {
    animationFrames: true,
  },
);
const textInput = document.querySelector<HTMLInputElement>('#text') as HTMLInputElement;

const on = (id: string, fn: () => void) =>
  document.querySelector(`#${id}`)?.addEventListener('click', fn);

on('play', () => {
  mock.clear();
  mock.play(SESSION_1);
});
on('add', () => mock.addPending());
on('resolve', () => {
  const n = mock.pending()[0];
  if (n !== undefined) mock.resolve(n, textInput.value || `Sentence number ${n}.`);
});
on('clear', () => mock.clear());

if (new URLSearchParams(location.search).has('autoplay')) mock.play(SESSION_1);
