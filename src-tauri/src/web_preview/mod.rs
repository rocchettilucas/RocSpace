//! Native Tauri child webview that overlays the right-panel "Browser" host
//! `<div>`. Sits on top of the React DOM in window-content coordinates.
//!
//! Why a native webview and not an iframe: most major sites
//! (youtube.com, google.com, github.com, etc.) set `X-Frame-Options` /
//! `frame-ancestors` headers, which forbids them from loading inside an
//! iframe. A child webview is a top-level navigation as far as the destination
//! is concerned, so those policies don't apply.
//!
//! All commands are `async fn` so the IPC executor doesn't block the renderer
//! while Tauri dispatches `add_child` / `set_position` etc. to the main
//! thread. (Sync commands run on a dedicated IPC thread, but `add_child`
//! itself blocks waiting for the main thread to create the WebView2
//! instance — keeping the command async lets the renderer keep painting
//! while that happens.)
//!
//! The frontend owns positioning: it calls `web_preview_show` with the host
//! div's bounding rect, then `web_preview_set_bounds` whenever the rect
//! changes (ResizeObserver). When the user leaves Browser mode the frontend
//! calls `web_preview_close` and we destroy the webview. Reload is a re-call
//! of `web_preview_show` with the same URL — `navigate(url)` re-fetches.

use tauri::{
    webview::WebviewBuilder, AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};
use url::Url;

// The window this preview hangs off. Named at the crate root because the
// single-instance handler in `lib` has to raise that same window.
use crate::MAIN_WINDOW as PARENT_WINDOW;

/// One label is reused — there's exactly one preview at a time.
const WEBVIEW_LABEL: &str = "rocspace-preview";

fn parse_url(url: &str) -> Result<Url, String> {
    Url::parse(url).map_err(|e| format!("invalid url: {e}"))
}

/// Create the webview if it doesn't exist (loading `url`), or, if it exists,
/// navigate it to `url` and reposition. Idempotent.
#[tauri::command]
#[specta::specta]
pub async fn web_preview_show(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    // Refuse degenerate sizes — set_size with zero/negative values panics on
    // some platforms.
    let width = width.max(1.0);
    let height = height.max(1.0);
    let parsed = parse_url(&url)?;

    if let Some(existing) = app.get_webview(WEBVIEW_LABEL) {
        existing
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        existing
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        existing.navigate(parsed).map_err(|e| e.to_string())?;
        // Make sure the webview is visible — a previous setVisible(false) for
        // a collapsed-panel state leaves it hidden, and `navigate` alone
        // doesn't reverse that. (Show-after-navigate is a no-op when already
        // visible, so this is safe.)
        existing.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let window = app
        .get_window(PARENT_WINDOW)
        .ok_or_else(|| format!("window '{PARENT_WINDOW}' not found"))?;

    window
        .add_child(
            WebviewBuilder::new(WEBVIEW_LABEL, WebviewUrl::External(parsed)),
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Update the webview's position/size to track the host `<div>`.
#[tauri::command]
#[specta::specta]
pub async fn web_preview_set_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let webview = app
        .get_webview(WEBVIEW_LABEL)
        .ok_or_else(|| "preview webview not mounted".to_string())?;
    let width = width.max(1.0);
    let height = height.max(1.0);
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Destroy the webview. Called when the user leaves Browser mode.
#[tauri::command]
#[specta::specta]
pub async fn web_preview_close(app: AppHandle) -> Result<(), String> {
    let Some(webview) = app.get_webview(WEBVIEW_LABEL) else {
        return Ok(());
    };
    webview.close().map_err(|e| e.to_string())?;
    Ok(())
}

/// Hide or show the existing webview WITHOUT destroying it. Used when the
/// right-panel host `<div>` collapses to zero size (right-panel toggle, drag
/// to close): the webview is a top-level child of the main window and would
/// otherwise float over the rest of the app at its last position, showing as
/// a white rectangle covering the terminal grid.
///
/// Hiding is preferred over close+reopen because it preserves the page's
/// scroll position, form state, and SPA navigation — when the user pops the
/// panel back open, they pick up where they left off.
#[tauri::command]
#[specta::specta]
pub async fn web_preview_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let Some(webview) = app.get_webview(WEBVIEW_LABEL) else {
        return Ok(());
    };
    if visible {
        webview.show().map_err(|e| e.to_string())?;
    } else {
        webview.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}
