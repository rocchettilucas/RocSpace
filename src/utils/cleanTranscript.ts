/** Post-process a raw Whisper transcript before writing it into a terminal.
 *  Strips common filler words, normalizes whitespace, capitalizes the first
 *  letter, and ensures a single trailing space. CRITICAL: never emits "\n",
 *  so dictation cannot accidentally execute a shell command. */
export function cleanTranscript(raw: string): string {
  // Newlines → spaces. Done first so "run\nrm -rf" never reaches the PTY as Enter.
  let s = raw.replace(/\r\n|\r|\n/g, " ");

  // Strip standalone fillers along with any comma/period immediately after them.
  // 'like' and 'you know' are NOT in this list — they have too many legitimate
  // technical uses (Linux Like, "you know the drill") to filter without context.
  s = s.replace(/\b(uh|um|uhm|umm|er|ah|hmm|mhm)\b[,.]?\s*/gi, "");

  s = s.replace(/\s+/g, " ").trim();

  // After filler removal a stray punctuation character can be left at either end
  // (e.g. ", deploy the app" or "deploy the app,").
  s = s.replace(/^[,;:.\s]+/, "").replace(/[,;:\s]+$/, "");

  if (!s) return "";

  s = s.replace(/^([a-z])/, (m) => m.toUpperCase());

  return /[.!?,;:]$/.test(s) ? `${s} ` : `${s}. `;
}
