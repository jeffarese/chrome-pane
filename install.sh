#!/bin/sh
# Puts chrome-pane on your PATH, tells this computer's Herdr app how to show it, and gives the
# agents here (Claude Code, Codex) the skill to use it.
#   ./install.sh            install (run again after moving the folder)
#   ./install.sh --remove   take both out
set -eu
here=$(cd "$(dirname "$0")" && pwd -P)
bin=${CHROME_PANE_BIN:-$HOME/.local/bin}
link="$bin/chrome-pane"
if [ "${1:-}" = "--remove" ]; then
  "$here/bin/chrome-pane" stop >/dev/null 2>&1 || :
  [ -L "$link" ] && rm "$link"
  [ -d "${HERDR_APP_HOME:-$HOME/.config/herdr-app}" ] && "$here/bin/chrome-pane" herdr --remove || :
  "$here/bin/chrome-pane" skill remove || :
  echo "Removed chrome-pane."
  exit 0
fi
mkdir -p "$bin"
if [ -e "$link" ] && [ ! -L "$link" ]; then echo "$link exists and is not a link; leaving it alone" >&2; exit 1; fi
ln -sfn "$here/bin/chrome-pane" "$link"
echo "Linked $link"
if [ -d "${HERDR_APP_HOME:-$HOME/.config/herdr-app}" ]; then "$here/bin/chrome-pane" herdr; fi
"$here/bin/chrome-pane" skill install
case ":$PATH:" in *":$bin:"*) ;; *) echo "Add $bin to your PATH." ;; esac
