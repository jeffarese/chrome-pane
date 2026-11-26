"""Runs the viewer in a pty that plays the terminal, and an agent's commands beside it.

    agent_test.py <launcher> <chrome profile> <state folder> [<cell width>x<cell height> [<zoom>]]

The pages come from a web server of this test's own (an agent's `open` takes http addresses
only). SHOW=1 prints what every command answered.
"""
import fcntl, http.server, os, pty, re, struct, subprocess, sys, tempfile, termios, threading, time

launcher, profile, state = sys.argv[1:4]
cell_w, cell_h = (int(v) for v in (sys.argv[4] if len(sys.argv) > 4 else '10x20').split('x'))
scale = 2 if cell_h >= 26 else 1
zoom = float(sys.argv[5]) if len(sys.argv) > 5 else 1.0
COLS, ROWS = 100, 41
view_w, view_h = round(COLS * cell_w / scale / zoom), round((ROWS - 1) * cell_h / scale / zoom)
# Never the person's own Chrome: a state folder of this test's, and so a bridge of its own.
home_state = os.path.join(os.environ.get('XDG_STATE_HOME') or os.path.expanduser('~/.local/state'), 'chrome-pane')
if os.path.realpath(state) == os.path.realpath(home_state) or 'Application Support' in os.path.realpath(profile):
    sys.exit('agent_test.py runs against a throwaway Chrome only')

FORM = '''<!doctype html><title>Order form</title>
<body style="margin:20px;font:16px sans-serif">
<header><a href="/next">Next page</a> <a href="/long">Long page</a></header>
<main><h1>Order</h1>
<form onsubmit="return false">
<p><label>Name <input id=name></label>
<p><label>Password <input id=pw type=password value="hunter2"></label>
<p><label>Card <input id=card autocomplete="cc-number"></label>
<p><label>Code <input id=code name=cvc value="123"></label>
<p><label>Colour <select id=colour><option>Red<option>Green<option>Blue</select></label>
<p><label><input id=gift type=checkbox> Gift wrap</label>
<p><button id=save onclick="store()">Save</button>
<button id=del onclick="$('status').textContent = confirm('Really delete?') ? 'deleted' : 'kept'">Delete</button>
</form>
<p id=status role=status></p>
<table id=t><tr><th>Item<th>Price<tr><td>Tea<td>3<tr><td>Cake<td>5</table>
</main>
<script>
const $ = (id) => document.getElementById(id);
function store() {
  $('status').textContent = 'Saved: ' + $('name').value + ' / ' + $('colour').value + ' / ' + ($('gift').checked ? 'gift' : 'plain');
  if (!$('undo')) { const b = document.createElement('button'); b.id = 'undo'; b.textContent = 'Undo'; document.querySelector('form').append(b); }
}
</script>'''
NEXT = '<!doctype html><title>Second page</title><body><h1>Second</h1><p>Text of the second page.<p><a href="/">Back to the form</a>'
LONG = ('<!doctype html><title>Long page</title><body style="margin:20px;font:16px sans-serif"><h1>Long</h1><nav aria-label="Contents">'
        + ''.join('<a href="#c%d">Entry %d</a> ' % (i, i) for i in range(1, 31)) + '</nav>'
        + ''.join('<h2 id=c%d style="margin-top:%dpx">Chapter %d</h2><p>Words of chapter %d.' % (i, 900, i, i) for i in range(1, 4))
        + '<p style="margin-top:900px"><button onclick="document.title=\'bottom clicked\'">Bottom button</button> <select aria-label="Pace"><option>Slow<option>Fast</select>')
