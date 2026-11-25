#!/bin/sh
# Takes the README's pictures on a showcase stage (herdr-showcase), with the kit's shoot.sh:
#
#   sh docs/demo/shots.sh            builds a stage, plays the scene (showcase.sh), takes the
#                                    pictures and takes everything down
#   sh docs/demo/shots.sh <stage>    on a stage that has the scene; leaves it up
#
# docs/media/preview.png   the Herdr window: an agent's terminal and, beside it, the pane with the
#                          shop's checkout, as the agent fills it in
# docs/media/demo.gif      a shell and the pane: open, fill, select and click, each command
#                          printing what it changed while the page shows it
# docs/media/tabs.gif      the pane alone, driven from the keyboard: the list of Chrome's tabs,
#                          another tab, an address typed in, back
#
# ONLY=preview, ONLY=demo or ONLY=tabs takes one of them (or several, with commas).
set -eu
here=$(cd "$(dirname "$0")" && pwd -P)
repo=$(cd "$here/../.." && pwd -P)
kit=${SHOWCASE_KIT:-$HOME/workspace/herdr/herdr-showcase}
ffmpeg_bin=$(command -v ffmpeg)
if [ $# -gt 0 ]; then
  w=$(cd "$1" && pwd -P)
else
  w=$(SHOWCASE_VPN=0 sh "$kit/stage.sh")
  trap 'sh "$here/showcase.sh" --down "$w"; sh "$kit/stage.sh" --down "$w"' EXIT
  sh "$here/showcase.sh" "$w" >/dev/null
fi
# shellcheck disable=SC1091
. "$w/env.sh"
mkdir -p "$repo/docs/media"

say() { printf '%s\n' "shots: $*" >&2; }
want() { case ",${ONLY:-preview,demo,tabs}," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
shoot() { sh "$kit/shoot.sh" "$w" "$@" >/dev/null; }
# terminal <where>: the stage terminal shown as that, "shop / dev"
terminal() {
  hc ls --json | /usr/bin/python3 -c 'import json, sys
print(next(t["address"] for t in json.load(sys.stdin)["terminals"] if t.get("where") == sys.argv[1] and t.get("agent") != "chrome"))' "$1"
}
# The panes the scene or an earlier run left, closed: each picture opens its own.
close_panes() {
  hc ls --json --label chrome-pane=1 | /usr/bin/python3 -c 'import json, sys
for t in json.load(sys.stdin)["terminals"]: print(t["address"])' | while read -r t; do hc kill "$t" >/dev/null; done
  sleep 1
}
# shell <name>: a new tab of the shop with a shell, and its terminal
shell() {
  old=$(terminal "shop / $1" 2>/dev/null || :)
  [ -z "$old" ] || hc kill "$old" >/dev/null
  herdr-app do tab.new --name "$1" --folder "$HOME/code/shop" >/dev/null
  sleep 2
  terminal "shop / $1"
}
# film_start: takes pictures of the stage, ten a second, until film_end or for 15 seconds
film_start() {
  film="$w/film"
  rm -rf "$film"
  sh "$kit/shoot.sh" "$w" --burst "$film" 150 0.1 >/dev/null &
  burst=$!
  # What is filmed starts with the burst's first picture: from then on the stage is in front.
  until [ -f "$film/001.png" ]; do kill -0 "$burst" 2>/dev/null || { say "the burst ended early"; exit 1; }; sleep 0.1; done
  sleep 1
}
# film_end <gif> <crop> <palette>: the pictures up to now as a film. The crop, "w:h:x:y" in
# pixels, leaves out the sidebars and the toasts in the corner.
film_end() {
  date +%s >"$film/end"
  wait "$burst"
  # Each frame stays as long as it did on screen (the time to the next one), the last a while.
  /usr/bin/python3 - "$film" >"$film/list.txt" <<'PY'
import os, sys
d = sys.argv[1]
end = int(open(os.path.join(d, "end")).read())
fs = sorted(f for f in os.listdir(d) if f.endswith(".png") and os.path.getmtime(os.path.join(d, f)) <= end + 1)
ts = [os.path.getmtime(os.path.join(d, f)) for f in fs]
for i, f in enumerate(fs):
    print(f"file '{os.path.join(d, f)}'\nduration {(ts[i + 1] - ts[i]) if i + 1 < len(fs) else 2.5:.2f}")
print(f"file '{os.path.join(d, fs[-1])}'")
PY
  "$ffmpeg_bin" -loglevel error -y -f concat -safe 0 -i "$film/list.txt" \
    -vf "crop=$2,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=$3:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" "$1"
}
agent() { HC_TERMINAL_ID=$1 "$w/bin/chrome-pane" "$2" ${3+"$3"} ${4+"$4"}; }
# ref <terminal> <text of a snapshot line>: that control's ref in the pane of the terminal's tab
ref() { agent "$1" snapshot | awk -v want="$2" 'index($0, want) { print $1; exit }'; }

# 1. The first tab: Claude Code at work on the shop's checkout, and the pane it opened.
if want preview; then
  say "preview.png"
  close_panes
  herdr-app do tab.select --index 1 >/dev/null
  t=$(terminal "shop / 1")
  agent "$t" open http://acme.test/checkout/ >/dev/null
  printf '%s\n' "fill $(ref "$t" '"Full name"') \"Sam Rivera\"" "fill $(ref "$t" '"Email"') sam@acme.test" \
    "fill $(ref "$t" '"Address"') \"12 Rua das Flores\"" "fill $(ref "$t" '"City"') Lisbon" "check $(ref "$t" checkbox)" \
    | HC_TERMINAL_ID=$t "$w/bin/chrome-pane" batch >/dev/null
  shoot "$w/warm.png"   # a stage's first picture takes longer than the bar says what the agent does
  agent "$t" select "$(ref "$t" combobox)" "Express, next day" >/dev/null
  shoot "$repo/docs/media/preview.png"
  agent "$t" done >/dev/null
fi

# 2. A tab with a shell, where the commands an agent would run are typed.
if want demo; then
  say "demo.gif"
  close_panes
  t=$(shell web)
  film_start
  hc send "$t" 'chrome-pane open http://acme.test/checkout/' >/dev/null
  sleep 5
  hc send "$t" "chrome-pane fill $(ref "$t" '"Full name"') \"Sam Rivera\"" >/dev/null
  sleep 2.5
  hc send "$t" "chrome-pane select $(ref "$t" combobox) \"Express, next day\"" >/dev/null
  sleep 2.5
  hc send "$t" "chrome-pane click $(ref "$t" '"Continue to payment"')" >/dev/null
  sleep 3
  film_end "$repo/docs/media/demo.gif" "${FILM_CROP:-2400:1800:680:0}" max_colors=96
fi

# 3. The pane alone, as a person uses it: Chrome's other tabs, an address, back.
if want tabs; then
  say "tabs.gif"
  close_panes
  # The Chrome is the scene's own: its tabs are opened and closed straight through its port.
  port=$(head -1 "$w/chrome-profile/DevToolsActivePort")
  # Whatever an earlier run left is closed, and the three pages are opened anew, the checkout first.
  /usr/bin/curl -s "http://127.0.0.1:$port/json/list" | /usr/bin/python3 -c 'import json, sys
for t in json.load(sys.stdin):
    if t["type"] == "page": print(t["id"])' >"$w/run/old-tabs"
  for u in http://acme.test/checkout/ http://acme.test/ http://acme.test/orders/; do
    /usr/bin/curl -s -X PUT "http://127.0.0.1:$port/json/new?$u" >/dev/null
  done
  while read -r id; do /usr/bin/curl -s "http://127.0.0.1:$port/json/close/$id" >/dev/null; done <"$w/run/old-tabs"
  t=$(shell browse)
  hc send "$t" 'chrome-pane --tab checkout' >/dev/null
  sleep 4
  film_start
  hc keys "$t" ctrl+t >/dev/null; sleep 1.6
  # Chrome lists its tabs in an order of its own: the way to the orders is read from the screen.
  steps=$(hc read "$t" | awk '/●/ { at = NR } /Your orders/ { to = NR } END { print to - at }')
  key=down; [ "$steps" -ge 0 ] || { key=up; steps=$((-steps)); }
  while [ "$steps" -gt 0 ]; do hc keys "$t" $key >/dev/null; sleep 0.7; steps=$((steps - 1)); done
  sleep 0.5
  hc keys "$t" enter >/dev/null; sleep 2.6
  hc keys "$t" ctrl+l >/dev/null; sleep 1.2
  # Pasted, with its scheme: an address without one is taken as https, which the scene's server
  # is not, and Herdr has no key for a colon.
  # Not waited for: hc send waits five seconds for a turn that a viewer never starts.
  hc send "$t" 'http://acme.test' >/dev/null &
  sleep 2.8
  hc keys "$t" alt+left >/dev/null; sleep 2.6
  film_end "$repo/docs/media/tabs.gif" "${FILM_CROP:-2400:1300:680:0}" max_colors=128
  hc keys "$t" ctrl+q >/dev/null
fi
say "done"
