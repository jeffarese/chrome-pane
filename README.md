# chrome-pane

Your own Chrome, shown and driven in a terminal pane: the tabs, logins and cookies you already
have, not a second browser. In [Herdr](https://herdr.dev) it opens as a pane of the tab you are
in and is listed with the agents as **Chrome**, on every computer that shows that tab.

```sh
chrome-pane                      # pick one of Chrome's open tabs
chrome-pane example.com          # a new tab at that address
chrome-pane --tab github         # the open tab whose title or address has "github"
chrome-pane tabs                 # list the tabs
```

| Where you run it | What happens |
| --- | --- |
| In a terminal | The tab is shown in that terminal. |
| From a program with no terminal (an agent) inside Herdr, or with `--pane` | It opens as a new pane, to the right, of the Herdr tab it was called from. |

Keys in the viewer: **Ctrl+T** tabs, **Ctrl+L** address, **Ctrl+R** reload, **Alt+←/→** back and
forward, **Ctrl+Q** quit. Everything else, and the mouse, goes to the page. Closing the viewer
leaves the tab open in Chrome.

## For agents

An agent does not look at the picture. It asks for the page as text, acts on a control by its
ref, and is told only what changed, while you watch the same tab in the pane and can take over
at any moment.

```sh
chrome-pane open example.com/login   # opens the pane if this Herdr tab has none; prints the page
```

```
Sign in
https://example.com/login
view 800x680 at 0 of 680 px · 4 of 4 controls in view (0 above, 0 below)
e30 main
 e31 h1 "Sign in"
 e12 textbox "Email"
 e13 textbox "Password"
 e14 button "Continue"
 e15 link "Forgot your password?"
```

```sh
chrome-pane fill e12 ada@example.com
```

```
filled e12 "Email"
~ e12 textbox "Email" ="ada@example.com"
```

| Command | What it prints |
| --- | --- |
| `snapshot` | The controls in view under their sections and headings, each with a ref. `--all` the whole page, `--in <ref>` one part, `--text` with the text, `--urls` with the links' addresses. |
| `find <text>` | The elements that have it, and whether each is in view, above or below. |
| `read [ref\|css]` | The main text, or one part's. `--table` a table as rows. |
| `click`, `hover`, `check`, `uncheck <ref>`; `fill <ref> <text>`; `select <ref> <option>`; `type <text>`; `press <keys>`; `scroll [down\|up\|top\|bottom\|ref]` | What it did, then what changed in the page's controls and messages: `~` changed, `-` gone, `+` new. A new page prints its snapshot. |
| `wait <text>` | When it is on the page. Or `--gone <text>`, `--url <part>`, `--idle`; `--timeout <s>`. |
| `batch` | Several actions, one a line on its input, and one answer. |
| `back`, `forward`, `reload`, `open <url>` | The page it lands on. |
| `shot` | The path of a picture of the view, and what it costs to look at. |
| `dialog accept\|dismiss` | Answers the page's alert or question. |
| `eval <js>` | The value. Not among the commands the skill lets an agent run unasked. |
| `done` | Nothing: the pane's bar stops saying an agent is at work. |

An agent's command acts on the tab shown by the pane of the Herdr tab it runs in. While it does,
the pane's bar says what it is doing and Herdr lists the pane as working.

A ref is a letter and Chrome's own number for the element: it stays good for as long as the
element lives, and the letter changes with every page loaded, so a ref from an earlier page is
refused (with the page there is now) instead of landing on something else.

What an agent may not do: open anything but http and https addresses; fill or type into a
password, one-time-code or card field (you type those in the pane); read a password's value.

**The skill.** `chrome-pane skill install` (which `./install.sh` runs) links
`skills/chrome-pane` into `~/.claude/skills`, `~/.agents/skills` and `~/.codex/skills`, where
those folders' owners exist. `chrome-pane skill` prints it, for any other agent's instructions.
In Codex the commands need to run outside its sandbox, which blocks unix sockets.

## Set up

It needs Node 22 or newer, a terminal that draws images with the kitty graphics protocol (Herdr,
Ghostty, kitty), and a Chrome recent enough to have `chrome://inspect/#remote-debugging`.

```sh
./install.sh        # links ~/.local/bin/chrome-pane; in Herdr, adds the name and icon; links the agents' skill
```

Then, once, in Chrome: open `chrome://inspect/#remote-debugging` and turn remote debugging on.
The first time a viewer opens, **Chrome asks you to allow the connection**: accept it, on the
computer Chrome runs on. chrome-pane keeps that one connection (the *bridge*) open until Chrome
quits, so it asks once per Chrome start. `chrome-pane stop` ends it.

On another computer you watch from, only Herdr's name and icon are needed (the Herdr app that
draws the window decides them): copy this folder there and run `bin/chrome-pane herdr`, or add
the `chrome` entry to `~/.config/herdr-app/programs.json` by hand.