# A page that tries to talk to the terminal: an Esc sequence in its title and its text, and the
# one-byte forms of Esc [ and of the end of a sequence.
ESC = '<!doctype html><title>Sneaky\x1b]52;c;eA==\x07 title</title><body><h1>Esc\x1b[31m here</h1><p>and \x9b31m too\x9c'
POP = '<!doctype html><title>Pop page</title><body><h1>Pop</h1><button onclick="window.open(\'/next\')">Open</button>'
# A form that is sent the way a payment is: every time it arrives, the shop takes one more.
PAY = '<!doctype html><title>Pay</title><body><h1>Pay</h1><form method=post action=/paid><label>Name <input name=n></label> <button>Pay now</button></form>'
# Controls made of plain elements (known by the click they listen for, or by the pointer's hand),
# two buttons of one name, an answer the page takes a while to get, and a table.
MADE = '''<!doctype html><title>Made page</title><body style="margin:20px;font:16px sans-serif"><h1>Made</h1>
<div id=pick style="cursor:pointer;width:200px">Choose ▾</div>
<div id=menu hidden><div onclick="choose(this)">Tea</div><div onclick="choose(this)">Cake</div></div>
<p><label>Email <input id=email></label></p>
<section aria-label="First"><h2>First</h2><button onclick="said.textContent='removed first'">Remove</button></section>
<section aria-label="Second"><h2>Second</h2><button onclick="said.textContent='removed second'">Remove</button></section>
<div id=go style="width:200px">Send it</div><p id=said></p>
<table><tr><th>Item<th>Price<tr><td>Tea leaves<td>3<tr><td>Scone<td>5</table>
<p><a href="/next">Onwards</a></p>
<script>
const $ = (id) => document.getElementById(id), said = $('said');
$('pick').onclick = () => { $('menu').hidden = !$('menu').hidden; };
function choose(o) { $('pick').textContent = o.textContent + ' ▾'; $('menu').hidden = true; }
$('go').addEventListener('click', async () => { said.textContent = 'sending'; said.textContent = 'sent: ' + await (await fetch('/slow')).text(); });
</script>'''
# What pages of the web do: a box that fades in behind a veil and out again, a list that asks
# for more once it is shown (what the person may want next), and a worker with a script of its own.
LIVE = '''<!doctype html><title>Live page</title><body style="margin:20px;font:16px sans-serif"><h1>Live</h1>
<button id=open>Open box</button> <button id=load>Load list</button><p id=list></p><p id=ahead></p>
<div id=veil hidden style="position:fixed;inset:0;background:#0006;opacity:0;transition:opacity .15s"></div>
<div id=box role=dialog aria-label="Box" tabindex=-1 hidden style="position:fixed;top:80px;left:80px;padding:20px;background:#fff;opacity:0;transition:opacity .3s">
<p>Agree to the terms?</p><button id=agree>Agree</button></div>
<script>
const $ = (id) => document.getElementById(id), veil = $('veil'), box = $('box');
const then = (el, f) => el.addEventListener('transitionend', f, { once: true });
$('open').onclick = () => { veil.hidden = false; veil.offsetWidth; veil.style.opacity = 1; then(veil, () => { box.hidden = false; box.offsetWidth; box.style.opacity = 1; box.focus(); }); };
$('agree').onclick = () => { box.style.opacity = 0; then(box, () => { box.hidden = veil.hidden = true; veil.style.opacity = 0; }); };
$('load').onclick = async () => {
  $('list').textContent = 'list: ' + await (await fetch('/quick')).text();
  $('ahead').textContent = 'ahead: ' + await (await fetch('/slow')).text();
};
new Worker('/worker.js');
</script>'''
PAGES = {'/': FORM, '/next': NEXT, '/long': LONG, '/esc': ESC, '/pop': POP, '/pay': PAY, '/made': MADE, '/live': LIVE}
posts = 0

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # An answer that takes its time, as a search or a save does.
        if self.path == '/slow': time.sleep(1.2)
        body = 'ok' if self.path in ('/slow', '/quick') else 'postMessage(1)' if self.path == '/worker.js' else PAGES.get(self.path.split('?')[0])
        self.send_response(200 if body else 404)
        self.send_header('Content-Type', 'text/javascript' if self.path == '/worker.js' else 'text/html; charset=utf-8')
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

env = dict(os.environ, CHROME_PANE_STATE=state, TERM='xterm-256color')
# Outside Herdr: the agent's commands then take the pane used last, which is this one.
for name in ('HC_TERMINAL_ID', 'HC_SCOPE', 'HC_TERMINAL_SOCKET', 'CHROME_PANE_SOCKET', 'CHROME_PANE_WS', 'CHROME_PANE_USER_DATA_DIR'):
    env.pop(name, None)
