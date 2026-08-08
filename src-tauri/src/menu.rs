//! The macOS application menu.
//!
//! Why RocSpace builds its own instead of taking Tauri's default: the default
//! menu puts "Close Window" in File (and again in Window), and on macOS that
//! item owns ⌘W as a key equivalent. AppKit dispatches key equivalents before
//! the event ever reaches the webview, so the dock's ⌘W ("close the focused
//! pane") could never fire — the chord would close the whole window instead,
//! taking every running PTY with it. There is no way to unbind a predefined
//! item's accelerator, so the item itself has to go.
//!
//! Everything else about the default menu is worth keeping, and two parts are
//! load-bearing rather than decorative:
//!   - the Edit items. ⌘C / ⌘V / ⌘Z inside the webview are AppKit key
//!     equivalents too; drop them and the user cannot paste into a text field.
//!   - the Window and Help submenu ids. Tauri hands those two to AppKit
//!     (`set_as_windows_menu_for_nsapp`), which is what gives macOS its window
//!     list and its Help search.
//!
//! macOS only — no other platform binds ⌘W from a menu, so no other platform
//! needs a custom one.

use tauri::menu::{
    AboutMetadata, IsMenuItem, Menu, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
    WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Runtime};

/// One entry in the menu.
///
/// There is deliberately no `CloseWindow` variant. Leaving the item out of the
/// vocabulary makes re-adding it a compile error rather than a thing a future
/// edit can do by accident — which matters, because the symptom (⌘W kills every
/// PTY in the window) looks nothing like its cause.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Item {
    About,
    Separator,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Zoom,
}

/// A submenu: what it is called, what is under it, and — for Window and Help —
/// the id AppKit is told to look for.
pub struct SubmenuSpec {
    pub title: String,
    pub id: Option<&'static str>,
    pub items: Vec<Item>,
}

/// The whole menu, as data. Split out from `build` so the shape can be asserted
/// without an event loop: materializing a real `Menu` needs a running app and
/// the main thread.
pub fn spec(app_name: &str) -> Vec<SubmenuSpec> {
    vec![
        SubmenuSpec {
            title: app_name.to_string(),
            id: None,
            items: vec![
                Item::About,
                Item::Separator,
                Item::Services,
                Item::Separator,
                Item::Hide,
                Item::HideOthers,
                Item::ShowAll,
                Item::Separator,
                Item::Quit,
            ],
        },
        // No File submenu at all: the only thing Tauri's default put in it was
        // the ⌘W item this module exists to drop.
        SubmenuSpec {
            title: "Edit".to_string(),
            id: None,
            items: vec![
                Item::Undo,
                Item::Redo,
                Item::Separator,
                Item::Cut,
                Item::Copy,
                Item::Paste,
                Item::SelectAll,
            ],
        },
        SubmenuSpec {
            title: "View".to_string(),
            id: None,
            items: vec![Item::Fullscreen],
        },
        SubmenuSpec {
            title: "Window".to_string(),
            id: Some(WINDOW_SUBMENU_ID),
            items: vec![Item::Minimize, Item::Zoom],
        },
        // Empty on purpose, as in Tauri's default: it exists so AppKit can
        // attach its Help search field.
        SubmenuSpec {
            title: "Help".to_string(),
            id: Some(HELP_SUBMENU_ID),
            items: Vec::new(),
        },
    ]
}

/// Build the app menu. Pass to `tauri::Builder::menu`.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_name = app.package_info().name.clone();
    let specs = spec(&app_name);

    let mut submenus = Vec::with_capacity(specs.len());
    for s in &specs {
        let items = s
            .items
            .iter()
            .map(|item| predefined(app, *item))
            .collect::<tauri::Result<Vec<_>>>()?;
        let refs = items
            .iter()
            .map(|i| i as &dyn IsMenuItem<R>)
            .collect::<Vec<_>>();
        submenus.push(match s.id {
            Some(id) => Submenu::with_id_and_items(app, id, &s.title, true, &refs)?,
            None => Submenu::with_items(app, &s.title, true, &refs)?,
        });
    }

    let refs = submenus
        .iter()
        .map(|s| s as &dyn IsMenuItem<R>)
        .collect::<Vec<_>>();
    Menu::with_items(app, &refs)
}

