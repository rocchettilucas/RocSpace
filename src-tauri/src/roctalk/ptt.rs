//! Global push-to-talk accelerator, on `tauri-plugin-global-shortcut`.
//!
//! The plugin has been a registered dependency since Phase 0 with nothing bound
//! to it, because RocTalk wants HOLD-to-talk and the plugin's own JS API only
//! reports one event per shortcut. Rust sees more: the handler is given a
//! `ShortcutEvent` whose `state` is `Pressed` or `Released`, which is exactly
//! the pair `useRocTalk` already listens for. So this module registers the
//! accelerator from Rust and re-emits those two states as the EXISTING
//! `roctalk://ptt-down` / `roctalk://ptt-up` events — the renderer pipeline is
//! unchanged, it just gains a second (global, configurable) source.
//!
//! # Why this is not the Windows hook
//!
//! `hotkey.rs` installs a WH_KEYBOARD_LL hook on Windows and drives the same
//! two events from bare Caps Lock. Both paths emitting would double-fire, so
//! the two are MUTUALLY EXCLUSIVE and the hook wins on Windows: it can bind a
//! bare toggle key (no accelerator can express Caps Lock alone in a way the OS
//! will register), and it can swallow the keystroke so the caps state never
//! flips. `PLUGIN_DRIVES_PTT` is the switch, and on Windows `register` stops
//! after VALIDATING the accelerator — the settings UI still gets its "that is
//! not a shortcut" error, nothing is bound, and `current()` answers `None`
//! because nothing is.
//!
//! # Why the accelerator is not persisted here
//!
//! It lives in `settings.dat` (`voice.accelerator`), which the renderer owns.
//! Rust is told what to bind at boot and whenever the user changes it; keeping
//! a second copy down here would be a second source of truth that can disagree
//! with the one the user can see.
//!
//! macOS note: Right-Option alone is NOT expressible as an accelerator (an
//! accelerator is modifiers + one key, and a lone modifier is neither), which
//! is why the default is `Alt+Space` rather than the push-to-talk key many
//! dictation apps use.

use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use super::events::{EVENT_PTT_DOWN, EVENT_PTT_UP};

/// Does the global-shortcut plugin drive PTT on this platform?
///
/// A `const` rather than a `cfg` block around half the module: the state
/// machine, the handler and the tests are the same everywhere, and only the
/// decision differs. See the module docs for why Windows says no.
const PLUGIN_DRIVES_PTT: bool = !cfg!(target_os = "windows");

/// Mirrors the LL hook's autorepeat guard: one `ptt-down` per hold, and a
/// `ptt-up` only for a hold we actually announced. macOS fires
/// `kEventHotKeyPressed` once per press, but a platform that repeats would
/// otherwise restart the recorder mid-sentence.
static DOWN: AtomicBool = AtomicBool::new(false);

/// The one registration this app keeps.
static SLOT: PttSlot = PttSlot::new(&DOWN);

/// An accelerator that is bound right now: what the OS took, plus the string
/// the caller spelled it with (`current()` echoes that back, so a renderer
/// comparing it against its own setting sees what it sent).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Registered {
    input: String,
    shortcut: Shortcut,
}

/// "Which accelerator is bound", as a state machine with the OS calls passed
/// in.
///
/// Separated from the plugin so replace semantics — the part with the sharp
/// edges — are testable without an `AppHandle`, which no unit test can build.
/// Production uses the `SLOT` static; each test builds its own, so they do not
/// race each other on a shared global.
struct PttSlot {
    current: Mutex<Option<Registered>>,
    /// The autorepeat guard this slot cancels when it drops a binding. A field
    /// rather than a reach for the `DOWN` static so each test owns its own and
    /// two of them cannot race on one global.
    down: &'static AtomicBool,
}

impl PttSlot {
    const fn new(down: &'static AtomicBool) -> Self {
        Self {
            current: Mutex::new(None),
            down,
        }
    }

