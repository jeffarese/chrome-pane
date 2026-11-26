"""An agent's commands with no pane: `open` works in a hidden tab, which a holder process keeps.

    hidden_test.py <launcher> <chrome profile> <state folder>

No multiplexer (CHROME_PANE_HOST=none) and no viewer: what an agent in a plain terminal, or one
run with no terminal at all, gets. The pages come from a web server of this test's own. SHOW=1
prints what every command answered.
"""
import http.server, json, os, pty, re, subprocess, sys, threading, time

launcher, profile, state = sys.argv[1:4]
home_state = os.path.join(os.environ.get('XDG_STATE_HOME') or os.path.expanduser('~/.local/state'), 'chrome-pane')
if os.path.realpath(state) == os.path.realpath(home_state) or 'Application Support' in os.path.realpath(profile):
    sys.exit('hidden_test.py runs against a throwaway Chrome only')

FORM = '''<!doctype html><title>Order form</title><body><h1>Order</h1>
<p><label>Name <input id=name></label> <button onclick="save()">Save</button>
<button onclick="said.textContent = confirm('Really delete?') ? 'deleted' : 'kept'">Delete</button>
<button onclick="go()">Send it</button>
<p id=said role=status></p>
<script>
const said = document.getElementById('said');
// Saved a moment later, as a page that waits for the typing to stop does.
function save() { setTimeout(() => { said.textContent = 'Saved: ' + document.getElementById('name').value; }, 300); }
async function go() { said.textContent = 'sending'; said.textContent = 'sent: ' + await (await fetch('/slow')).text(); }
</script>'''
NEXT = '<!doctype html><title>Second page</title><body><h1>Second</h1><p>Text of the second page.'
POP = '<!doctype html><title>Pop page</title><body><h1>Pop</h1><button onclick="window.open(\'/next\')">Open</button>'
PAY = '<!doctype html><title>Pay</title><body><h1>Pay</h1><form method=post action=/paid><label>Name <input name=n></label> <button>Pay now</button></form>'
# A box that fades in behind a veil and out again: what a page draws over time.
LIVE = '''<!doctype html><title>Live page</title><body style="margin:20px;font:16px sans-serif"><h1>Live</h1>
<button id=open>Open box</button>
<div id=veil hidden style="position:fixed;inset:0;background:#0006;opacity:0;transition:opacity .15s"></div>
<div id=box role=dialog aria-label="Box" tabindex=-1 hidden style="position:fixed;top:80px;left:80px;padding:20px;background:#fff;opacity:0;transition:opacity .3s">
<p>Agree to the terms?</p><button id=agree>Agree</button></div>
<script>
const $ = (id) => document.getElementById(id), veil = $('veil'), box = $('box');
const then = (el, f) => el.addEventListener('transitionend', f, { once: true });
$('open').onclick = () => { veil.hidden = false; veil.offsetWidth; veil.style.opacity = 1; then(veil, () => { box.hidden = false; box.offsetWidth; box.style.opacity = 1; box.focus(); }); };
$('agree').onclick = () => { box.style.opacity = 0; then(box, () => { box.hidden = veil.hidden = true; veil.style.opacity = 0; }); };
</script>'''
PAGES = {'/': FORM, '/next': NEXT, '/pop': POP, '/pay': PAY, '/live': LIVE}
posts = 0

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/slow': time.sleep(1.2)
        body = 'ok' if self.path == '/slow' else PAGES.get(self.path.split('?')[0])
        self.send_response(200 if body else 404)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write((body or 'not here').encode())
    def do_POST(self):
        global posts
        self.rfile.read(int(self.headers.get('Content-Length') or 0))
        posts += 1
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(('<!doctype html><title>Paid</title><body><h1>Paid, receipt %d</h1>' % posts).encode())
    def log_message(self, *a): pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
site = 'http://127.0.0.1:%d' % server.server_address[1]

env = dict(os.environ, CHROME_PANE_STATE=state, CHROME_PANE_HOST='none', CHROME_PANE_USER_DATA_DIR=profile, TERM='xterm-256color')
for name in ('HC_TERMINAL_ID', 'HC_SCOPE', 'HC_TERMINAL_SOCKET', 'REX_BLOCK', 'TERN_PANE', 'CHROME_PANE_SOCKET', 'CHROME_PANE_WS', 'CHROME_PANE_HIDDEN', 'CHROME_PANE_HIDDEN_IDLE'):
    env.pop(name, None)

SHOW = os.environ.get('SHOW')
def run(*args, extra=None):
    """One command of an agent: (exit code, what it said, seconds it took)."""
    t0 = time.time()
    r = subprocess.run([launcher, *args], env=dict(env, **(extra or {})), capture_output=True, text=True, timeout=60)
    text = r.stdout + r.stderr
    if SHOW: print('$ chrome-pane %s   [exit %d, %.1f s]\n%s' % (' '.join(args), r.returncode, time.time() - t0, text.rstrip()))
    return r.returncode, text, time.time() - t0
def ref(text, what):
    m = re.search(r'^[\s+~-]*([a-z]\d+) [^\n]*' + re.escape(what), text, re.M)
    return m.group(1) if m else 'none'
def value(expr):
    code, text, _ = run('eval', expr)
    return text.split('\n', 1)[1].strip() if code == 0 and '\n' in text else 'ERROR ' + text.strip()
def panes():
    """The panes and hidden tabs that are registered: what agents find."""
    out = []
    folder = os.path.join(state, 'panes')
    for name in os.listdir(folder) if os.path.isdir(folder) else []:
        try: out.append(json.load(open(os.path.join(folder, name))))
        except (OSError, ValueError): pass
    return out
