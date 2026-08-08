import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { RocTalkModelStatus } from "@/lib/bindings";

/** RocTalk dictation state. {enabled, position} are persisted via persistence.ts;
 *  the rest is ephemeral runtime state. */

export type RocTalkStatus = "idle" | "recording" | "transcribing";

export interface RocTalkPosition {
  x: number;
  y: number;
}

interface RocTalkState {
  enabled: boolean;
  status: RocTalkStatus;
  position: RocTalkPosition;
  /** Is a control asking the user to PRESS the push-to-talk chord right now?
   *
   *  Raised by Settings' accelerator picker while it is armed, and read by
   *  `useRocTalk`, which stands the whole push-to-talk path down for as long as
   *  it is up: the OS binding is handed back (a registered accelerator never
   *  reaches the webview at all) and the DOM fallback stops swallowing keys.
   *  Without it the one key the picker exists to capture is the one key it can
   *  never see — the hook's window-capture listener is ahead of it in the
   *  propagation path, and pressing the chord opened the microphone instead.
   *
   *  In the store rather than a module flag because the hook has to REACT to
   *  it: the unregister/register round trip is an effect. */
  capturingAccelerator: boolean;
  modelStatus: RocTalkModelStatus;
  /** 0..1 — only meaningful while modelStatus === 'downloading'. */
  downloadProgress: number;
  /** 0..1 — most recent voice level. Drives the waveform bars. */
  amplitude: number;
}

interface RocTalkActions {
  setEnabled: (enabled: boolean) => void;
  setStatus: (status: RocTalkStatus) => void;
  setPosition: (position: RocTalkPosition) => void;
  setCapturingAccelerator: (capturing: boolean) => void;
  setModelStatus: (status: RocTalkModelStatus) => void;
  setDownloadProgress: (progress: number) => void;
  setAmplitude: (amplitude: number) => void;
}

const DEFAULT_POSITION: RocTalkPosition = { x: 24, y: 24 };

const initialState: RocTalkState = {
  enabled: true,
  status: "idle",
  position: DEFAULT_POSITION,
  capturingAccelerator: false,
  modelStatus: "missing",
  downloadProgress: 0,
  amplitude: 0,
};

export const useRocTalkStore = create<RocTalkState & RocTalkActions>()(
  devtools(
    immer((set) => ({
      ...initialState,

      setEnabled: (enabled) =>
        set((s) => {
          s.enabled = enabled;
        }),
      setStatus: (status) =>
        set((s) => {
          s.status = status;
        }),
      setPosition: (position) =>
        set((s) => {
          s.position = position;
        }),
      setCapturingAccelerator: (capturing) =>
        set((s) => {
          s.capturingAccelerator = capturing;
        }),
      setModelStatus: (status) =>
        set((s) => {
          s.modelStatus = status;
          if (status === "ready") s.downloadProgress = 1;
          if (status === "missing") s.downloadProgress = 0;
        }),
      setDownloadProgress: (progress) =>
        set((s) => {
          s.downloadProgress = Math.max(0, Math.min(1, progress));
        }),
      setAmplitude: (amplitude) =>
        set((s) => {
          s.amplitude = Math.max(0, Math.min(1, amplitude));
        }),
    })),
    { name: "roctalk" },
  ),
);

// Selectors --------------------------------------------------------------

export const useRocTalkStatus = () => useRocTalkStore((s) => s.status);
export const useRocTalkAmplitude = () => useRocTalkStore((s) => s.amplitude);
export const useRocTalkPosition = () => useRocTalkStore((s) => s.position);
