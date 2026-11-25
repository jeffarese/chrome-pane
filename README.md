# chrome-pane

Your own Chrome in a terminal pane: the tabs, logins and cookies you already have, not a second
browser. You see the page and use it with the mouse and the keyboard; the agent working beside
you drives the same tab with short text commands, and you watch it happen.

![A Herdr window. In the middle, Claude Code at work on "Speed up the checkout page". To its right, the Chrome pane: a bar that says "Agent: select e6 Express, next day", and under it the checkout page of a made-up tea shop, drawn as in a browser, with the order's total, a form filled in with a name, an email, an address and a city, the delivery set to Express and a ticked gift-wrap box. The sessions sidebar on the left lists the pane as "Checkout · Acme Shop" with Chrome's icon, among the agents at work](docs/media/preview.png)

*In [Herdr](https://herdr.dev), the pane opens beside the agent that asked for it and is listed
with the agents. The shop, the sessions and the people in this picture are made up.*

Terminal browsers and agent browsers start a browser of their own: empty, signed in to nothing.
The page you want an agent's help with is usually behind a login you already have. chrome-pane
connects to the Chrome you use, through the remote debugging Chrome itself offers and asks you
to allow, and shows one of its tabs where you and your agents already are.

## Highlights

- **Your real Chrome.** No copied profile, no exported cookies, no extension. Chrome asks you
  once per start whether to allow the connection.
- **A browser in the pane.** The page is drawn pixel for pixel with the kitty graphics protocol.
  Click, scroll, type, paste, go back, pick another tab, type an address.
- **Agents read text, not pictures.** `chrome-pane snapshot` is the page's controls as a few
  lines, each with a ref. An action answers with only what changed. No screenshot per step.
- **You stay in charge.** The pane's bar says what an agent is doing while it does it. Your
  mouse and keys work at all times. The agent commands refuse to type into password, code and
  card fields, and open only web addresses.
- **From another computer.** Sit at one computer and watch a tab of the Chrome on another,
  through Herdr: the viewer sends only the cells of the picture that changed.
- **Nothing to build.** Node and nothing else: no dependencies, no browser download.

## What you need

- **Chrome 144 or newer** (or another Chromium browser that has
  `chrome://inspect/#remote-debugging`).
- **Node 22 or newer.**
- **A terminal that draws pictures with the kitty graphics protocol** and reports the mouse in
  pixels: [Herdr](https://herdr.dev), Ghostty, kitty.
- macOS. On Linux the unit tests pass and the browsers' folders are known, but it has not been
  used there yet. Windows is not supported.

## Install

```sh
git clone https://github.com/jeffarese/chrome-pane && cd chrome-pane && ./install.sh
```

That links `~/.local/bin/chrome-pane` to the clone, gives the Herdr app here the pane's name and
icon, and links the agents' skill where Claude Code and Codex look for skills. `./install.sh
--remove` takes all of it out.

Then, once, in Chrome: open `chrome://inspect/#remote-debugging` and turn remote debugging on.
The first time a viewer opens, **Chrome asks you to allow the connection**: accept it, on the
computer Chrome runs on. chrome-pane keeps that one connection open until Chrome quits, so
Chrome asks once per start. `chrome-pane stop` ends it.

## Use

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

| Key | |
| --- | --- |
| **Ctrl+T** | The list of Chrome's tabs: show another, open a new one, close one (it asks first) |
| **Ctrl+L** | Type an address, or words to search for |
| **Ctrl+R** | Reload |
| **Alt+←**, **Alt+→** | Back, forward |
| **Ctrl+A**, **Ctrl+C**, **Ctrl+X**, **Ctrl+V**, **Ctrl+Z** | Select all, copy, cut, paste and undo in the page. On a Mac too, where Chrome has them on Cmd, which a terminal keeps for itself |
| **Ctrl+Q** | Quit the viewer. The tab stays open in Chrome |

Everything else, and the mouse, goes to the page. Copy and paste use the clipboard of the
computer Chrome runs on; your terminal's own paste types into the page from yours. A window
the page opens (a sign-in, a link in a new tab) is shown in its place, and the pane returns to
the page when that window closes. The bar's `‹`, `›` and `↻` take clicks, and a
click on the address edits it. `chrome-pane --help` lists the options.

## For agents

An agent does not look at the picture. It asks for the page as text, acts on a control by its
ref, and is told only what changed, while you watch the same tab in the pane and can take over
at any moment.

![A shell on the left, the Chrome pane on the right. "chrome-pane open http://acme.test/checkout/" opens the pane with the shop's checkout and prints the page's controls, each with a ref. "chrome-pane fill e2 Sam Rivera" writes the name into the form and prints the one line that changed. "chrome-pane select e6 Express, next day" changes the delivery and the order's total. "chrome-pane click" on Continue to payment prints the page's new message: Still needed: email, address, city](docs/media/demo.gif)

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
| `open <url>`, `back`, `forward`, `reload` | The page it lands on. |
| `snapshot` | The controls in view under their sections and headings, each with a ref. `--all` the whole page, `--in <ref>` one part, `--text` with the text, `--urls` with the links' addresses. |
| `find <text>` | The elements that have it, and whether each is in view, above or below. |
| `read [ref\|css]` | The main text, or one part's. `--table` a table as rows. |
| `click`, `hover`, `check`, `uncheck <ref>`; `fill <ref> <text>`; `select <ref> <option>`; `type <text>`; `press <keys>`; `scroll [down\|up\|top\|bottom\|ref]` | What it did, then what changed in the page's controls and messages: `~` changed, `-` gone, `+` new. A new page prints its snapshot. |
| `wait <text>` | When it is on the page. Or `--gone <text>`, `--url <part>`, `--idle`; `--timeout <s>`. |
| `batch` | Several actions, one a line on its input, and one answer. |
| `shot` | The path of a picture of the view, and what it costs to look at. `--out <new .jpg file>` puts it elsewhere. |
| `dialog accept\|dismiss` | Answers the page's alert or question. |
| `eval <js>` | The value. Not among the commands the skill lets an agent run unasked. |
| `done` | Nothing: the pane's bar stops saying an agent is at work. |

An agent's command acts on the tab shown by the pane of the Herdr tab it runs in. While it does,
the pane's bar says what it is doing and Herdr lists the pane as working.

A ref is a letter and Chrome's own number for the element: it stays good for as long as the
element lives, and the letter changes with every page loaded, so a ref from an earlier page is
refused (with the page there is now) instead of landing on something else.

What the commands refuse: any address that is not http or https; writing into a password,
one-time-code or card field with `fill`, `type` or `press` (you type those in the pane), or
into a field inside another site's frame, where a payment form usually is; printing such a
field's value; writing a picture over a file. They know such a field by its type, its
`autocomplete` or its name, so a page that hides what a field is can get past them, and `eval`
runs whatever JavaScript it is given: these are limits for an agent that means well, not a
wall. [SECURITY.md](SECURITY.md) says what is and is not protected.

**The skill.** `chrome-pane skill install` (which `./install.sh` runs) links
`skills/chrome-pane` into `~/.claude/skills`, `~/.agents/skills` and `~/.codex/skills`, for
those of `~/.claude`, `~/.agents` and `~/.codex` that exist. `chrome-pane skill` prints it, for
any other agent's instructions. In Codex the commands need to run outside its sandbox, which
blocks unix sockets.

## From another computer

Chrome runs on one computer; you sit at another whose Herdr shows the first one's terminals. Run
`chrome-pane` in a session on the first one (or let its agent run it): the viewer is a terminal
there, next to Chrome, and Herdr shows it on the computer you are at like any other pane.

On the computer you watch from, only Herdr's name and icon for the pane are needed (the Herdr
app that draws the window decides them): clone this there and run `bin/chrome-pane herdr`.

What travels is pictures, through Herdr's connection, so the viewer sends as little of them as
it can:

- **Only what changed.** Chrome hands over every frame whole. The viewer compares it with what
  is on screen and sends the cells that differ as a small picture laid over the big one: a row
  lighting up under the mouse in a large Retina pane is 1 to 90 KB instead of 1.7 MB.
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

## Security

The connection chrome-pane holds can read and drive every tab of the Chrome you are signed in
with. In short:

- Chrome asks you before it allows the connection, and chrome-pane never starts Chrome with a
  debugging port of its own.
- Nothing listens on the network: the connection is shared over one unix socket that only your
  user can open.
- The limits on agents (web addresses only, no secrets, the pane's tab only) are guidance for
  well-behaved agents, not a sandbox, and a page's text can try to instruct an agent that reads
  it. Watch the pane.

[SECURITY.md](SECURITY.md) has the whole of it, and how to report a problem.

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
- Native menus (a `<select>`'s list, the file picker, right-click menus) are drawn by the
  system, not the page, so they don't appear. An agent's `select` works all the same. In Herdr,
  right-click opens Herdr's own menu.
- Cmd shortcuts belong to the terminal app; Ctrl+Q, Ctrl+T, Ctrl+L and Ctrl+R belong to the
  viewer. No sound, and video is a slideshow.
- An agent's `snapshot` lists what the page marks as a control. Something clickable that is only
  a styled `<div>` is not in it: `find <text>` gives its ref.

## Develop

```sh
npm test                 # the input parser, keys, layout, pictures and the agent commands' arguments
sh test/e2e/run.sh       # the viewer and an agent's commands against a headless Chrome with a throwaway profile
```

The end-to-end tests start their own headless Chrome with an empty profile and never touch
yours.

`CHROME_PANE_TRACE=<file>` makes a viewer write the sizes and timings of the pictures it sends.
`CHROME_PANE_DEBUG=<file>` makes it write everything it receives, **every key typed included**:
for a test page only.

`docs/demo` has the made-up shop and the scripts behind the pictures above.

## License

[MIT](LICENSE). Chrome is a trademark of Google LLC; chrome-pane is not affiliated with or
endorsed by Google. The pane's icon in Herdr is taken from the Chrome installed on your
computer: this repository carries none of Google's artwork.
