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
#
# ONLY=preview or ONLY=demo takes one of them.
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
want() { case ",${ONLY:-preview,demo}," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
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
want demo || exit 0
say "demo.gif"
close_panes
old=$(terminal "shop / web" 2>/dev/null || :)
[ -z "$old" ] || hc kill "$old" >/dev/null
herdr-app do tab.new --name web --folder "$HOME/code/shop" >/dev/null
sleep 2
t=$(terminal "shop / web")
film="$w/film"
rm -rf "$film"
sh "$kit/shoot.sh" "$w" --burst "$film" 150 0.1 >/dev/null &
burst=$!
# The typing starts with the burst's first picture: from then on the stage is in front.
until [ -f "$film/001.png" ]; do kill -0 "$burst" 2>/dev/null || { say "the burst ended early"; exit 1; }; sleep 0.1; done
sleep 1
hc send "$t" 'chrome-pane open http://acme.test/checkout/' >/dev/null
sleep 5
hc send "$t" "chrome-pane fill $(ref "$t" '"Full name"') \"Sam Rivera\"" >/dev/null
sleep 2.5
hc send "$t" "chrome-pane select $(ref "$t" combobox) \"Express, next day\"" >/dev/null
sleep 2.5
hc send "$t" "chrome-pane click $(ref "$t" '"Continue to payment"')" >/dev/null
sleep 3
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
# The shell and the pane, without the sidebars and the toast in the corner (FILM_CROP, "w:h:x:y" in pixels, overrides it).
"$ffmpeg_bin" -loglevel error -y -f concat -safe 0 -i "$film/list.txt" \
  -vf "crop=${FILM_CROP:-2400:1800:680:0},scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
  "$repo/docs/media/demo.gif"
say "done"