def alive(pid):
    try: os.kill(pid, 0)
    except OSError: return False
    return True
def tabs():
    code, text, _ = run('tabs', '--json')
    return json.loads(text) if code == 0 else []
def until(f, secs=6.0):
    end = time.time() + secs
    while time.time() < end:
        if f(): return True
        time.sleep(0.1)
    return f()
fails = 0
def step(name, ok):
    global fails
    print(('ok   ' if ok else 'FAIL ') + name)
    if not ok: fails += 1
    return ok

code, text, _ = run('snapshot')
step('with no pane and no hidden tab, a command says how to open one', code == 2 and 'chrome-pane open' in text)
code, text, _ = run('open', site + '/')
held = [p for p in panes() if p.get('hidden')]
step('open with no multiplexer: a hidden tab, and its page', code == 0 and text.split('\n')[0] == 'Order form' and len(held) == 1 and held[0].get('targetId'))
holder = held[0]['pid'] if held else 0
target = held[0].get('targetId') if held else None
step('the hidden tab is a tab of Chrome', any(t['id'] == target for t in tabs()))

code, text, _ = run('fill', 'Name', 'Ada')
run('click', 'Save')
# Chrome runs a background tab's timers once a second at most: the page's 300 ms comes later, but it comes.
code, text, took = run('wait', 'Saved: Ada')
step('what the page does a moment later comes, and wait sees it (%.1f s)' % took, code == 0 and took < 3)
code, text, took = run('click', 'Send it')
step('an answer the page waits for is waited for (%.1f s)' % took, code == 0 and 'sent: ok' in text)
code, text, _ = run('click', 'Delete')
step('a dialog: the hidden tab says what it asks', code == 0 and 'Really delete?' in text)
code, text, _ = run('dialog', 'accept')
step('dialog accept: the holder answers it, and the page did what it does', code == 0 and 'deleted' in text)

code, text, _ = run('open', site + '/live')
code, text, took = run('click', 'Open box')
step('what fades in is waited for (%.1f s)' % took, code == 0 and 'dialog "Box"' in text and 'button "Agree"' in text)
code, text, took = run('click', 'Agree')
step('what fades out is waited for (%.1f s)' % took, code == 0 and re.search(r'^- [a-z]\d+ dialog "Box"', text, re.M) is not None)

code, text, _ = run('open', site + '/pay')
code, text, _ = run('click', 'Pay now')
code, text, _ = run('reload')
step('reload: refused on the answer to a sent form', code == 1 and 'reload --resend' in text and posts == 1)

code, text, _ = run('open', site + '/pop')
code, text, _ = run('click', 'Open')
step('a tab the page opens: the hidden tab follows it, and the agent is told', code == 0 and 'now shows another tab' in text
     and run('snapshot')[1].startswith('Second page'))
run('eval', 'window.close()')
step('when that tab closes, it is back on the page that opened it', until(lambda: run('snapshot')[1].startswith('Pop page')))

code, text, _ = run('shot')
shot = text.split('\n')[0]
step('shot: a picture of a tab that Chrome does not draw', code == 0 and shot.endswith('.jpg') and os.path.getsize(shot) > 1000)
step('one hidden tab all along: open goes on in the same one', len([p for p in panes() if p.get('hidden')]) == 1 and alive(holder))

# The person takes it over: a pane on the hidden tab, and the holder steps aside.
code, text, _ = run('show')
step('show with no multiplexer: says what the person can run', code == 0 and ('chrome-pane --tab ' + str(target)) in text)
pid, fd = pty.fork()
if pid == 0:
    os.execve(launcher, [launcher, 'view', '--tab', target], env)
def drain():
    while True:
        try:
            if not os.read(fd, 1 << 16): return
        except OSError: return
threading.Thread(target=drain, daemon=True).start()
step('a pane that shows the hidden tab: its holder steps aside', until(lambda: not alive(holder), 10))
step('and the tab stays, the person\'s now', any(t['id'] == target for t in tabs()))
code, text, _ = run('snapshot')
step('the agent goes on in the pane', code == 0 and 'Pop' in text)
code, text, _ = run('close')
_, status = os.waitpid(pid, 0)
step('close: the pane goes, the tab stays', code == 0 and 'tab stays open' in text and any(t['id'] == target for t in tabs()))

code, text, _ = run('open', site + '/next')
held = [p for p in panes() if p.get('hidden')]
second = held[0] if held else {}
step('open again: a new hidden tab', code == 0 and text.split('\n')[0] == 'Second page' and second.get('targetId'))
code, text, _ = run('close')
step('close: the hidden tab is closed, and its holder gone', code == 0 and 'Closed the hidden tab' in text
     and until(lambda: not alive(second.get('pid', 0))) and not any(t['id'] == second.get('targetId') for t in tabs()))
code, text, _ = run('close')
step('close again: nothing to do, and no failure', code == 0 and 'no Chrome pane' in text)

code, text, _ = run('open', site + '/next', extra={'CHROME_PANE_HIDDEN_IDLE': '2'})
held = [p for p in panes() if p.get('hidden')]
third = held[0] if held else {}
step('a hidden tab no agent uses for a while is closed', code == 0 and until(lambda: not alive(third.get('pid', 0)), 8)
     and not any(t['id'] == third.get('targetId') for t in tabs()))

server.shutdown()
sys.exit(1 if fails else 0)
