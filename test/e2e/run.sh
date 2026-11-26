#!/bin/sh
# End-to-end test: a headless Chrome with a throwaway profile, the bridge, and the viewer in a
# pty that plays the terminal (answers its queries, clicks, types, pastes, navigates, quits);
# then an agent's commands beside that viewer, on pages of a web server of the test's own.
# It never touches your own Chrome. Needs Chrome or Chromium installed (CHROME names another).
set -eu
here=$(cd "$(dirname "$0")" && pwd -P)
root=$(cd "$here/../.." && pwd -P)
chrome=${CHROME:-}
if [ -z "$chrome" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" google-chrome google-chrome-stable chromium chromium-browser; do
    c=$(command -v "$c" 2>/dev/null) && { chrome=$c; break; }
  done
fi
[ -n "$chrome" ] && [ -x "$chrome" ] || { echo "no Chrome found (set CHROME to its program)" >&2; exit 2; }
# Short, because a unix socket's path is limited to about 100 characters.
tmp=$(mktemp -d "${TMPDIR:-/tmp}/cpt.XXXXXX")
export CHROME_PANE_STATE="$tmp/state"
pids=
# Two pixels a point, as on a Retina screen: only then has a full-size frame more pixels than a
# half-size one. (On an ordinary screen Chrome has no more to give, whatever the pane asks.)
start_chrome() { # start_chrome <profile folder>
  "$chrome" --headless=new --force-device-scale-factor=2 --remote-debugging-port=0 --user-data-dir="$1" --no-first-run --disable-gpu about:blank >"$1.log" 2>&1 &
  pids="$pids $!"
  i=0
  until [ -s "$1/DevToolsActivePort" ]; do i=$((i + 1)); [ $i -lt 100 ] || { echo "Chrome did not start" >&2; exit 2; }; sleep 0.1; done
}
cleanup() {
  for state in "$tmp/state" "$tmp/zstate" "$tmp/hstate"; do CHROME_PANE_STATE="$state" "$root/bin/chrome-pane" stop >/dev/null 2>&1 || :; done
  for pid in $pids; do kill "$pid" 2>/dev/null || :; wait "$pid" 2>/dev/null || :; done
  rm -rf "$tmp"
}
trap cleanup EXIT
start_chrome "$tmp/profile"
# Twice: an ordinary screen (every frame at full size), then a Retina one (half size while the
# page moves, the sharp picture once it rests).
status=0
for cell in 10x20 16x34; do
  echo "== cells of $cell pixels"
  /usr/bin/python3 "$here/viewer_test.py" "$root/bin/chrome-pane" "$tmp/profile" "$CHROME_PANE_STATE" "$cell" || status=1
done
# Once more with every page at 80%, as someone's Chrome may have it: a second Chrome, because the
# zoom comes from the profile (the level is the zoom's logarithm in base 1.2).
mkdir -p "$tmp/zprofile/Default"
printf '%s' '{"partition":{"default_zoom_level":{"x":-1.2239010857415449}}}' >"$tmp/zprofile/Default/Preferences"
start_chrome "$tmp/zprofile"
echo "== cells of 16x34 pixels, pages at 80%"
/usr/bin/python3 "$here/viewer_test.py" "$root/bin/chrome-pane" "$tmp/zprofile" "$tmp/zstate" 16x34 0.8 || status=1
echo "== an agent's commands"
/usr/bin/python3 "$here/agent_test.py" "$root/bin/chrome-pane" "$tmp/profile" "$CHROME_PANE_STATE" 16x34 || status=1
echo "== an agent's commands, pages at 80%"
/usr/bin/python3 "$here/agent_test.py" "$root/bin/chrome-pane" "$tmp/zprofile" "$tmp/zstate" 16x34 0.8 || status=1
echo "== an agent's commands with no pane: a hidden tab"
/usr/bin/python3 "$here/hidden_test.py" "$root/bin/chrome-pane" "$tmp/profile" "$tmp/hstate" || status=1
exit $status
