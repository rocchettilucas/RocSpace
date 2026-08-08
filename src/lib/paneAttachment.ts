/** Whether a pane's card is in the document, for the things that care.
 *
 *  A card does not live where the layout shows it. It lives in a permanent host
 *  element that the layout adopts and hands on (see `PaneCardHost`), which
 *  means a card stays mounted while its DOM is detached — which is every
 *  hidden pane for as long as another is maximized. React reports none of
 *  that: nothing re-renders, no effect re-runs, and the card cannot tell.
 *
 *  Most of what a card holds does not mind. A WebGL context does: WebKit keeps
 *  a small fixed number of them per process and force-loses the oldest to make
 *  room, and a lost context does not come back. Fifteen panes idling on
 *  detached canvases can spend that budget on nothing.
 *
 *  So the layout publishes attachment here and `useXterm` subscribes. Edges
 *  only: a host detached and re-adopted inside one commit — what every reshape
 *  does — has settled back by the time this is consulted and is not an event at
 *  all, so moving a pane costs nothing. */

type AttachmentListener = () => void;

/** Last published state per terminal, so a re-publish that changes nothing is
 *  not an event. */
const attached = new Map<string, boolean>();

const listeners = new Map<string, Set<AttachmentListener>>();

/** Publish whether `terminalId`'s host is currently in the document. Cheap to
 *  call on every commit — only a change notifies. */
export function setPaneAttached(terminalId: string, isAttached: boolean): void {
  if (attached.get(terminalId) === isAttached) return;
  attached.set(terminalId, isAttached);
  const subscribers = listeners.get(terminalId);
  if (!subscribers) return;
  // A snapshot: a listener is free to unsubscribe from inside the callback.
  for (const listener of [...subscribers]) listener();
}

/** Subscribe to `terminalId`'s attachment edges; returns the unsubscribe.
 *
 *  The listener takes no argument on purpose. The DOM is the authority on
 *  whether an element is connected, and a subscriber that reads it directly
 *  cannot act on a state this module got wrong. */
export function onPaneAttachmentChange(
  terminalId: string,
  listener: AttachmentListener,
): () => void {
  let subscribers = listeners.get(terminalId);
  if (!subscribers) {
    subscribers = new Set();
    listeners.set(terminalId, subscribers);
  }
  subscribers.add(listener);

  return () => {
    subscribers.delete(listener);
    if (subscribers.size > 0) return;
    // Nothing left that could care. Drop the record too: the terminal may be
    // closing, and a state map keyed by session id has to lose entries
    // somewhere.
    listeners.delete(terminalId);
    attached.delete(terminalId);
  };
}

/** Test helper — this state is module-global by design. */
export function resetPaneAttachments(): void {
  attached.clear();
  listeners.clear();
}