    /// Bind `next` (or nothing), releasing whatever was bound before.
    ///
    /// * Re-binding the accelerator that is already live is a no-op rather than
    ///   an unregister/register round trip — a settings hydrate that re-sends
    ///   the stored value must not drop the binding for a frame.
    /// * The old accelerator is released BEFORE the new one is taken, so
    ///   re-binding a shortcut the OS thinks we already hold cannot fail.
    /// * If the new one is refused (another app owns it), the old one is put
    ///   back: a rejected change must not leave the user with no PTT at all.
    ///   The caller still hears about the refusal.
    /// * A hold that was live when the binding went away is CANCELLED —
    ///   `cancel_hold` runs. The OS stops delivering events for a shortcut the
    ///   moment it is unregistered, so the release of a key that was down when
    ///   the user rebound it (or switched RocTalk off) never arrives: without
    ///   this the renderer sits in "recording" with the microphone open and no
    ///   key left to let go of.
    fn apply<R, U, C>(
        &self,
        next: Option<Registered>,
        register: R,
        unregister: U,
        cancel_hold: C,
    ) -> Result<(), String>
    where
        R: Fn(&Shortcut) -> Result<(), String>,
        U: Fn(&Shortcut) -> Result<(), String>,
        C: Fn(),
    {
        let mut slot = self.current.lock();

        if let (Some(live), Some(wanted)) = (slot.as_ref(), next.as_ref()) {
            if live.shortcut == wanted.shortcut {
                // Same binding, possibly spelled differently ("alt+space" vs
                // "Alt+Space"). Keep the caller's spelling; touch nothing else.
                *slot = next;
                return Ok(());
            }
        }

        let previous = slot.take();
        if let Some(prev) = previous.as_ref() {
            if let Err(e) = unregister(&prev.shortcut) {
                // Not fatal: the binding is going away either way, and the most
                // common cause is an OS that already dropped it.
                eprintln!("[roctalk-ptt] unregister {} failed: {e}", prev.input);
            }
        }
        // Every hold is cancelled by a rebind — otherwise a key released while
        // it was no longer bound leaves the guard stuck "down" for ever. And
        // whoever was told the hold STARTED has to be told it ended, or the
        // recorder it opened stays open.
        if self.down.swap(false, Ordering::Relaxed) {
            cancel_hold();
        }

        let Some(wanted) = next else { return Ok(()) };

        match register(&wanted.shortcut) {
            Ok(()) => {
                *slot = Some(wanted);
                Ok(())
            }
            Err(e) => {
                if let Some(prev) = previous {
                    if register(&prev.shortcut).is_ok() {
                        *slot = Some(prev);
                    }
                }
                Err(e)
            }
        }
    }

    fn current(&self) -> Option<String> {
        self.current.lock().as_ref().map(|r| r.input.clone())
    }
}

/// Turn a user-supplied accelerator into one the OS can take.
///
/// The vocabulary is `global_hotkey`'s: modifiers first (`Control`, `Alt` /
/// `Option`, `Shift`, `Super` / `Command`), then exactly one key, joined by
/// `+`. Errors are the parser's own words — they name the token that was not
/// understood, which is what a picker wants to show.
pub fn parse_accelerator(raw: &str) -> Result<Shortcut, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("an accelerator cannot be empty".to_string());
    }
    trimmed
        .parse::<Shortcut>()
        .map_err(|e| format!("{trimmed} is not a valid shortcut: {e}"))
}

/// Bind `accelerator`, replacing whatever was bound before.
///
/// Validates first, so a typo is reported without disturbing a working
/// binding. On Windows the validation is all that happens — see the module
/// docs.
pub fn register(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let shortcut = parse_accelerator(accelerator)?;
    if !PLUGIN_DRIVES_PTT {
        return Ok(());
    }
    let wanted = Registered {
        input: accelerator.trim().to_string(),
        shortcut,
    };
    SLOT.apply(
        Some(wanted),
        |s| {
            app.global_shortcut()
                .on_shortcut(*s, on_ptt)
                .map_err(|e| format!("{s} could not be registered: {e}"))
        },
        |s| {
            app.global_shortcut()
                .unregister(*s)
                .map_err(|e| e.to_string())
        },
        || end_hold(app),
    )
}

/// Release the accelerator. Unregistering when nothing is bound succeeds.
pub fn unregister(app: &AppHandle) -> Result<(), String> {
    SLOT.apply(
        None,
        |s| {
            app.global_shortcut()
                .on_shortcut(*s, on_ptt)
                .map_err(|e| e.to_string())
        },
        |s| {
            app.global_shortcut()
                .unregister(*s)
                .map_err(|e| e.to_string())
        },
        || end_hold(app),
    )
}

/// Tell the renderer the hold is over when the binding — not the user's
/// finger — is what ended it. The renderer's `ptt-up` handler is a no-op
/// unless it is recording, so an extra one is harmless; a missing one leaves
/// the microphone open until the app is restarted.
fn end_hold(app: &AppHandle) {
    let _ = app.emit(EVENT_PTT_UP, ());
}

/// The accelerator bound right now, as the caller spelled it. `None` when
/// nothing is bound — including everywhere on Windows, where the LL hook owns
/// push-to-talk instead.
pub fn current() -> Option<String> {
    SLOT.current()
}

