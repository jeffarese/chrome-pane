# The pictures in the README

Nobody's own Chrome is in them. They are taken on a showcase stage (a second Herdr app with a
made-up world, from the `herdr-showcase` kit), with a headless Chrome that has an empty profile
and is served the made-up shop of `site/` as `http://acme.test`.

```sh
sh docs/demo/shots.sh          # builds a stage, takes docs/media/preview.png and demo.gif, takes it all down
```

- `site/` is the shop: one checkout page whose total and messages change as its form does.
- `showcase.sh <stage>` starts the Chrome and the shop's server, and opens the pane beside the
  stage's first agent. `showcase.sh --down <stage>` stops what it started.
- `shots.sh [stage]` takes the pictures. The commands in the film are typed into a real shell
  and their output is what chrome-pane printed.

The shop works without the stage too: `python3 -m http.server --directory docs/demo/site`, then
`chrome-pane localhost:8000/checkout/`.
