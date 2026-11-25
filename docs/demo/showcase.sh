#!/bin/sh
# chrome-pane's scene for the pictures in the README, on a showcase stage (herdr-showcase: a
# second Herdr app with a made-up world):
#
#   w=$(SHOWCASE_VPN=0 sh ~/workspace/herdr/herdr-showcase/stage.sh)
#   sh docs/demo/showcase.sh "$w"            # the scene
#   sh docs/demo/showcase.sh --down "$w"     # stops what the scene started, before stage.sh --down
#
# Nobody's own Chrome is in it: the scene starts a headless Chrome with an empty profile inside
# the stage's folder, serves the made-up shop of site/ to it as http://acme.test, and opens
# chrome-pane as a pane of the stage's first tab, beside its agent.
set -eu
down=
[ "${1:-}" = --down ] && { down=1; shift; }
w=$(cd "${1:?usage: showcase.sh [--down] <stage folder>}" && pwd -P)
here=$(cd "$(dirname "$0")" && pwd -P)
repo=$(cd "$here/../.." && pwd -P)
# The stage's own node is a stand-in: keep the real one, found before its PATH is.
node=$(command -v node)
chrome=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}

if [ -n "$down" ]; then
  (
    # shellcheck disable=SC1091
    . "$w/env.sh"
    CHROME_PANE_NODE=$node "$repo/bin/chrome-pane" stop >/dev/null 2>&1 || :
  )
  for f in "$w/run/chrome-pane-chrome.pid" "$w/run/chrome-pane-site.pid"; do
    [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || :
    rm -f "$f"
  done
  exit 0
fi

# Before the stage's environment: a Chrome started with the stage's HOME never loads a page.
mkdir -p "$w/run" "$w/log"
port=$(/usr/bin/python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
/usr/bin/python3 -m http.server "$port" --bind 127.0.0.1 --directory "$here/site" >"$w/log/chrome-pane-site.log" 2>&1 &
echo $! >"$w/run/chrome-pane-site.pid"
"$chrome" --headless=new --force-device-scale-factor=2 --remote-debugging-port=0 \
  --user-data-dir="$w/chrome-profile" --no-first-run --disable-gpu \
  --host-resolver-rules="MAP acme.test 127.0.0.1:$port" about:blank >"$w/log/chrome-pane-chrome.log" 2>&1 &
echo $! >"$w/run/chrome-pane-chrome.pid"
i=0
until [ -s "$w/chrome-profile/DevToolsActivePort" ]; do
  i=$((i + 1)); [ $i -lt 100 ] || { echo "showcase: Chrome did not start" >&2; exit 1; }
  sleep 0.1
done

# shellcheck disable=SC1091
. "$w/env.sh"
# Where chrome-pane looks for Chrome's debugging port: the stage's home has no Chrome of its own.
mkdir -p "$HOME/Library/Application Support/Google/Chrome"
cp "$w/chrome-profile/DevToolsActivePort" "$HOME/Library/Application Support/Google/Chrome/"

export CHROME_PANE_NODE="$node"
# For the stage's shells, whose own node is the stand-in.
printf '#!/bin/sh\nCHROME_PANE_NODE=%s exec %s/bin/chrome-pane "$@"\n' "$node" "$repo" >"$w/bin/chrome-pane"
chmod +x "$w/bin/chrome-pane"
"$repo/bin/chrome-pane" herdr >/dev/null
# As the agent of the stage's first tab would: the pane opens beside it.
HC_TERMINAL_ID=${SHOWCASE_TERMINAL:-t1} "$repo/bin/chrome-pane" open http://acme.test/checkout/