fn predefined<R: Runtime>(app: &AppHandle<R>, item: Item) -> tauri::Result<PredefinedMenuItem<R>> {
    match item {
        Item::About => PredefinedMenuItem::about(app, None, Some(about_metadata(app))),
        Item::Separator => PredefinedMenuItem::separator(app),
        Item::Services => PredefinedMenuItem::services(app, None),
        Item::Hide => PredefinedMenuItem::hide(app, None),
        Item::HideOthers => PredefinedMenuItem::hide_others(app, None),
        Item::ShowAll => PredefinedMenuItem::show_all(app, None),
        Item::Quit => PredefinedMenuItem::quit(app, None),
        Item::Undo => PredefinedMenuItem::undo(app, None),
        Item::Redo => PredefinedMenuItem::redo(app, None),
        Item::Cut => PredefinedMenuItem::cut(app, None),
        Item::Copy => PredefinedMenuItem::copy(app, None),
        Item::Paste => PredefinedMenuItem::paste(app, None),
        Item::SelectAll => PredefinedMenuItem::select_all(app, None),
        Item::Fullscreen => PredefinedMenuItem::fullscreen(app, None),
        Item::Minimize => PredefinedMenuItem::minimize(app, None),
        // muda's `maximize` is macOS's "Zoom".
        Item::Zoom => PredefinedMenuItem::maximize(app, None),
    }
}

fn about_metadata<R: Runtime>(app: &AppHandle<R>) -> AboutMetadata<'static> {
    let pkg = app.package_info();
    let config = app.config();
    AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items_of(title: &str) -> Vec<Item> {
        spec("RocSpace")
            .into_iter()
            .find(|s| s.title == title)
            .unwrap_or_else(|| panic!("no {title} submenu"))
            .items
    }

    #[test]
    fn edit_keeps_every_clipboard_item() {
        // These are AppKit key equivalents: without the menu items, ⌘Z / ⌘X /
        // ⌘C / ⌘V / ⌘A do nothing inside the webview. Asserted exactly, so
        // trimming the menu cannot quietly cost the user their clipboard.
        assert_eq!(
            items_of("Edit"),
            vec![
                Item::Undo,
                Item::Redo,
                Item::Separator,
                Item::Cut,
                Item::Copy,
                Item::Paste,
                Item::SelectAll,
            ]
        );
    }

    #[test]
    fn nothing_in_the_menu_closes_the_window() {
        // The point of the module. Asserted as exact contents rather than a
        // "does not contain" so that adding *any* item to these submenus has to
        // be a deliberate edit here — a close item is only one of the ways to
        // take ⌘W back.
        assert_eq!(items_of("Window"), vec![Item::Minimize, Item::Zoom]);
        assert!(
            spec("RocSpace").iter().all(|s| s.title != "File"),
            "the File submenu is where Tauri's default hides ⌘W"
        );
    }

    #[test]
    fn the_app_submenu_is_named_for_the_app_and_can_still_quit() {
        let app = spec("RocSpace").into_iter().next().expect("app submenu");
        assert_eq!(app.title, "RocSpace");
        assert!(app.items.contains(&Item::Quit));
        assert!(app.items.contains(&Item::About));
    }

    #[test]
    fn window_and_help_carry_the_ids_appkit_looks_for() {
        // Tauri reads these two ids back out to hand the submenus to AppKit; a
        // typo would silently cost the window list and the Help search.
        let by_title = |title: &str| {
            spec("RocSpace")
                .into_iter()
                .find(|s| s.title == title)
                .map(|s| s.id)
                .unwrap()
        };
        assert_eq!(by_title("Window"), Some(WINDOW_SUBMENU_ID));
        assert_eq!(by_title("Help"), Some(HELP_SUBMENU_ID));
    }
}
