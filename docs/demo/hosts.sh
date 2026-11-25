#!/bin/sh
# Takes the README's pictures of the pane in Rex and in Tern:
#
#   sh docs/demo/hosts.sh            docs/media/rex.png and docs/media/tern.png
#   sh docs/demo/hosts.sh tern       one of them
#   KEEP=1 sh docs/demo/hosts.sh rex leaves the stage up, and says how to take it down
#
# Nobody's own Rex, Tern or Chrome is in them. Each picture is taken on a stage of its own: a
# folder /tmp/cph.XXXXXX with a home, a headless Chrome with an empty profile that is served the
# made-up shop of site/ as http://acme.test, and a second copy of the app that keeps its sessions
# in that home:
#
# - Tern, started with its own config folder (TERN_CONFIG_DIR), session daemon
#   (TERN_DAEMON_SOCKET) and control socket, which also takes the picture (`tern ctl shot`).
# - Rex, copied into the stage under another bundle id (its settings are then its own) and
#   started with the stage's home, where it starts a Rex server of its own. Rex has no picture of
#   its own to give: cua-driver takes the window's.
#
# In the app, a shell types what an agent would: `chrome-pane open`, which opens the pane to the
# right, then `fill` and `select` with the refs the page printed.
set -eu
here=$(cd "$(dirname "$0")" && pwd -P)
repo=$(cd "$here/../.." && pwd -P)
node=$(command -v node)
chrome=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
rex_app=${REX_APP:-/Applications/Rex.app}
tern_exe=${TERN_EXE_PATH:-/Applications/Tern.app/Contents/MacOS/tern}
rex_id=com.superlogical.rex.chromepanestage
hosts=${1:-rex tern}

say() { printf '%s\n' "hosts: $*" >&2; }
die() { say "$*"; exit 1; }

# The processes of a stage: those whose command line runs from it or names it.
stage_pids() { /bin/ps -axwwo pid=,command= | awk -v w="$1/" -v me=$$ '$1 != me && index($0, w) { print $1 }'; }

down() { # down <stage>
  w=$1
  case $w in /tmp/cph.*|/private/tmp/cph.*) ;; *) die "not a stage: $w" ;; esac
  CHROME_PANE_STATE="$w/state" CHROME_PANE_NODE=$node "$repo/bin/chrome-pane" stop >/dev/null 2>&1 || :
  # The app first: Tern starts its daemon again, and Rex its server, while they run.
  if [ -f "$w/app.pid" ]; then
    pid=$(cat "$w/app.pid")
    kill "$pid" 2>/dev/null || :
    i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 40 ]; do i=$((i + 1)); sleep 0.2; done
    kill -9 "$pid" 2>/dev/null || :
  fi
  for f in chrome site; do [ -f "$w/$f.pid" ] && kill "$(cat "$w/$f.pid")" 2>/dev/null || :; done
  sleep 0.5
  pids=$(stage_pids "$w")
  # shellcheck disable=SC2086
  [ -z "$pids" ] || kill $pids 2>/dev/null || :
  sleep 0.5
  pids=$(stage_pids "$w")
  # shellcheck disable=SC2086
  [ -z "$pids" ] || kill -9 $pids 2>/dev/null || :
  if [ -f "$w/rex" ]; then
    defaults delete "$rex_id" >/dev/null 2>&1 || :
    rm -f "$HOME/Library/Preferences/$rex_id.plist"
  fi
  rm -rf "$w"
}

if [ "${1:-}" = --down ]; then down "$(cd "${2:?usage: hosts.sh --down <stage>}" && pwd -P)"; exit 0; fi

# ---------------------------------------------------------------- the stage, whichever the app

