# Changelog

## 0.1.0

First release.

- A viewer for a tab of your own Chrome in any terminal that draws kitty graphics: mouse, keys,
  paste, an address bar, a list of tabs, page dialogs.
- One DevTools connection, approved once in Chrome, shared by every viewer and command over a
  unix socket.
- In Herdr: opens as a pane of the tab it is called from, listed with the agents as Chrome, on
  every computer showing that tab.
- Frames sent pixel for pixel, only the cells that changed, at half size while the whole page
  moves, and never faster than the link carries.
- The agent commands refuse to write into password, one-time-code and card fields, open only
  web addresses, and print what a page wrote without its control codes.
- Commands for agents (`open`, `snapshot`, `find`, `read`, `click`, `fill`, `select`, `wait`,
  `batch`, `shot`...) that answer in a few lines of text, and a skill that teaches them, for
  Claude Code and Codex.
