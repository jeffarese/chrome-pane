# Changelog

## Unreleased

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
