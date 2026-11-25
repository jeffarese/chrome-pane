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
node bench/run.mjs                              # every method and task, 3 rounds (120 runs, over an hour)
node bench/run.mjs --methods chrome-pane --tasks checkout,custom-widgets --reps 5
node bench/run.mjs --latency 150                # the test site answers as a server far away does
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
| `agent-browser` | `Bash` limited to `agent-browser`, `Read`; its core skill (`agent-browser skills get core`) | A Chrome of its own: headless, a new profile each run |
| `terminal-browser` | `Bash` limited to `terminal-browser`, `Read`; its skill | A Chromium of its own, drawn in a terminal pane beside the agent, started anew each run |
| `cua` | The `mcp__cua-driver__*` tools (`cua-driver mcp`), `Read`; cua-driver's skill, with the path of its reference files | A Chrome of cua's own, an isolated profile it launches each run |

Every run is the same apart from that: the same model and prompt, `--permission-mode dontAsk`
(a tool outside the method is refused, and counted), no skills, no CLAUDE.md, no memory, no
other MCP server, no settings of yours (`--setting-sources project` in an empty folder), and a
short note in the system prompt: this is a test site, everything the task names is authorized,
nobody will answer questions, end with `ANSWER:` when asked for one.

agent-browser and terminal-browser are told two things their guides do not say, which a run's
permissions make true: only their own command is allowed (no `$(...)`, no loop), and
agent-browser's session is set for it (its guide asks for one with `$(...)`). chrome-pane's
guide says the same of loops. terminal-browser opens only in a terminal it knows: Rex, Ghostty,
kitty and others, not Herdr's or Tern's, so to compare the two, run both from Rex.

cua runs on a browser of its own because attaching it to your Chrome needs its daemon started
with `--grant existing-profile`, and Chrome then asks you to allow its connection. To add that,
or another method (Playwright MCP, Chrome DevTools MCP), add an entry to
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

## A connection like a real one

The test site is on this computer and answers at once, which no real site does. `--latency 150`
makes every answer (pages, and what their scripts ask for) come 150 ms late, give or take 30%:
it shows what a method's waits cost and miss when the page is not there yet. It is no substitute
for a few real sites, which also have what the test site has not: requests that are not the
answer to anything (counters, prefetches, polls), workers, and boxes that fade in and out.

## Results, 25 November 2026

Claude Code 2.1.332, Opus 5.5 at `--effort low`, Chrome 158, 3 rounds of the 8 tasks (24 runs a
method), `--order-seed effort-2026-11-25`. Medians of a run; p90 of the time in brackets.

| Run | Method | Passed | Time | Input tokens | Model calls | Tool calls | Cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| First, in Herdr | chrome-pane, as it was | 24/24 | 11.5 s (17.1) | 36.1 k | 5 | 4 | $0.036 |
| | Claude in Chrome | 23/24 | 24.4 s (28.9) | 66.1 k | 6 | 7.5 | $0.123 |
| | cua-driver 0.55.0 | 24/24 | 36.4 s (58.7) | 255.6 k | 13 | 13 | $0.285 |
| Four hours later, in Herdr | chrome-pane | 24/24 | 7.8 s (10.8) | 22.7 k | 3 | 2 | $0.030 |
| | agent-browser 0.44.0 | 24/24 | 9.8 s (37.6) | 50.2 k | 4 | 3 | $0.039 |
| Then in Rex | chrome-pane | 24/24 | 8.6 s (11.8) | 22.8 k | 3 | 2 | $0.031 |
| | terminal-browser 0.16.3 | 24/24 | 11.3 s (22.1) | 46.5 k | 5 | 4 | $0.047 |
| In Herdr, `--latency 150` | chrome-pane | 24/24 | 8.7 s (11.7) | 22.5 k | 3 | 2 | $0.030 |

Between the first run and the later ones chrome-pane learned to act on a control by its name, to end
an action when the page has taken it in, and to print the outcome (see the changelog). At
`--effort medium` it went from 12.4 s and 38.1 k tokens to 9.3 s and 28.9 k, 24/24 both times.

By task, time and input tokens (3 runs each):

| Task | chrome-pane | agent-browser | chrome-pane, in Rex | terminal-browser |
| --- | ---: | ---: | ---: | ---: |
| read-order | 4.6 s · 14.0 k | 5.5 s · 23.6 k | 4.9 s · 14.0 k | 6.9 s · 26.8 k |
| checkout | 8.5 s · 22.7 k | 9.6 s · 37.8 k | 10.0 s · 30.4 k | 10.6 s · 39.0 k |
| shop-cart | 7.4 s · 22.5 k | 15.7 s · 90.6 k | 7.8 s · 22.4 k | 11.4 s · 58.0 k |
| async-report | 11.0 s · 21.7 k | 37.6 s · 61.8 k | 10.9 s · 21.7 k | 32.9 s · 57.9 k |
| dialog-delete | 7.8 s · 29.2 k | 8.2 s · 50.6 k | 10.1 s · 36.9 k | 14.8 s · 71.0 k |
| long-settings | 6.4 s · 22.7 k | 8.8 s · 48.8 k | 6.9 s · 22.1 k | 9.3 s · 37.2 k |
| paginated | 7.6 s · 23.0 k | 10.5 s · 49.3 k | 7.9 s · 22.9 k | 12.8 s · 40.2 k |
| custom-widgets | 9.9 s · 37.5 k | 11.4 s · 74.6 k | 9.9 s · 37.3 k | 13.0 s · 46.5 k |

What the figures do not say:

- The methods were not all measured in one run, and three runs a task is a small sample.
- agent-browser, terminal-browser and cua start a browser of their own in every run, and that
  start is in their time. chrome-pane and Claude in Chrome use the Chrome that is running.
- The run in Rex was in a session no window showed, where a pane has 80 columns and 24 rows:
  chrome-pane saw 800 × 460 pixels of page there (637 × 1609 in Herdr), and took one more
  call on checkout and dialog-delete, whose pages do not fit in that.
- The site is on the same computer. On real sites chrome-pane's waits were tried by hand
  (GitHub, Wikipedia, YouTube, Amazon, MDN, Bootstrap's docs) and corrected for what those
  showed; the other methods were not tried there.

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
