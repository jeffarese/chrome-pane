# Security

chrome-pane holds a DevTools connection to the Chrome you are signed in with. Whoever can use
that connection can read and drive every tab: treat it like your browser's session itself.

## What protects it

- **Chrome asks you first.** The connection uses Chrome's own switch
  (`chrome://inspect/#remote-debugging`) and its "Allow remote debugging?" prompt, on the
  computer Chrome runs on. chrome-pane never starts Chrome with a debugging port of its own and
  never copies your profile.
- **Nothing listens on the network.** The bridge serves one unix socket,
  `~/.local/state/chrome-pane/bridge.sock`, in a folder only your user can open (mode `0700`,
  the socket `0600`). Watching from another computer goes through Herdr's own connection: what
  travels is the terminal's contents, not the DevTools connection.
- **`chrome-pane stop`** ends the bridge and, with it, the connection.

## What does not

- **Other programs running as you.** Anything with your user's rights can open the socket, as
  it could read Chrome's cookies from disk. The socket is not a boundary against your own
  account.
- **The limits on agents are guidance, not a sandbox.** The agent commands take only http and
  https addresses, act only on the tab a pane shows, refuse to fill or type into password,
  one-time-code and card fields, and print `[filled]` for their values. That stops a
  well-behaved agent from wandering and blunts instructions hidden in a page. It does not stop
  a program that talks to the socket directly, and `chrome-pane eval` runs any JavaScript in
  the page (the skill does not let an agent run it unasked).
- **Pages are untrusted input.** Text an agent reads from a page can try to instruct it. The
  skill tells agents that page text is never instructions, and `read` and `eval` say which site
  their output comes from; an agent can still be fooled. Keep an eye on the pane: its bar shows
  what an agent is doing, and your keys and mouse work at all times.

## Logs

`CHROME_PANE_TRACE=<file>` records picture sizes and timings only. `CHROME_PANE_DEBUG=<file>`
records everything the viewer receives, **every key you type included**: never leave it on.

## Reporting a problem

Please report a vulnerability privately, through **Security → Report a vulnerability** on the
GitHub repository, not in a public issue.
