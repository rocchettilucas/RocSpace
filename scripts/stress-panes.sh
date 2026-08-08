#!/usr/bin/env bash
#
# Pane stress harness — a manual tool, deliberately not part of CI.
#
# WHY IT IS MANUAL
#   The thing being measured is "does the app still feel alive", and no
#   assertion captures that. jsdom has no renderer, no GPU and no PTY, so the
#   unit tests can prove the write path batches (src/lib/outputQueue.test.ts)
#   but not that 8 panes of firehose output stay usable. That part is eyes.
#
# WHAT IT DOES
#   Prints one paste-ready command per pane. You open the panes (⌘D / ⌘⇧D),
#   paste one command into each, and then try to use the app while they run.
#
# HOW TO READ THE RESULT
#   PASS looks like:
#     • the window keeps repainting — no spinning beachball, ever;
#     • typing into the idle control pane echoes with no perceptible lag;
#     • ⌘D / ⌘W / dragging a divider all respond in well under 100 ms, and
#       the panes settle at their new size without a visible stagger;
#     • the UTF-8 pane shows its emoji and box-drawing intact. A single "�"
#       is a failure: it means a multi-byte character was split across two PTY
#       reads and decoded separately (see src-tauri/src/pty/utf8.rs).
#   FAIL looks like:
#     • beachball, or a window that only repaints when you stop typing;
#     • output that keeps arriving for seconds after you Ctrl-C the producer
#       (a backlog that deep means the per-frame budget is not being applied);
#     • one pane starving the others — check every pane is still advancing,
#       not just the focused one.
#
#   If it fails, the two knobs are FLUSH_BYTE_BUDGET in src/lib/outputQueue.ts
#   and whether the WebGL renderer actually attached — the DOM fallback is
#   several times slower. Check the devtools console for the one-shot
#   "[xterm] WebGL renderer unavailable" warning before blaming the batching.
#
# USAGE
#   scripts/stress-panes.sh [pane-count]      # default 8
#
set -euo pipefail

panes=${1:-8}
if ! [[ $panes =~ ^[0-9]+$ ]] || ((panes < 1)); then
  echo "usage: $0 [pane-count]   (a positive integer; default 8)" >&2
  exit 2
fi
# LIMITS.terminalsPerProfile in src/lib/limits.ts. One pane is left idle as
# the control, so the harness asks for at most cap-1 producers.
if ((panes > 15)); then
  echo "note: the profile cap is 16 panes; clamping to 15 producers." >&2
  panes=15
fi

bold=""
dim=""
reset=""
if [[ -t 1 ]]; then
  bold=$'\033[1m'
  dim=$'\033[2m'
  reset=$'\033[0m'
fi

rule() { printf '%s\n' "${dim}────────────────────────────────────────────────────────${reset}"; }

# The four load shapes, in the order they get handed out. Each stresses a
# different part of the path:
#   flood   — raw throughput. This is the one that used to lock the UI.
#   scroll  — line churn: exercises the scrollback trim and the ring buffer.
#   repaint — cursor addressing and SGR colour, i.e. what a TUI actually does.
#   utf8    — multi-byte characters at chunk boundaries (the 1D-1 fix).
loads=(
  "yes 'rocspace stress: the quick brown fox jumps over the lazy dog'"
  "while :; do seq 1 100000; done"
  "while :; do printf '\\033[H'; for i in 1 2 3 4 5 6 7 8; do printf '\\033[3%dm%s\\033[0m\\n' \"\$i\" \"\$(date +%T) ████████ pane repaint line \$i\"; done; done"
  "while :; do printf '🚀 ✓ 你好 é ▛▀▜ αβγ ± ° — mojibake check\\n'; done"
)
names=("flood" "scroll" "repaint" "utf8")

printf '%s\n' "${bold}RocSpace pane stress harness${reset}"
printf '%s\n' "${dim}$panes producer pane(s) + 1 idle control pane${reset}"
rule
printf '%s\n' "1. Open $((panes + 1)) panes in one profile (⌘D splits right, ⌘⇧D splits down)."
printf '%s\n' "2. Paste one command below into each pane, leaving the LAST pane empty."
printf '%s\n' "3. While they run, do all of: type in the idle pane, drag a divider,"
printf '%s\n' "   ⌘D a new pane, maximize and restore, scroll a busy pane back."
printf '%s\n' "4. Ctrl-C each producer when done (or ⌘W the panes)."
rule

for ((i = 0; i < panes; i++)); do
  slot=$((i % ${#loads[@]}))
  printf '%s\n' "${bold}pane $((i + 1))${reset} ${dim}(${names[$slot]})${reset}"
  printf '%s\n\n' "  ${loads[$slot]}"
done

printf '%s\n' "${bold}pane $((panes + 1))${reset} ${dim}(control — leave idle, type into it)${reset}"
printf '%s\n\n' "  # nothing to paste; this is where you feel the latency"
rule
printf '%s\n' "Smooth means: no beachball, no lag echoing keystrokes in the control"
printf '%s\n' "pane, resize/split under 100 ms, and no ${bold}�${reset} in the utf8 pane."
