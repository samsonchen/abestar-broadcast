// DOM events from the content script (isolated world) to content/main-world.ts (the page's world): the two worlds
// share the DOM but not JavaScript objects.
export const BROADCAST_ON = 'abestar-broadcast:on';
export const BROADCAST_OFF = 'abestar-broadcast:off';
