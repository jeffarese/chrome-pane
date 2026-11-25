# The pictures in the README

Nobody's own Chrome is in them. They are taken on a showcase stage (a second Herdr app with a
made-up world, from the `herdr-showcase` kit), with a headless Chrome that has an empty profile
and is served the made-up shop of `site/` as `http://acme.test`.

```sh
sh docs/demo/shots.sh          # builds a stage, takes docs/media/preview.png, demo.gif and tabs.gif, takes it all down
```

- `site/` is the shop: a checkout page whose total and messages change as its form does, a
  front page and a page of orders.
- `showcase.sh <stage>` starts the Chrome and the shop's server, and opens the pane beside the
  stage's first agent. `showcase.sh --down <stage>` stops what it started.
- `shots.sh [stage]` takes the pictures. The commands in `demo.gif` are typed into a real shell
  and their output is what chrome-pane printed; the keys in `tabs.gif` are pressed in a real
  viewer. `ONLY=tabs` takes one of them.

`docs/media/logo.png` was made with OpenAI's image generation and trimmed; `how-it-works.svg`
is written by hand.

The shop works without the stage too: `python3 -m http.server --directory docs/demo/site`, then
`chrome-pane localhost:8000/checkout/`.
