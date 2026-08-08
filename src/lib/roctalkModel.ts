/** Fetching a Whisper model, and saying so while it happens.
 *
 *  Two surfaces start this download — the Settings row and the pill — and both
 *  used to do it the same wrong way: invoke the command, swallow any error to
 *  the console, and leave the store's `modelStatus` on "missing". Rust flips
 *  its own copy to "downloading" and the renderer never asked again, so the
 *  progress events poured into a ring that nothing rendered, the "Download
 *  model" button stayed on screen for the whole fetch, and every further click
 *  came back as "download already in progress" — into the console, where
 *  nobody was looking.
 *
 *  So the status is the renderer's to move: "downloading" the moment the fetch
 *  starts, and back to whatever Rust says the disk holds when it ends. That is
 *  what makes the progress branch reachable at all, and what makes a second
 *  click impossible rather than merely futile — the button it would need is
 *  gone. */

import { commands, type WhisperModelSize } from "@/lib/bindings";
import { errorMessage } from "@/lib/utils";
import { useRocTalkStore, useToastsStore } from "@/stores";

/** Download `size`'s model, driving the store's status and progress.
 *
 *  A no-op while one is already running: the two callers are a button and a
 *  pill, and a double click must not become two fetches of the same file.
 *  Never rejects — a failure is a toast, because both callers are places the
 *  user is looking. */
export async function startModelDownload(
  size: WhisperModelSize,
): Promise<void> {
  const store = useRocTalkStore.getState();
  if (store.modelStatus === "downloading") return;

  store.setDownloadProgress(0);
  store.setModelStatus("downloading");
  try {
    await commands.roctalkDownloadModel(size);
    // Ask Rust rather than assuming: the file being on disk is its answer to
    // give, and this is the same question the boot check asks.
    store.setModelStatus(await commands.roctalkGetModelStatus(size));
  } catch (err) {
    console.warn("[roctalk] downloadModel failed:", err);
    store.setModelStatus("missing");
    useToastsStore.getState().push({
      message: `The ${size} speech model could not be downloaded — ${errorMessage(
        err,
        "the download did not finish",
      )}`,
      tone: "warn",
    });
  }
}
