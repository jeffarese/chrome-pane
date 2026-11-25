# Changelog

## Unreleased

- The pane's bar is a browser's toolbar. It is drawn in the terminal's own colours instead of
  reverse video. Back and forward are dim when there is nowhere to go, reload is stop while the
  page loads, and the mouse over a button says what it does. The address is a field that opens
  selected and is edited with the arrows, Home, End and the word keys; the site stands out in
  it and `https://` is left out. The number of Chrome's tabs is a button that lists them, and a
  dialog or a reload that would send a form again has buttons for its answers. A narrow pane
  drops the key hints before it cuts the address.
- `chrome-pane bar` prints what the bar says as JSON, and `chrome-pane bar <action>` does one of
  its actions (`back`, `forward`, `reload`, `stop`, `go <address>`, `tabs`, `dialog-ok`…) with
  no pane to click in; `--in` names another terminal's pane.
- In Herdr, the pane's header can draw the controls with the app's own buttons and text field,
  and the viewer then draws no bar. `chrome-pane herdr` installs a pane header (`chrome-pane`)
  for a layout to use, and `chrome-pane herdr --into <mod>` gives a header mod of your own the
  piece that draws them. `--bar` keeps the viewer's own bar.
- With that header, Chrome's tabs are a list the app draws over the window (`chrome-pane-tabs`),
  from the header's tabs button or Ctrl+T in the pane: type to find a tab, Enter or a click
  shows it, × closes it in Chrome after asking, and what was typed opens in a new tab. The
  header's buttons are all on its left, clear of the buttons a header shows on hover.
- `chrome-pane bar show <id>`, `close-tab <id>` and `new [address]` act on Chrome's other
  tabs, by the ids of `chrome-pane tabs --json`.
- In Rex and Tern, as in Herdr: an agent's `chrome-pane open` (or `--pane`) opens the viewer as
  a pane beside the caller, in the same tab, and later commands from that tab use it. Each
  multiplexer is asked in its own words (`rex split`, `tern split`, `hc run`), through one
  adapter each in `src/hosts.mjs`. `CHROME_PANE_HOST` says which one when a terminal is inside
  two.
- A reload no longer sends a form again unasked. Chrome reloads the answer to a sent form (a
  payment, an order) by sending the form again, and does not ask when the reload comes through
  the debugging connection. Ctrl+R and ↻ in the pane now ask first, and an agent's `reload`
  refuses unless it is `reload --resend`.
- Alt+← and Alt+→ in a field that is being typed in move by a word, as Option and an arrow do
  on a Mac, instead of going back and forward out of a half-filled form.
- A snapshot no longer lists the options of a list that is out of view.
- A benchmark (`bench/`): agents do eight browser tasks on a made-up shop with chrome-pane,
  Claude in Chrome, cua, agent-browser and terminal-browser, and the shop's server checks each
  outcome. `--latency <ms>` makes the shop answer late, as a real server does. The README has
  the figures of 25 November 2026. It reports time, tokens,
  cost and failures by method, task and tool, and compares two runs. `bench/micro.mjs` times
  chrome-pane's own commands with no model.
- Agents get a task done in fewer commands, and each command is faster. On the benchmark
  (Opus 5.5 at low effort, 8 tasks) the median run went from 11.5 s and 36k input tokens in 5
  model calls to 7.8 s and 23k in 3, still with every run passing:
  - A control can be named instead of given by its ref (`click "Next"`,
    `fill "Email" ada@example.com`) when no other control has the name; a `batch` written
    with names goes on across pages. A name two controls have is refused with the list of
    them and what each is under, and a click takes a control's whole name, never a part of it.
  - An action is over when the page has taken it in: the page it loads, the answers it asked
    the network for (8 s at most; less for other sites') and the changes those make, instead
    of a fixed 350 ms. A click takes about 0.27 s, and one on "Generate report" comes back
    with the report.
    Tried on real sites (GitHub, Wikipedia, YouTube, Amazon, MDN, Bootstrap's docs), the
    wait learned what a test site on this computer does not show: a box that fades in or out
    is a change still going on; what a page asks for once it has its answer (GitHub fetches
    the issues of a list ahead) is waited for 0.7 s, not 8; nor are a worker's own script, an
    extension's requests, or those of the page before this one.
  - What an action prints is its outcome: the page's new text too, not only its controls and
    messages, and `dialog accept|dismiss` prints what the page did with the answer. A dialog
    or a list of suggestions that appears comes with the controls it holds.
  - Controls a page makes of plain elements, with no role for assistive tools, are listed as
    `clickable`.
  - `find` gives a table's cell with its row, a named section with its controls, and
    look-alikes with what each is under.
  - A command whose reader stops early (`| head -3`) no longer stops halfway through its
    actions.
  - The skill no longer asks for `chrome-pane done` at the end (the bar clears itself after
    5 s), and tells agents to join commands with `&&` and to trust what an action prints.
- The README shows the pane in Rex and in Tern (`docs/demo/hosts.sh` takes those pictures, each
  on a throwaway copy of the app), and its Install section goes step by step: the PATH an agent
  needs, a first try, what each terminal needs, updating, removing, and the messages a first
  start can give.

## 0.1.0

First release.

- A viewer for a tab of your own Chrome in any terminal that draws kitty graphics: mouse, keys,
  paste, an address bar, a list of tabs, page dialogs.
- One DevTools connection, approved once in Chrome, shared by every viewer and command over a
  unix socket.
- In Herdr: opens as a pane of the tab it is called from, listed with the agents as Chrome, on
  every computer showing that tab.
- Frames sent pixel for pixel, only the cells that changed, at half size while the whole page
  moves, and never faster than the screens showing the pane take them: each screen says when
  it has drawn a picture, and one that lost the page's picture is sent it again.
- The pane's bar says what an agent is doing in it. Herdr is not told the pane is working:
  it reads a full-screen program whose turn has ended by scrolling it, which moved the page
  and left it black.
- The agent commands refuse to write into password, one-time-code and card fields, open only
  web addresses, and print what a page wrote without its control codes.
- Commands for agents (`open`, `snapshot`, `find`, `read`, `click`, `fill`, `select`, `wait`,
  `batch`, `shot`...) that answer in a few lines of text, and a skill that teaches them, for
  Claude Code and Codex.