# stage: a new stage folder with its home, shell, Chrome and shop; prints it
stage() {
  # Short on purpose: Unix socket paths hold about 104 bytes on macOS.
  w=$(mktemp -d /tmp/cph.XXXXXX)
  w=$(cd "$w" && pwd -P)
  H="$w/home"
  mkdir -p "$H/code/shop" "$w/bin" "$w/state" "$w/log"
  ln -s "$repo/bin/chrome-pane" "$w/bin/chrome-pane"
  # The shells' world: the stage's home and PATH, a plain prompt, and chrome-pane told which
  # Chrome and which state folder are the stage's (it hands both to the pane it opens).
  for f in .zshenv .zprofile; do
    cat >"$H/$f" <<ENV
export HOME='$H' ZDOTDIR='$H' USER=sam LOGNAME=sam
export PATH='$w/bin:/usr/bin:/bin:/usr/sbin:/sbin'
export CHROME_PANE_NODE='$node' CHROME_PANE_STATE='$w/state' CHROME_PANE_USER_DATA_DIR='$w/chrome'
unset HC_TERMINAL_ID HC_TERMINAL_SOCKET HC_SCOPE
ENV
  done
  cat >"$H/.zshrc" <<'RC'
PROMPT="%F{cyan}%~%f %F{magenta}❯%f "
unsetopt beep
setopt no_prompt_sp
RC
  port=$(/usr/bin/python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  /usr/bin/python3 -m http.server "$port" --bind 127.0.0.1 --directory "$here/site" >"$w/log/site.log" 2>&1 &
  echo $! >"$w/site.pid"
  "$chrome" --headless=new --force-device-scale-factor=2 --remote-debugging-port=0 \
    --user-data-dir="$w/chrome" --no-first-run --disable-gpu \
    --host-resolver-rules="MAP acme.test 127.0.0.1:$port" about:blank >"$w/log/chrome.log" 2>&1 &
  echo $! >"$w/chrome.pid"
  i=0
  until [ -s "$w/chrome/DevToolsActivePort" ]; do
    i=$((i + 1)); [ $i -lt 100 ] || die "Chrome did not start"
    sleep 0.1
  done
  echo "$w"
}

# The environment the stage's app is started with: nothing of this computer's own.
app_env() { # app_env <stage>
  echo HOME="$1/home" CFFIXED_USER_HOME="$1/home" USER=sam LOGNAME=sam SHELL=/bin/zsh ZDOTDIR="$1/home" \
    PATH="$1/bin:/usr/bin:/bin:/usr/sbin:/sbin" LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 TMPDIR="$1/" \
    XDG_CONFIG_HOME="$1/home/.config"
}

# scene <send> <screen>: what the shell types. <send> "<text>" types a line and presses Enter;
# <screen> prints the shell's screen, where the refs of the page are read.
scene() {
  $1 'cd ~/code/shop && clear'
  sleep 1
  $1 'chrome-pane open http://acme.test/checkout/'
  i=0
  until $2 | grep -q '^view '; do
    i=$((i + 1)); [ $i -lt 40 ] || die "the pane did not open"
    sleep 0.5
  done
  sleep 2
  # In Rex the page that open prints can be the one of a pane Rex has not given its size yet:
  # the form is below it. A snapshot, as an agent would ask for, has it.
  if ! $2 | grep -q 'combobox'; then
    $1 'chrome-pane snapshot'
    sleep 3
  fi
  name=$($2 | awk 'index($0, "textbox \"Full name\"") { for (i = 1; i <= NF; i++) if ($i ~ /^e[0-9]+$/) { print $i; exit } }')
  delivery=$($2 | awk '/combobox/ { for (i = 1; i <= NF; i++) if ($i ~ /^e[0-9]+$/) { print $i; exit } }')
  [ -n "$name" ] && [ -n "$delivery" ] || die "no refs on the screen"
  $1 "chrome-pane fill $name \"Sam Rivera\""
  sleep 2.5
  $1 "chrome-pane select $delivery \"Express, next day\""
  sleep 3
}

# ---------------------------------------------------------------- Tern

tern_shot() { # tern_shot <out.png>
  w=$(stage)
  [ -n "${KEEP:-}" ] || trap 'down "$w"' EXIT
  cfg="$w/tern"
  mkdir -p "$cfg"
  # What a first start asks, answered: the welcome and the permissions.
  : >"$cfg/welcomed"; : >"$cfg/permissions-offered"
  "$tern_exe" --version 2>/dev/null | awk '{ print $2; exit }' >"$cfg/last-version" || :
  # shellcheck disable=SC2046
  (cd "$w" && exec env -i $(app_env "$w") TERN_CONFIG_DIR="$cfg" TERN_DAEMON_SOCKET="$w/d.sock" \
    "$tern_exe" --control "$w/ctl.sock" "$w/home/code/shop" >"$w/log/tern.log" 2>&1) &
  echo $! >"$w/app.pid"
  t() { env TERN_CONFIG_DIR="$cfg" TERN_DAEMON_SOCKET="$w/d.sock" "$tern_exe" "$@"; }
  ctl() { (cd "$w" && t ctl --control "$w/ctl.sock" "$@"); }
  i=0
  until ctl state >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 60 ] || die "Tern did not start"; sleep 0.25; done
  # The sign-in card, closed.
  i=0
  until ! ctl tree 2>/dev/null | grep -q 'mdl-layer'; do
    ctl click .mdl-x >/dev/null 2>&1 || :
    i=$((i + 1)); [ $i -lt 20 ] || die "Tern kept a dialog open"; sleep 0.5
  done
  ctl resize 1600 1000 >/dev/null
  i=0
  until block=$(t ls --json 2>/dev/null | /usr/bin/python3 -c 'import json, sys
print(json.load(sys.stdin)["sessions"][0]["tabs"][0]["blocks"][0]["id"])' 2>/dev/null); do
    i=$((i + 1)); [ $i -lt 40 ] || die "Tern opened no block"; sleep 0.25
  done
  send() { t send "$block" text "$1" >/dev/null; t send "$block" keys enter >/dev/null; }
  screen() { t capture "$block"; }
  scene send screen
  ctl shot tern >/dev/null
  cp "$w/target/shots/tern/live/tern.png" "$1"
  [ -z "${KEEP:-}" ] || say "Tern's stage is $w: sh $0 --down $w"
}

# ---------------------------------------------------------------- Rex

osa() { /usr/bin/osascript -l JavaScript -e "ObjC.import('AppKit'); $1" 2>/dev/null || :; }
before=
back() { # the front back to the app that had it
  [ -z "$before" ] || osa "\$.NSRunningApplication.runningApplicationWithProcessIdentifier($before).activateWithOptions(2)" >/dev/null
  before=
}

rex_shot() { # rex_shot <out.png>
  command -v cua-driver >/dev/null || die "the Rex picture needs cua-driver, with Screen Recording allowed"
  w=$(stage)
  [ -n "${KEEP:-}" ] || trap 'down "$w"' EXIT
  : >"$w/rex"
  H="$w/home"
  # A copy of the app under another bundle id: its settings are not the real Rex's.
  cp -cR "$rex_app" "$w/Rex.app"
  plist="$w/Rex.app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $rex_id" "$plist"
  /usr/libexec/PlistBuddy -c "Delete :SUFeedURL" "$plist" 2>/dev/null || :
  codesign --force --deep -s - "$w/Rex.app" >/dev/null 2>&1
  defaults write "$rex_id" SUEnableAutomaticChecks -bool false
  defaults write "$rex_id" SUAutomaticallyUpdate -bool false
  # The pane without the keyboard drawn as it is, not faded.
  defaults write "$rex_id" Workspace.inactivePaneFadeMode -string none
  # shellcheck disable=SC2046
  (cd "$H/code/shop" && exec env -i $(app_env "$w") "$w/Rex.app/Contents/MacOS/Rex" >"$w/log/rex.log" 2>&1) &
  pid=$!
  echo $pid >"$w/app.pid"
  sock="$H/Library/Application Support/rex/server.sock"
  i=0
  until [ -S "$sock" ]; do i=$((i + 1)); [ $i -lt 80 ] || die "Rex did not start its server"; sleep 0.25; done
  r() { env HOME="$H" "$H/Library/Application Support/$rex_id/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex" -S "$sock" --autostart=false "$@"; }
  # The scene's session, made before the window: Rex starts a block's shell through login, as
  # the account's own, so the stage's shell is started directly.
  r new shop -c "$H/code/shop" --shell none -- /usr/bin/env HOME="$H" ZDOTDIR="$H" /bin/zsh -l >/dev/null
  # Started this way, Rex opens a window when it is asked to reopen, as a click on its Dock icon
  # does. The copy is asked by its own bundle id.
  i=0
  until /usr/bin/osascript -e "tell application id \"$rex_id\" to reopen" >/dev/null 2>&1; do
    i=$((i + 1)); [ $i -lt 20 ] || die "Rex did not take a reopen"; sleep 0.5
  done
  i=0
  until block=$(r block ls -s shop --json 2>/dev/null | /usr/bin/python3 -c 'import json, sys
print(json.load(sys.stdin)["blocks"][0]["block_id"])' 2>/dev/null); do
    i=$((i + 1)); [ $i -lt 40 ] || die "Rex opened no block"; sleep 0.25
  done
  cua() { cua-driver call "$@"; }
  win=$(cua list_windows "{\"pid\":$pid}" | /usr/bin/python3 -c 'import json, sys
ws = [w for w in json.load(sys.stdin)["windows"] if w.get("layer", 0) == 0]
print(ws[0]["window_id"])')
  cua set_window_frame "{\"pid\":$pid,\"window_id\":$win,\"x\":80,\"y\":60,\"width\":1600,\"height\":1000}" >/dev/null
  # Rex draws, and gives its panes their size, only while its window can be seen: the stage's
  # window is in front for the scene, once nobody has touched the keyboard or mouse for $IDLE
  # seconds, and the front goes back to whatever had it.
  idle=${IDLE:-10}
  said=0
  while [ "$(/usr/sbin/ioreg -c IOHIDSystem | awk '/HIDIdleTime/ { print int($NF / 1000000000); exit }')" -lt "$idle" ]; do
    [ $said = 1 ] || { say "waiting until the keyboard and mouse have been still for ${idle}s"; said=1; }
    sleep 1
  done
  before=$(osa '$.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier')
  [ -n "${KEEP:-}" ] || trap 'back; down "$w"' EXIT
  osa "\$.NSRunningApplication.runningApplicationWithProcessIdentifier($pid).activateWithOptions(2)" >/dev/null
  sleep 1.5
  send() { printf '%s\r' "$1" | r send -b "$block" >/dev/null; }
  screen() { r capture -b "$block"; }
  scene send screen
  cua get_window_state "{\"pid\":$pid,\"window_id\":$win,\"include_accessibility_tree\":false,\"display_only\":true,\"max_image_dimension\":0,\"screenshot_out_file\":\"$1\"}" >/dev/null
  back
  [ -z "${KEEP:-}" ] || say "Rex's stage is $w: sh $0 --down $w"
}

mkdir -p "$repo/docs/media"
for h in $hosts; do
  case $h in
    rex) say "rex.png"; (rex_shot "$repo/docs/media/rex.png") ;;
    tern) say "tern.png"; (tern_shot "$repo/docs/media/tern.png") ;;
    *) die "unknown: $h (rex or tern)" ;;
  esac
done
say "done"
