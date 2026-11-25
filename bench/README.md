# The browser benchmark

How fast, how cheap and how reliably an agent gets browser work done with chrome-pane, and with
the other ways an agent can drive a browser. It is two benchmarks:

- **`run.mjs`, end to end.** A headless Claude Code (`claude -p`) does a task on a test site, one
  method at a time, and the site checks the outcome. It measures what you live with: the time from
  asking to done, the tokens and the cost, and how often the task is done right.
- **`micro.mjs`, chrome-pane alone.** The same tasks, done by a fixed script of chrome-pane
  commands with no model. It measures the tool's own floor: how long each command takes and how
  much it prints. The end-to-end time is roughly this floor, plus the model's time.

## Run it

From a terminal of Herdr, Rex or Tern (chrome-pane's agent commands need one to open their pane),
with Chrome's remote debugging on and chrome-pane's bridge allowed:

```sh
node bench/run.mjs --dry-run                    # the plan, and the first run's command
node bench/run.mjs                              # every method and task, 3 rounds (72 runs, about an hour)
node bench/run.mjs --methods chrome-pane --tasks checkout,custom-widgets --reps 5
node bench/micro.mjs --reps 5                   # chrome-pane alone, about a minute
node bench/report.mjs bench/results/<after> bench/results/<before>   # what a change did
node bench/run.mjs --serve                      # the test site alone, to look at its pages
```

Results go to `bench/results/<date-time>/` (not committed): `summary.md` to read, `summary.json`,
`results.jsonl` (a row per run, every figure), `runs/<run>.jsonl` (each run's whole stream of
messages, each line with the time it arrived; pictures replaced by their size) and `meta.json`
(versions and settings). Runs are one at a time: they share one Chrome, and a run beside another
would slow both.

While it runs, leave Chrome alone. The runs open and close tabs on `127.0.0.1` only, the pane
beside you shows them, and cua opens a Chrome window of its own.

## The methods

| | What the agent gets | The browser |
| --- | --- | --- |
| `chrome-pane` | `Bash` limited to `chrome-pane`, `Read`; the skill (`skills/chrome-pane/SKILL.md` of this checkout) | Your Chrome, through the bridge, with the pane open beside the agent |
| `claude-in-chrome` | The `mcp__claude-in-chrome__*` tools (`claude --chrome`), with their server's own instructions | Your Chrome, through the extension |
| `cua` | The `mcp__cua-driver__*` tools (`cua-driver mcp`), `Read`; cua-driver's skill, with the path of its reference files | A Chrome of cua's own, an isolated profile it launches each run |

Every run is the same apart from that: the same model and prompt, `--permission-mode dontAsk`
(a tool outside the method is refused, and counted), no skills, no CLAUDE.md, no memory, no
other MCP server, no settings of yours (`--setting-sources project` in an empty folder), and a
short note in the system prompt: this is a test site, everything the task names is authorized,
nobody will answer questions, end with `ANSWER:` when asked for one.

cua runs on a browser of its own because attaching it to your Chrome needs its daemon started
with `--grant existing-profile`, and Chrome then asks you to allow its connection. To add that,
or another method (Playwright MCP, agent-browser, Chrome DevTools MCP), add an entry to
`lib/methods.mjs`: the tools it gets, the ones allowed without asking, its flags and its guide.

## The tasks

Each is a page or a few of a made-up shop (`lib/tasks.mjs`), with data made from a seed of the
task and the round: in one round every method sees the same orders and names, and each round
sees new ones. The check never takes the agent's word: what it changes is checked on the server,
and what it reads is checked against what the page showed.

| Task | What it tests |
| --- | --- |
| `read-order` | Reading: one order's total and customer, in a table of 40 |
| `checkout` | A form: five text fields, a select, a checkbox, submit. Placing it twice fails |
| `shop-cart` | Several pages: search, the right product among look-alikes ("… Mini"), a colour, a quantity |
| `async-report` | Waiting: a report that takes 3.5 to 5.5 s, with last quarter's report already on the page |
| `dialog-delete` | A `confirm()` dialog, and the right one of six "Delete" buttons |
| `long-settings` | A long page: the export section at the bottom, a look-alike checkbox higher up |
| `paginated` | Extracting across three pages of a table (or one, with the status filter) |
| `custom-widgets` | Controls made of `<div>`s: a dropdown, an autocomplete, a "button", none with ARIA |

A warm-up task runs once per method first and is not counted: it opens the pane, the tab group
or cua's browser, and drops a method that cannot start.

## What it measures

Per run, from the stream of messages and the site's own log:

- **Time.** From starting `claude -p` to its exit. Split into start-up (until Claude Code is up,
  with its MCP servers), the model's time and the tools' time (each tool call from its request to
  its result). Also when the site saw the first page load, and when it saw the task done.
- **Tokens and cost.** Input tokens of every model call, whole (cached or not, so the figure does
  not depend on what the cache held), output tokens, the context at the first call (what the
  method costs before doing anything) and at its largest, the tokens the tools' results added
  (the context's growth between calls), pictures, and the cost Claude Code reports.
- **Work.** Model calls, tool calls by tool, tool errors, refused tool calls, pages loaded.
- **Outcome.** `pass`, `fail` (done wrong, or not done), `timeout`, `max_turns`, `error` (the run
  ended in an API error). A run that never got going (an MCP server not connected, every account
  at a limit) is `infra`: tried once more at the end and left out of the figures.

`summary.md` has medians by method and by task, p90 of the time, a table of every tool (how often,
how long, how much it returned) and the failed runs with why. With two folders, `report.mjs`
compares them.

## Reading it

- Small samples: three rounds are three runs per task and method. Compare medians, look at the
  spread, and run more rounds (`--reps`) before believing a difference of a few percent.
- The order of the methods changes in every round (`--order-seed` repeats one), so that a slow
  minute of the API or of Chrome does not always land on the same method.
- The cost depends on the cache: the first run of a method writes its system prompt to the cache,
  later ones read it. Input tokens do not.
- Each method sees the page at its own size: the pane's, the Chrome window's, cua's window's.
- chrome-pane is measured from this checkout (its `bin` comes first on the `PATH`), so a change to
  it, or to its skill, shows in the next run.