pid, fd = pty.fork()
if pid == 0:
    os.execve(launcher, [launcher, 'view', site + '/', '--user-data-dir', profile], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
out = b''
# What the terminal says of picture commands. None: nothing (a terminal that never answers).
# 'ok': it answers the viewer's questions. 'gone': it also says, once, that it does not have the
# picture it is told to show, as a screen does that Herdr sent the pane's text again.
answers, answered, gone_at = None, set(), None
def terminal():
    """Plays the terminal for as long as the viewer runs: takes what it writes, answers its queries."""
    global out, answers, gone_at
    tail = b''
    while True:
        try: data = os.read(fd, 1 << 16)
        except OSError: return
        if not data: return
        out += data
        seen, tail = tail + data, (tail + data)[-80:]
        if answers:
            for m in re.finditer(rb'\x1b_Ga=q,i=(\d+),', seen):
                if m.group(1) not in answered: answered.add(m.group(1)); os.write(fd, b'\x1b_Gi=' + m.group(1) + b';OK\x1b\\')
        if answers == 'gone':
            m = re.search(rb'\x1b_Ga=p,i=(\d+),p=1,q=1[^\x1b]*\x1b', seen)
            if m: answers, gone_at = 'ok', len(out); os.write(fd, b'\x1b_Gi=' + m.group(1) + b',p=1;ENOENT: image not found\x1b\\')
        if b'\x1b[16t' in data: os.write(fd, b'\x1b[6;%d;%dt' % (cell_h, cell_w))
        if b'\x1b[?1016$p' in data: os.write(fd, b'\x1b[?1016;1$y')
        if b'\x1b[c' in data: os.write(fd, b'\x1b[?62c')
threading.Thread(target=terminal, daemon=True).start()
def shown(what, secs=8.0, since=0):
    end = time.time() + secs
    while time.time() < end:
        if what in out[since:]: return True
        time.sleep(0.05)
    return what in out[since:]

SHOW = os.environ.get('SHOW')
last = ''
def run(*args, stdin=None):
    """One command of an agent: (exit code, what it said, seconds it took)."""
    global last
    t0 = time.time()
    r = subprocess.run([launcher, *args], env=env, input=stdin, capture_output=True, text=True, timeout=60)
    last = r.stdout + r.stderr
    if SHOW: print('$ chrome-pane %s   [exit %d, %.1f s]\n%s' % (' '.join(args), r.returncode, time.time() - t0, last.rstrip()))
    return r.returncode, last, time.time() - t0
def ref(text, what):
    """The ref of the line that has `what`."""
    m = re.search(r'^[\s+~-]*([a-z]\d+) [^\n]*' + re.escape(what), text, re.M)
    return m.group(1) if m else 'none'
def value(expr):
    code, text, _ = run('eval', expr)
    return text.split('\n', 1)[1].strip() if code == 0 and '\n' in text else 'ERROR ' + text.strip()
fails = 0
def step(name, ok):
    global fails
    print(('ok   ' if ok else 'FAIL ') + name)
    if not ok:
        fails += 1
        print('     the last command said:\n' + '\n'.join('     | ' + l for l in last.rstrip().split('\n')[:40]))
    return ok

step('the viewer draws the page', shown(b'\x1b_Ga=T,f=100', 20))
time.sleep(1.5)

code, snap, _ = run('snapshot')
lines = snap.split('\n')
step('snapshot: the title, the address and the view (%s)' % (lines[2] if len(lines) > 2 else '?'),
     code == 0 and lines[0] == 'Order form' and lines[1] == site + '/' and lines[2].startswith('view %dx%d at 0 of ' % (view_w, view_h)))
step('snapshot: the controls under what holds them', all(w in snap for w in ('main', 'h1 "Order"', 'link "Next page"', 'textbox "Name"', 'checkbox "Gift wrap"', 'button "Save"')))
step('snapshot: a list shows the option it has', re.search(r'"Colour"[^\n]*Red', snap) is not None)
step('snapshot: a password is said to be there, not what it is', '=[filled]' in snap and 'hunter2' not in snap)
step('snapshot: nor a card\'s code, known by the field\'s name', 'textbox "Code" =[filled]' in snap)
step('snapshot: it is short (%d characters)' % len(snap), len(snap) < 900)
name, pw, card, colour, gift, save, delete = (ref(snap, w) for w in ('"Name"', '"Password"', '"Card"', '"Colour"', '"Gift wrap"', '"Save"', '"Delete"'))

heading = ref(snap, 'h1 "Order"')
code, text, _ = run('fill', '%s%d' % (heading[0], int(heading[1:]) + 1), 'x')
step('fill: the text of a heading is not a field, and that is what it says', code == 1 and 'cannot be filled: it is not a text field' in text)

code, text, _ = run('find', 'save')
step('find: the button, and where it is', code == 0 and ref(text, 'button "Save"') == save and '(in view)' in text)
code, text, _ = run('find', 'no such thing')
step('find: nothing found is said so', code == 0 and text.startswith('nothing on the page has'))

n = len(out)
code, text, _ = run('fill', name, 'Ada Lovelace')
step('fill: says what it did and what changed', code == 0 and text == 'filled %s "Name"\n~ %s textbox "Name" ="Ada Lovelace"\n' % (name, name))
# Herdr reads a full-screen program whose turn ended by turning the mouse wheel in it, and then
# sends every screen the pane's text again without its pictures: the pane never says it works.
step('the pane says an agent is acting, in its bar (and never to Herdr, which would scroll the page)', shown(b'Agent: fill', 3, n) and b'state=working' not in out)
code, text, _ = run('fill', pw, 'secret')
step('fill: a password is refused', code == 1 and 'ask the person' in text and value('document.getElementById("pw").value') == 'hunter2')
code, text, _ = run('fill', card, '4111111111111111')
step('fill: a card number is refused', code == 1 and 'ask the person' in text)
code, text, _ = run('select', colour, 'blue')
step('select: by the option\'s name, and one line for what changed', code == 0 and text.startswith('selected "Blue"') and text.count('\n') == 2 and '~ %s combobox "Colour" ="Blue"' % colour in text and value('document.getElementById("colour").value') == 'Blue')
code, text, _ = run('select', colour, 'Purple')
step('select: an option that is not there lists the ones there are', code == 1 and 'Red, Green, Blue' in text)
code, text, _ = run('check', gift)
again = run('check', gift)[1]
step('check: ticks, and says so when it was ticked', code == 0 and text.startswith('checked') and '[checked]' in text and 'was already checked' in again)
code, text, _ = run('click', save)
step('click: what changed is the page\'s message and its new button', code == 0 and text.startswith('clicked %s "Save"' % save) and re.search(r'^\+ [a-z]\d+ button "Undo"', text, re.M) is not None
     and re.search(r'^\+ [a-z]\d+ status "Saved: Ada Lovelace / Blue / gift"', text, re.M) is not None and text.count('\n') == 3)
code, text, _ = run('wait', 'Saved: Ada Lovelace / Blue / gift')
step('wait: for a text', code == 0 and 'is on the page' in text)
code, text, took = run('wait', 'Nope', '--timeout', '0.5')
step('wait: gives up at its limit (%.1f s)' % took, code == 1 and 'waited 0.5 s' in text and took < 4)
code, text, _ = run('read')
step('read: the text, and whose it is', code == 0 and text.startswith('text of %s/, as the page wrote it:' % site) and 'Saved: Ada Lovelace' in text and 'hunter2' not in text)
code, text, _ = run('read', '#t', '--table')
step('read: a table as rows', code == 0 and 'Item\tPrice\nTea\t3\nCake\t5' in text)
code, text, _ = run('read', name)
step('read: one part by its ref', code == 0)
run('fill', name, '')
emptied = value('document.getElementById("name").value')
run('click', name)
run('type', 'Ada!')
typed = value('document.getElementById("name").value')
run('press', 'Backspace')
step('fill with nothing empties; type and press go to the focused field: %s' % typed, emptied == '' and typed == 'Ada!' and value('document.getElementById("name").value') == 'Ada')
run('press', 'ctrl+a')
run('type', 'Z')
step('press ctrl+a selects all (the Mac\'s Cmd+A too)', value('document.getElementById("name").value') == 'Z')
run('click', pw)
code, text, _ = run('type', 'secret')
step('type: refused while a password field has the focus', code == 1 and 'ask the person' in text and value('document.getElementById("pw").value') == 'hunter2')
code, text, _ = run('press', 'x')
step('press: a letter is refused there too, Tab is not', code == 1 and 'ask the person' in text and value('document.getElementById("pw").value') == 'hunter2' and run('press', 'Tab')[0] == 0)

code, text, _ = run('batch', stdin='fill %s "Grace Hopper"\nselect %s Green\nuncheck %s\nclick %s\n' % (name, colour, gift, save))
step('batch: several actions, one answer', code == 0 and text.count('\n') < 12 and 'filled' in text and 'unchecked' in text and value('document.getElementById("status").textContent') == 'Saved: Grace Hopper / Green / plain')
code, text, _ = run('batch', stdin='fill %s "X"\nclick e999999\nclick %s\n' % (name, save))
step('batch: stops at the step that fails', code == 1 and 'failed at step 2' in text and '1 steps not done' in text)

# An agent cuts a long answer short (`| head -3`): the steps are all done all the same.
piped = subprocess.Popen([launcher, 'batch'], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
piped.stdin.write('fill "Name" "Piped"\nselect "Colour" Red\ncheck "Gift wrap"\nclick "Save"\n')
piped.stdin.close()
first_line = piped.stdout.readline()
piped.stdout.close()
piped_code, last = piped.wait(timeout=30), piped.stderr.read()
step('batch: goes on to its end when what reads its answer stops reading', piped_code == 0 and first_line.startswith('filled') and last == '' and value('document.getElementById("status").textContent') == 'Saved: Piped / Red / gift')

n = len(out)
code, text, took = run('click', delete)
step('click: a question the page asks is told (%.1f s)' % took, code == 0 and 'dialog (confirm): "Really delete?"' in text and took < 5)
step('the pane shows the question', shown(b'confirm: Really delete?', 3, n))
code, text, took = run('snapshot')
step('with a question open, a command says so at once (%.1f s)' % took, code == 1 and 'dialog (confirm)' in text and took < 3)
code, text, _ = run('dialog', 'dismiss')
step('dialog dismiss: the pane answers it, and the command says what the page did then', code == 0 and re.fullmatch(r'dismissed the dialog\n~ [a-z]\d+ status "kept"\n', text) is not None and value('document.getElementById("status").textContent') == 'kept')
run('click', delete)
code, text, _ = run('dialog', 'accept')
step('dialog accept', code == 0 and text.startswith('accepted the dialog\n') and 'status "deleted"' in text and value('document.getElementById("status").textContent') == 'deleted')
code, text, _ = run('dialog', 'accept')
step('dialog: none open is said so', code == 1 and 'no dialog' in text)

shot_file = os.path.join(tempfile.mkdtemp(prefix='cps.'), 'shot.jpg')
code, text, _ = run('shot', '--out', shot_file)
jpeg = os.path.exists(shot_file) and open(shot_file, 'rb').read(3) == b'\xff\xd8\xff'
step('shot: a picture in a file, and its cost: %s' % text.split('\n')[-1], code == 0 and jpeg and text.startswith(shot_file) and 'tokens' in text)
code, text, _ = run('shot', '--out', shot_file)
code2, text2, _ = run('shot', '--out', os.path.join(os.path.dirname(shot_file), 'profile.sh'))
step('shot: never over a file, and only into a picture file', code == 1 and 'never writes over' in text and code2 == 1 and '--out takes' in text2 and os.listdir(os.path.dirname(shot_file)) == ['shot.jpg'])
if os.path.exists(shot_file): os.remove(shot_file)
os.rmdir(os.path.dirname(shot_file))
code, text, _ = run('shot')
own = text.split('\n')[0]
step('shot: by itself, into a folder of the person\'s alone', code == 0 and own.startswith(os.path.join(os.path.normpath(state), 'shots') + os.sep) and os.stat(own).st_mode & 0o077 == 0 and os.stat(os.path.dirname(own)).st_mode & 0o077 == 0)
n = len(out)
run('click', save)
step('after it, the pane still gets frames', shown(b'\x1b_Ga=T,f=100', 5, n))
step('and the page keeps the pane\'s size', value('innerWidth + "x" + innerHeight') == '%dx%d' % (view_w, view_h))

code, text, _ = run('click', ref(snap, '"Next page"'))
first = text.split('\n')
step('click on a link: the new page is printed', code == 0 and first[0].startswith('clicked') and first[1] == 'Second page' and 'link "Back to the form"' in text)
step('its refs are of another page (%s, not %s)' % (ref(text, '"Back to the form"')[0], name[0]), ref(text, '"Back to the form"')[0] != name[0])
code, text, _ = run('click', name)
step('a ref of the page before is refused, with the page there is', code == 1 and text.startswith('stale: ') and 'Second page' in text)
code, text, _ = run('back')
back_ok = code == 0 and text.split('\n')[0] == 'Order form'
code, text, _ = run('forward')
step('back and forward', back_ok and code == 0 and text.split('\n')[0] == 'Second page')

code, text, _ = run('open', site.replace('http://', '') + '/long')
step('open: goes there and prints the page', code == 0 and text.split('\n')[0] == 'Long page' and '(0 above, ' in text)
step('open: a wall of links is cut, and headings out of view map the page', re.search(r'… \d+ more links here', text) is not None and 'h2 "Chapter 3" (↓)' in text and 'Bottom button' not in text)
step('open: the options of a list that is out of view are out of view with it', 'option "Slow"' not in text and 'combobox' not in text)
nav, chapter = ref(text, 'navigation'), ref(text, 'h2 "Chapter 2"')
step('the cut names the part to ask for', '(snapshot --in %s, or find <text>)' % nav in text)
code, text, _ = run('snapshot', '--in', nav)
step('snapshot --in: one part, whole', code == 0 and 'link "Entry 30"' in text and 'Long page' not in text)
code, text, _ = run('scroll', chapter)
at = re.search(r'view \d+x\d+ at (\d+) of', text)
step('scroll to a heading by its ref', code == 0 and at is not None and int(at.group(1)) > 500 and '%s h2 "Chapter 2"\n' % chapter in text)
code, text, _ = run('scroll', 'bottom')
at = re.search(r'view \d+x\d+ at (\d+) of', text)
step('scroll: prints what is now in view', code == 0 and at is not None and int(at.group(1)) > 1000 and 'button "Bottom button"' in text and 'combobox "Pace"' in text)
run('scroll', 'top')
code, text, _ = run('find', 'Bottom button')
step('find: says a thing is below', code == 0 and '(↓ below)' in text)
code, text, _ = run('click', ref(text, 'button "Bottom button"'))
step('click: brings what is out of view into it first, and a scroll is no change', code == 0 and re.search(r'^view now at \d+ of \d+ px$', text, re.M) is not None and text.count('\n') == 2 and value('document.title') == 'bottom clicked')

code, text, _ = run('read', 'h1')
step('read: h1 is the heading, not a ref', code == 0 and text.strip().endswith('Long'))
code, text, _ = run('wait', 'Long', '--timeout', 'soon')
step('wait: a limit that is no number is refused', code == 1 and '--timeout' in text)
code, text, _ = run('open', 'file:///etc/passwd')
code2, text2, _ = run('open', 'javascript:alert(1)')
step('open: only the web', code == 1 and 'http and https' in text and code2 == 1 and value('location.pathname') == '/long')
code, text, _ = run('eval', '1 + 1')
step('eval: says where the answer comes from', code == 0 and text == 'from %s:\n2\n' % site)
code, text, _ = run('snapshot', '--bogus')
step('an option that does not exist is an error', code == 1 and 'unknown option' in text)
code, text, _ = run('open', site + '/esc')
said = text + run('read')[1] + run('find', 'here')[1]
said += subprocess.run([launcher, 'tabs'], env=env, capture_output=True, text=True, timeout=30).stdout
step('what a page writes is printed without its control codes', code == 0 and 'Sneaky' in said and 'Esc' in said and 'too' in said and re.search('[\x1b\x07\x9b\x9c]', said) is None)
code, text, _ = run('open', site + '/pop')
code, text, _ = run('click', ref(text, 'button "Open"'))
step('a tab the page opens: the pane follows it, and the agent is told', code == 0 and 'now shows another tab' in text)
followed = run('snapshot')[1].startswith('Second page')
run('eval', 'window.close()')
time.sleep(1.5)
code, text, _ = run('snapshot')
step('when that tab closes, the pane is back on the page that opened it', followed and code == 0 and text.startswith('Pop page'))

# Controls by their names, controls made of plain elements, and what an action waits for.
code, text, _ = run('open', site + '/made')
step('open: what a page made of plain elements to be clicked is a control too', code == 0 and 'clickable "Choose ▾"' in text and 'clickable "Send it"' in text and '"Tea"' not in text)
code, text, _ = run('click', 'Choose ▾')
step('click by name: the one control of that name', code == 0 and re.match(r'clicked [a-z]\d+ "Choose ▾"\n', text) is not None and re.search(r'^\+ [a-z]\d+ clickable "Cake"$', text, re.M) is not None)
code, text, _ = run('click', 'cake')
step('click by name: whatever the case of its letters', code == 0 and re.search(r'^~ [a-z]\d+ clickable "Cake ▾"$', text, re.M) is not None and '- ' in text)
code, text, _ = run('fill', 'Email', 'ada@example.org')
step('fill by name', code == 0 and text.startswith('filled') and 'textbox "Email" ="ada@example.org"' in text and value('document.getElementById("email").value') == 'ada@example.org')
code, text, _ = run('fill', 'Remove', 'x')
step('fill by name: only a field is meant', code == 1 and 'no field of the page is named "Remove"' in text)
code, text, _ = run('click', 'Remove')
step('a name two controls have is refused, with what tells them apart', code == 1 and '2 controls are named "Remove"' in text and 'under "First")' in text and 'under "Second")' in text and value('document.getElementById("said").textContent') == '')
code, text, _ = run('click', 'Cake')
step('click by name: a part of a name is not taken for the name, and what has it is listed', code == 1 and 'is named exactly "Cake"' in text and 'clickable "Cake ▾"' in text)
code, text, _ = run('click', 'No such thing')
step('a name nothing has is said so', code == 1 and 'no control of the page is named "No such thing"' in text)
code, text, took = run('click', 'Send it')
step('an action waits for the answer the page asked for, and says the text that came (%.1f s)' % took, code == 0 and '+ text "sent: ok"' in text and 'sending' not in text and 1.2 < took < 4)
code, text, _ = run('find', 'scone')
step('find: a cell of a table comes with its row', code == 0 and re.search(r'cell "Scone"  \(in view\)  row: Scone \| 5$', text, re.M) is not None)
code, text, _ = run('find', 'Second')
step('find: a named part of the page comes with what it holds', code == 0 and re.search(r'^[a-z]\d+ region "Second"  \(in view\)\n [a-z]\d+ h2 "Second"\n [a-z]\d+ button "Remove"$', text, re.M) is not None and text.count('\n') == 3)
code, text, _ = run('batch', stdin='fill "Email" "grace@example.org"\nclick "Onwards"\nclick "Back to the form"\nfill "Name" "Grace"\n')
step('batch by names: goes on across pages, and prints the page it ends on', code == 0 and 'clicked' in text and '\nOrder form\n' in text and 'textbox "Name" ="Grace"' in text and text.count('\n') < 24)
code, text, _ = run('batch', stdin='click "Next page"\nclick "Nowhere"\nclick "Back to the form"\n')
step('batch by names: stops where a name is not found', code == 1 and 'failed at step 2' in text and '1 steps not done' in text and 'Second page' in text)

# The answer to a sent form: Chrome reloads it by sending the form again, and through this
# connection it does not ask first. So neither the agent nor a key in the pane does it unasked.
def until(what, secs=5.0):
    end = time.time() + secs
    while time.time() < end and not what(): time.sleep(0.05)
    return what()
code, text, took = run('open', site + '/live')
step('open: a worker\'s own script is not waited for (%.1f s)' % took, code == 0 and 'button "Open box"' in text and took < 2)
code, text, _ = run('click', 'Open box')
step('what fades in is waited for, and a box that takes the focus shows what it holds', code == 0 and re.search(r'^\+ [a-z]\d+ dialog "Box"', text, re.M) is not None and re.search(r'^\+ [a-z]\d+ button "Agree"$', text, re.M) is not None and '+ text "Agree to the terms?"' in text)
code, text, _ = run('click', 'Agree')
step('what fades out is waited for', code == 0 and re.search(r'^- [a-z]\d+ dialog "Box"', text, re.M) is not None and re.search(r'^- [a-z]\d+ button "Agree"$', text, re.M) is not None)
code, text, took = run('click', 'Load list')
step('what the page asks for once it has its answer is not waited for long (%.1f s)' % took, code == 0 and '+ text "list: ok"' in text and 'ahead: ok' not in text and took < 1.2)
code, text, _ = run('open', site + '/pay')
code, text, _ = run('click', ref(text, 'button "Pay now"'))
step('a form that is sent: the page is its answer', code == 0 and 'h1 "Paid, receipt 1"' in text and posts == 1)
code, text, _ = run('reload')
step('reload: refused on the answer to a sent form, which it would send again', code == 1 and 'sends the form again' in text and 'reload --resend' in text and posts == 1)
run('done')
n = len(out)
os.write(fd, b'\x12')
asked = shown(b'a reload sends the form again', 4, n)
time.sleep(0.5)
step('ctrl+r in the pane: asks first, and nothing is sent', asked and posts == 1)
os.write(fd, b'z')
time.sleep(0.4)
os.write(fd, b'\x12')
time.sleep(0.8)
step('any other key is a no: the next ctrl+r asks again', posts == 1)
os.write(fd, b'\x12')
step('ctrl+r again: the form is sent again', until(lambda: posts == 2))
code, text, _ = run('reload', '--resend')
step('reload --resend: the agent sends it again, told to', code == 0 and 'receipt 3' in text and posts == 3)
code, text, _ = run('open', site + '/next')
code, text, _ = run('reload')
step('reload: any other page reloads as ever', code == 0 and text.split('\n')[0] == 'Second page' and posts == 3)

# Alt and an arrow go back and forward, but not out of a field that is being typed in.
code, text, _ = run('open', site + '/')
run('click', ref(text, 'textbox "Name"'))
run('done')
os.write(fd, b'one two'); time.sleep(0.6)
os.write(fd, b'\x1b[1;3D'); time.sleep(0.6)
os.write(fd, b'X'); time.sleep(0.6)
typed, at = value('document.getElementById("name").value'), value('location.pathname')
step('alt+left in a field moves by a word and leaves the page where it is: %s on %s' % (typed, at), typed == 'one Xtwo' and at == '/')
run('eval', 'document.activeElement.blur()')
os.write(fd, b'\x1b[1;3D')
step('alt+left outside a field goes back', until(lambda: value('location.pathname') == '/next'))
run('open', site + '/pop')

n = len(out)
code, text, _ = run('done')
def persons():
    # The bar as last drawn: its buttons, and no agent named beside them.
    tail = out[n:]
    at = max(tail.rfind(' ↻ '.encode()), tail.rfind(' ✕ '.encode()))
    return at >= 0 and b'Agent:' not in tail[at:]
step('done: the pane is the person\'s again', code == 0 and until(persons, 7))

n = len(out)
os.write(fd, b'\x14')
shown(b'Chrome tabs', 3, n)
os.write(fd, b'x')
asked = shown('Close “Pop page”'.encode(), 3, n)
os.write(fd, b'z')
time.sleep(0.4)
kept = run('snapshot')[0] == 0
os.write(fd, b'x')
time.sleep(0.3)
os.write(fd, b'x')
closed = shown(b'That tab was closed.', 5, n)
code, text, _ = run('snapshot')
step('x in the list of tabs asks before it closes a tab of the real Chrome', asked and kept and closed and code == 2)
code, text, _ = run('open', site + '/next')
step('open: a pane that shows no tab is asked to show the page, not joined by a second', code == 0 and text.split('\n')[0] == 'Second page')

# A screen that no longer has the page's picture says so when asked to show it again.
WHOLE = rb'a=T,f=100,i=\d+,p=1,q=2,C=1(?:,c=\d+,r=\d+)?,m='
answers = 'gone'
end = time.time() + 10
while time.time() < end and not (gone_at and re.search(WHOLE, out[gone_at:])): time.sleep(0.1)
step('a screen that lost the picture is sent the page again, whole', bool(gone_at and re.search(WHOLE, out[gone_at:])))
n = len(out)
code, text, _ = run('open', site + '/')
step('a terminal that answers is asked after each picture, and the page goes on being drawn', code == 0 and shown(b'a=T,f=100', 8, n) and len(answered) > 1)
answers = None
time.sleep(0.5)
n = len(out)
code, text, _ = run('open', site + '/long')
step('one that stops answering does not stop the page', code == 0 and shown(b'a=T,f=100', 12, n))

n = len(out)
code, text, _ = run('close')
shown(b'\x1b[?1049l', 5, n)
_, status = os.waitpid(pid, 0)
step('close: the viewer quits and gives the terminal back', code == 0 and text.startswith('Closed the pane') and os.waitstatus_to_exitcode(status) == 0)
code, text, _ = run('close')
step('close with no pane: nothing to do, and no failure', code == 0 and 'no Chrome pane' in text)
code, text, _ = run('snapshot')
step('with the pane closed, a command says how to open one', code == 2 and 'No Chrome pane' in text and 'chrome-pane' in text.split('No Chrome pane')[1])
server.shutdown()
sys.exit(1 if fails else 0)