/// The plugin's handler: two states in, the renderer's two events out.
///
/// A plain `fn` rather than a closure so the same handler can be handed to a
/// second `on_shortcut` call (the restore path in `PttSlot::apply`) without
/// cloning captured state.
fn on_ptt(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
    match event.state {
        ShortcutState::Pressed => {
            if !DOWN.swap(true, Ordering::Relaxed) {
                let _ = app.emit(EVENT_PTT_DOWN, ());
            }
        }
        ShortcutState::Released => {
            if DOWN.swap(false, Ordering::Relaxed) {
                let _ = app.emit(EVENT_PTT_UP, ());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn reg(input: &str) -> Registered {
        Registered {
            input: input.to_string(),
            shortcut: parse_accelerator(input).expect("test accelerator parses"),
        }
    }

    /// A slot with a hold flag of its own. Leaked deliberately: the field is
    /// `&'static` because production's points at a static, and a test that
    /// borrowed the production one would race every other test in the binary.
    fn test_slot() -> PttSlot {
        PttSlot::new(Box::leak(Box::new(AtomicBool::new(false))))
    }

    /// For the tests that are not about a key being held.
    fn no_cancel() {}

    /// Records every OS call the slot makes, in order.
    #[derive(Default)]
    struct Calls {
        registered: RefCell<Vec<String>>,
        unregistered: RefCell<Vec<String>>,
    }

    #[test]
    fn a_valid_accelerator_parses_and_an_invalid_one_says_why() {
        assert!(parse_accelerator("Alt+Space").is_ok());
        // Case and spacing are the parser's business, not the user's.
        assert_eq!(
            parse_accelerator("alt+space").unwrap(),
            parse_accelerator("Alt+Space").unwrap()
        );
        assert_eq!(
            parse_accelerator(" Control+Shift+KeyR ").unwrap(),
            parse_accelerator("Control+Shift+KeyR").unwrap()
        );

        for bad in ["", "   ", "Alt+", "Alt+Nope", "Ctrl+A+B"] {
            let err = parse_accelerator(bad).expect_err(&format!("{bad:?} must be refused"));
            assert!(!err.is_empty(), "the refusal has to say something");
        }
        // A lone modifier is not a shortcut — the macOS "Right Option" ask.
        assert!(parse_accelerator("Alt").is_err());
    }

    #[test]
    fn the_default_the_renderer_ships_is_bindable() {
        // `DEFAULT_VOICE_SETTINGS.accelerator` in `src/stores/settings.ts`. The
        // default lives there because that is where it is persisted and shown;
        // this asserts the string it ships is one this parser accepts.
        assert!(parse_accelerator("Alt+Space").is_ok());
    }

    #[test]
    fn registering_replaces_what_was_bound_before() {
        let slot = test_slot();
        let calls = Calls::default();
        let register = |s: &Shortcut| {
            calls.registered.borrow_mut().push(s.into_string());
            Ok(())
        };
        let unregister = |s: &Shortcut| {
            calls.unregistered.borrow_mut().push(s.into_string());
            Ok(())
        };

        slot.apply(Some(reg("Alt+Space")), register, unregister, no_cancel)
            .unwrap();
        assert_eq!(slot.current().as_deref(), Some("Alt+Space"));
        assert_eq!(calls.unregistered.borrow().len(), 0);

        slot.apply(
            Some(reg("Control+Shift+KeyD")),
            register,
            unregister,
            no_cancel,
        )
        .unwrap();

        assert_eq!(slot.current().as_deref(), Some("Control+Shift+KeyD"));
        // The old one was released, and released BEFORE the new one was taken.
        assert_eq!(
            *calls.unregistered.borrow(),
            vec![parse_accelerator("Alt+Space").unwrap().into_string()]
        );
        assert_eq!(calls.registered.borrow().len(), 2);
    }

    #[test]
    fn rebinding_the_live_accelerator_touches_nothing() {
        let slot = test_slot();
        let calls = Calls::default();
        let register = |s: &Shortcut| {
            calls.registered.borrow_mut().push(s.into_string());
            Ok(())
        };
        let unregister = |s: &Shortcut| {
            calls.unregistered.borrow_mut().push(s.into_string());
            Ok(())
        };

        slot.apply(Some(reg("Alt+Space")), register, unregister, no_cancel)
            .unwrap();
        // Same shortcut, different spelling — a hydrate re-sending the stored
        // value must not drop the binding on the floor.
        slot.apply(Some(reg("alt+Space")), register, unregister, no_cancel)
            .unwrap();

        assert_eq!(calls.registered.borrow().len(), 1);
        assert_eq!(calls.unregistered.borrow().len(), 0);
        assert_eq!(slot.current().as_deref(), Some("alt+Space"));
    }

    #[test]
    fn a_refused_accelerator_leaves_the_previous_one_working() {
        let slot = test_slot();
        let ok_register = |_: &Shortcut| Ok(());
        let ok_unregister = |_: &Shortcut| Ok(());
        slot.apply(
            Some(reg("Alt+Space")),
            ok_register,
            ok_unregister,
            no_cancel,
        )
        .unwrap();

        let taken = parse_accelerator("Control+Shift+KeyD").unwrap();
        let refuse = |s: &Shortcut| {
            if *s == taken {
                Err("HotKey already registered".to_string())
            } else {
                Ok(())
            }
        };

        let err = slot
            .apply(
                Some(reg("Control+Shift+KeyD")),
                refuse,
                ok_unregister,
                no_cancel,
            )
            .expect_err("a shortcut another app owns must surface");
        assert!(err.contains("already registered"));
        // …and the user still has the one that was working.
        assert_eq!(slot.current().as_deref(), Some("Alt+Space"));
    }

    #[test]
    fn unregistering_releases_the_binding_and_is_idempotent() {
        let slot = test_slot();
        let calls = Calls::default();
        let register = |_: &Shortcut| Ok(());
        let unregister = |s: &Shortcut| {
            calls.unregistered.borrow_mut().push(s.into_string());
            Ok(())
        };

        assert_eq!(slot.current(), None);
        slot.apply(None, register, unregister, no_cancel).unwrap();
        assert_eq!(calls.unregistered.borrow().len(), 0);

        slot.apply(Some(reg("Alt+Space")), register, unregister, no_cancel)
            .unwrap();
        slot.apply(None, register, unregister, no_cancel).unwrap();

        assert_eq!(slot.current(), None);
        assert_eq!(calls.unregistered.borrow().len(), 1);

        // Unregistering nothing, twice, is not an error.
        slot.apply(None, register, unregister, no_cancel).unwrap();
        assert_eq!(calls.unregistered.borrow().len(), 1);
    }

    #[test]
    fn a_failed_release_does_not_block_the_new_binding() {
        // The OS forgetting a shortcut we thought we held (a sleep, a fast user
        // switch) must not strand the user on an accelerator that no longer
        // works.
        let slot = test_slot();
        let register = |_: &Shortcut| Ok(());
        let unregister = |_: &Shortcut| Err("no such hotkey".to_string());

        slot.apply(Some(reg("Alt+Space")), register, unregister, no_cancel)
            .unwrap();
        slot.apply(
            Some(reg("Control+Shift+KeyD")),
            register,
            unregister,
            no_cancel,
        )
        .unwrap();

        assert_eq!(slot.current().as_deref(), Some("Control+Shift+KeyD"));
    }

    #[test]
    fn a_hold_that_outlives_its_binding_is_ended() {
        // Rebind (or switch RocTalk off) while the key is still down and the OS
        // stops delivering events for it: the Released that would have closed
        // the recorder never comes. The renderer would sit in "recording" with
        // the microphone open until the app was restarted.
        let slot = test_slot();
        let ends = std::cell::Cell::new(0);
        let ok = |_: &Shortcut| Ok(());
        let cancel = || ends.set(ends.get() + 1);

        slot.apply(Some(reg("Alt+Space")), ok, ok, cancel).unwrap();
        assert_eq!(ends.get(), 0, "nothing was held");

        // The user is holding ⌥Space right now.
        slot.down.store(true, Ordering::Relaxed);
        slot.apply(Some(reg("Control+F13")), ok, ok, cancel)
            .unwrap();

        assert_eq!(ends.get(), 1, "the hold has to be ended for the renderer");
        assert!(!slot.down.load(Ordering::Relaxed));

        // Unregistering ends one too — that is what switching RocTalk off does.
        slot.down.store(true, Ordering::Relaxed);
        slot.apply(None, ok, ok, cancel).unwrap();
        assert_eq!(ends.get(), 2);

        // …and a binding that changes while nothing is held says nothing.
        slot.apply(Some(reg("Alt+Space")), ok, ok, cancel).unwrap();
        slot.apply(None, ok, ok, cancel).unwrap();
        assert_eq!(ends.get(), 2);
    }

    #[test]
    fn rebinding_the_live_accelerator_does_not_end_a_hold() {
        // A hydrate that re-sends the stored value is not a rebind: it touches
        // nothing, so a key held through it is still held.
        let slot = test_slot();
        let ends = std::cell::Cell::new(0);
        let ok = |_: &Shortcut| Ok(());
        let cancel = || ends.set(ends.get() + 1);

        slot.apply(Some(reg("Alt+Space")), ok, ok, cancel).unwrap();
        slot.down.store(true, Ordering::Relaxed);
        slot.apply(Some(reg("alt+space")), ok, ok, cancel).unwrap();

        assert_eq!(ends.get(), 0);
        assert!(slot.down.load(Ordering::Relaxed));
    }
}
