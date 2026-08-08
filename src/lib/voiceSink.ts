/** Where a transcript goes when Voice is routed somewhere other than a
 *  terminal.
 *
 *  RocTalk knows how to type into a PTY — that is the whole of what it has ever
 *  done. Routing a transcript to Roc's command bar instead means handing it to
 *  a surface RocTalk must not import: Roc owns a store, a phase machine and a
 *  view, and a dictation hook that reached into all three would tie the two
 *  together for ever. So the destination registers ITSELF here, and the hook
 *  asks for whatever is registered.
 *
 *  One sink, not a list. Two things claiming the microphone's output would mean
 *  a transcript arriving twice, and "the last one to mount wins" is at least a
 *  rule you can reason about — the Roc surface registers on mount and clears on
 *  unmount, and while nothing is registered the hook falls back to the focused
 *  terminal rather than dropping what was said.
 *
 *  Module-level, like `terminalRegistry` and for the same reason: nobody
 *  renders it, and it has to outlive every component that could have set it. */

export type VoiceSink = (transcript: string) => void;

let sink: VoiceSink | null = null;

/** Claim the routed transcripts. Pass `null` on unmount to give them back. */
export function setVoiceSink(next: VoiceSink | null): void {
  sink = next;
}

/** Whoever is claiming routed transcripts, or `null` — in which case the
 *  caller must deliver it the way it always has. */
export function getVoiceSink(): VoiceSink | null {
  return sink;
}
