# The pictures in the README

Nobody's own Chrome is in them. They are taken on a showcase stage (a second Herdr app with a
made-up world, from the `herdr-showcase` kit), with a headless Chrome that has an empty profile
and is served the made-up shop of `site/` as `http://acme.test`.

```sh
sh docs/demo/shots.sh          # builds a stage, takes docs/media/preview.png, demo.gif, tabs.gif and tabs-list.png, takes it all down
```

- `site/` is the shop: a checkout page whose total and messages change as its form does, a
  front page and a page of orders.
- `showcase.sh <stage>` starts the Chrome and the shop's server, and opens the pane beside the
  stage's first agent. `showcase.sh --down <stage>` stops what it started.
- `shots.sh [stage]` takes the pictures. The commands in `demo.gif` are typed into a real shell
  and their output is what chrome-pane printed; the keys in `tabs.gif` are pressed in a real
  viewer. `ONLY=tabs` takes one of them.
- The stage's pane header is the kit's (`pane-head`, from its repository), which draws Chrome's
  controls with `chrome-bar.js`: `preview.png`, `demo.gif` and `tabs-list.png` show them, and
  `tabs-list.png` the app's list of tabs. `tabs.gif` runs the viewer with `--bar`, for the bar
  and the list every other terminal gets.

The pictures of Rex and Tern have no kit: `hosts.sh` builds a smaller stage of its own for
each, a folder `/tmp/cph.XXXXXX` with a home, the same headless Chrome and shop, and a second
copy of the app that keeps its sessions there.

```sh
sh docs/demo/hosts.sh          # docs/media/rex.png and tern.png; `hosts.sh tern` takes one
```

- Tern is started with its own config folder, session daemon and control socket, and takes the
  picture itself (`tern ctl shot`).
- Rex is copied into the stage under another bundle id, so its settings are not your Rex's, and
  started with the stage's home, where it runs a Rex server of its own. Rex starts a block's
  shell through `login`, as your account, so the scene's session runs the stage's shell
  directly. Rex draws only while its window can be seen: after 10 seconds with nobody at the
  keyboard or mouse (`IDLE=<s>`), the stage's window comes to the front for the scene, about 20
  seconds, and the front goes back. cua-driver takes the picture, so it needs Screen Recording.
- `KEEP=1` leaves a stage up; `hosts.sh --down <stage>` takes it down.

`docs/media/logo.png` was made with OpenAI's image generation and trimmed; `how-it-works.svg`
is written by hand.

The shop works without the stage too: `python3 -m http.server --directory docs/demo/site`, then
`chrome-pane localhost:8000/checkout/`.
