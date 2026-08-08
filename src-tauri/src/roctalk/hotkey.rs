//! Push-to-talk hotkey for RocTalk: bare Caps Lock (VK_CAPITAL).
//!
//! Tauri's global-shortcut plugin only fires on chord shortcuts and emits a
//! single event per press, not press/release pairs. RocTalk wants a
//! hold-to-talk feel, so on Windows we install a low-level keyboard hook
//! (WH_KEYBOARD_LL) that lets us see every key event globally and emit
//! `roctalk://ptt-down` / `roctalk://ptt-up` separately.
//!
//! Caps Lock is a TOGGLE key — releasing it normally flips the keyboard's
//! caps state and the on-keyboard LED. We always swallow Caps Lock events
//! while the hook is enabled (return LRESULT(1)), so the OS never sees the
//! press and the caps state stays put. Users who want to type in caps can
//! disable RocTalk via the Topbar Mic button.
//!
//! IMPORTANT: the hook callback runs on a system thread with a strict
//! ~300 ms budget — we MUST NOT block in it. Emitting a Tauri event is just a
//! channel send, so that's safe; anything else (mutex contention, IO) is not.

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter};

use super::events::{EVENT_PTT_DOWN, EVENT_PTT_UP};

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::VK_CAPITAL;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, KBDLLHOOKSTRUCT, MSG,
    WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

/// Global bridge so the C callback can reach the Tauri AppHandle.
static APP_HANDLE: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();
/// User-facing enable flag (toggled from the Topbar Mic button).
static ENABLED: AtomicBool = AtomicBool::new(true);
/// Tracks whether we've already emitted ptt-down for the current Caps hold so
/// Windows key autorepeat (which fires WM_KEYDOWN repeatedly while held)
/// does not flood the renderer.
static KEY_DOWN: AtomicBool = AtomicBool::new(false);
/// Tracks installation so a second install() is a no-op.
static INSTALLED: AtomicI32 = AtomicI32::new(0);

pub fn install(app: AppHandle) -> Result<(), String> {
    APP_HANDLE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|e| format!("APP_HANDLE poisoned: {e}"))?
        .replace(app);

    if INSTALLED.swap(1, Ordering::SeqCst) != 0 {
        return Ok(());
    }

    // The hook + its message pump must live on a dedicated thread (the LL hook
    // requires a thread with a Windows message queue, and Tauri's main thread
    // is the GUI thread we mustn't block).
    std::thread::Builder::new()
        .name("roctalk-hotkey".into())
        .spawn(move || unsafe {
            // For WH_KEYBOARD_LL the hmod parameter is ignored on Windows 10+;
            // None is the documented way to express "no specific module".
            let hook = match SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(low_level_keyboard_proc),
                None,
                0,
            ) {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("[roctalk-hotkey] SetWindowsHookExW failed: {e:?}");
                    return;
                }
            };
            // Hold the hook handle for the lifetime of this thread.
            let _hook = hook;

            let mut msg = MSG::default();
            // GetMessageW blocks until a message arrives; the LL hook itself is
            // delivered via this queue. Loop forever — the thread is daemonized
            // by std (no join), and exits when the process exits.
            loop {
                let ret = GetMessageW(&mut msg, None, 0, 0);
                if ret.0 == 0 || ret.0 == -1 {
                    break;
                }
                let _ = DispatchMessageW(&msg);
            }
        })
        .map_err(|e| format!("spawn hotkey thread: {e}"))?;

    Ok(())
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
    // If we're being disabled mid-press, clear the down flag so the next
    // press starts clean.
    if !on {
        KEY_DOWN.store(false, Ordering::Relaxed);
    }
}

unsafe extern "system" fn low_level_keyboard_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    // Negative codes mean "do not process, just pass it on" per docs.
    if n_code < 0 || !ENABLED.load(Ordering::Relaxed) {
        return CallNextHookEx(None, n_code, w_param, l_param);
    }

    let kb = &*(l_param.0 as *const KBDLLHOOKSTRUCT);
    let msg = w_param.0 as u32;
    let vk = kb.vkCode as u16;

    if vk == VK_CAPITAL.0 {
        match msg {
            WM_KEYDOWN | WM_SYSKEYDOWN => {
                // Suppress autorepeat: only emit on the first transition.
                if !KEY_DOWN.swap(true, Ordering::Relaxed) {
                    emit(EVENT_PTT_DOWN);
                }
            }
            WM_KEYUP | WM_SYSKEYUP => {
                if KEY_DOWN.swap(false, Ordering::Relaxed) {
                    emit(EVENT_PTT_UP);
                }
            }
            _ => {}
        }
        // CRITICAL: Caps Lock is a toggle key. Returning LRESULT(1) prevents
        // the OS from ever seeing the keystroke, so the caps state and LED
        // never flip while RocTalk is active. Users who actually want caps
        // can toggle RocTalk off via the Topbar Mic button.
        return LRESULT(1);
    }

    CallNextHookEx(None, n_code, w_param, l_param)
}

fn emit(event: &str) {
    let Some(cell) = APP_HANDLE.get() else { return };
    let Ok(guard) = cell.lock() else { return };
    if let Some(app) = guard.as_ref() {
        let _ = app.emit(event, ());
    }
}