## From another computer

Chrome runs on one computer; you sit at another whose Herdr shows the first one's terminals. Run
`chrome-pane` in a session on the first one (or let its agent run it): the viewer is a terminal
there, next to Chrome, and Herdr shows it on the computer you are at like any other pane.

What travels is pictures, through Herdr's connection, so the viewer sends as little of them as
it can:

- **Only what changed.** Chrome hands over every frame whole. The viewer compares it with what
  is on screen and sends the cells that differ as a small picture laid over the big one: a row
  lighting up under the mouse in a Retina-size Gmail pane is 1 to 90 KB instead of 1.7 MB.
  `--whole` turns that off.
- **Half the pixels while the whole page moves.** A scroll or a film changes everything, so by
  default (`--quality auto`) the viewer asks for half-size frames then, and for the full-size
  one again when the page rests. `--quality fast` never asks for full size; `--quality sharp`
  always does.
- **No more than the link carries.** After sending a picture the viewer waits for as long as
  it takes 3 MB a second to carry it (`--rate <MB a second>`; lower it over a slow link). A
  link fed more than it carries falls behind, and the pane on the other computer goes blank
  while it catches up.

A frame equal to the last one is not sent. When Chrome's window is on a screen of one pixel a
point, full size has no more pixels than half, and the picture stays as soft as that screen is.

## How it works

```
 Chrome ◀─ one DevTools connection ─▶ bridge ◀─ unix socket ─▶ viewer ◀─ terminal ─▶ you
                                      (per machine)             (one per pane)
```

- **Bridge** (`src/bridge.mjs`). Holds the one connection Chrome approved and shares it: viewers
  send DevTools messages over `~/.local/state/chrome-pane/bridge.sock` (your user only). A viewer
  starts it when there is none. When a viewer goes, the bridge detaches what it attached, which
  gives the tab its own size back.
- **Viewer** (`src/viewer.mjs`). Asks Chrome for a screencast of the tab, sized to the pane, and
  draws each frame with the kitty graphics protocol. Mouse reports and keys from the terminal
  become DevTools input events. It reports itself to Herdr as `chrome` (OSC 7501) with the page's
  title, which is what lists it with the agents.
- **Pane** (`src/herdr.mjs`). A Herdr terminal labelled with a space and a tab shows up in that
  tab on every Herdr window looking at its machine. So the viewer is started with `hc run` and
  the labels of the terminal it was called from.
- **Agent commands** (`src/agent.mjs`). Each is a process of its own that attaches a second
  DevTools session to the pane's tab, through the bridge, and detaches when done. It reads the
  accessibility tree and the elements' boxes, and clicks with the same input events the viewer
  sends. Viewers and commands tell each other what they need through small files in the state
  folder (`src/panes.mjs`): which tab a pane shows, what an agent is doing to it, the dialog a
  page stopped at. The viewer answers dialogs for agents, because Chrome lets only a session
  that saw a dialog open answer it.

## Limits

- **It is the real tab.** While a viewer shows it, the page has the pane's size, in Chrome too
  (`--mirror` keeps Chrome's size and scales the picture instead).
- **Chrome draws only the tab in front** of a window it can see. A tab opened here is brought to
  the front in Chrome once; if you later switch tabs in Chrome, the viewer pauses and says so,
  and a click or key in it brings the tab forward again (`--no-front` never does). Two viewers on
  two tabs of the same Chrome window take turns for the same reason.
- Chrome may show that it is being debugged while the bridge is connected.
- The viewer never asks Chrome for a screenshot of the tab: while Chrome takes one of a page whose
  size was set from outside, it changes how the page takes mouse events, and clicks get lost.
- Native menus (a `<select>`'s list, the file picker, right-click menus) are drawn by macOS, not
  the page, so they don't appear. In Herdr, right-click opens Herdr's own menu.
- Cmd shortcuts belong to the terminal app; Ctrl+Q, Ctrl+C, Ctrl+T, Ctrl+L and Ctrl+R belong to
  the viewer. No sound, and video is a slideshow.
- The debugging port gives whoever reaches it your signed-in Chrome. The bridge listens on a
  socket only you can open and never on the network.

## Develop

```sh
npm test                 # the input parser, key mapping, layout and the agent commands' arguments
sh test/e2e/run.sh       # the viewer and an agent's commands against a headless Chrome with a throwaway profile
CHROME_PANE_DEBUG=/tmp/cp.log chrome-pane …   # what the terminal and Chrome send the viewer
```
