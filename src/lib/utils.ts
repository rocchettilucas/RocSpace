import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn-style class name composer: clsx for conditionals, tailwind-merge to dedup conflicting utilities. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** What a failure has to say for itself, in a sentence a toast can hold.
 *
 *  Strings first: a rejected Tauri command carries Rust's `Err(String)`
 *  verbatim, and that is the message written for the person reading it. An
 *  `Error` is the renderer's own, and anything else has no words at all — the
 *  caller's `fallback` speaks for it rather than "[object Object]". */
export function errorMessage(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim() !== "") return err;
  if (err instanceof Error && err.message !== "") return err.message;
  return fallback;
}

/** Last segment of a path, in either separator — the directory a workspace or
 *  a pane is *in*, which is what chrome has room to say. Handles a trailing
 *  separator, and hands back the input unchanged when there is nothing to
 *  trim. */
export function pathTail(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
