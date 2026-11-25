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
        + '<p style="margin-top:900px"><button onclick="document.title=\'bottom clicked\'">Bottom button</button>')
# A page that tries to talk to the terminal: an Esc sequence in its title and its text, and the
# one-byte forms of Esc [ and of the end of a sequence.
ESC = '<!doctype html><title>Sneaky\x1b]52;c;eA==\x07 title</title><body><h1>Esc\x1b[31m here</h1><p>and \x9b31m too\x9c'
POP = '<!doctype html><title>Pop page</title><body><h1>Pop</h1><button onclick="window.open(\'/next\')">Open</button>'
PAGES = {'/': FORM, '/next': NEXT, '/long': LONG, '/esc': ESC, '/pop': POP}

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGES.get(self.path.split('?')[0])
        self.send_response(200 if body else 404)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write((body or 'not here').encode())
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

n = len(out)
code, text, took = run('click', delete)
step('click: a question the page asks is told (%.1f s)' % took, code == 0 and 'dialog (confirm): "Really delete?"' in text and took < 5)
step('the pane shows the question', shown(b'confirm: Really delete?', 3, n))
code, text, took = run('snapshot')
step('with a question open, a command says so at once (%.1f s)' % took, code == 1 and 'dialog (confirm)' in text and took < 3)
code, text, _ = run('dialog', 'dismiss')
step('dialog dismiss: the pane answers it', code == 0 and text.strip() == 'dismissed the dialog' and value('document.getElementById("status").textContent') == 'kept')
run('click', delete)
code, text, _ = run('dialog', 'accept')
step('dialog accept', code == 0 and value('document.getElementById("status").textContent') == 'deleted')
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
nav, chapter = ref(text, 'navigation'), ref(text, 'h2 "Chapter 2"')
step('the cut names the part to ask for', '(snapshot --in %s, or find <text>)' % nav in text)
code, text, _ = run('snapshot', '--in', nav)
step('snapshot --in: one part, whole', code == 0 and 'link "Entry 30"' in text and 'Long page' not in text)
code, text, _ = run('scroll', chapter)
at = re.search(r'view \d+x\d+ at (\d+) of', text)
step('scroll to a heading by its ref', code == 0 and at is not None and int(at.group(1)) > 500 and '%s h2 "Chapter 2"\n' % chapter in text)
code, text, _ = run('scroll', 'bottom')
at = re.search(r'view \d+x\d+ at (\d+) of', text)
step('scroll: prints what is now in view', code == 0 and at is not None and int(at.group(1)) > 1000 and 'button "Bottom button"' in text)
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

n = len(out)
code, text, _ = run('done')
step('done: the pane is the person\'s again', code == 0 and shown(' ‹  ›  ↻ '.encode(), 7, n))

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
os.write(fd, b'\x11')
shown(b'\x1b[?1049l', 5, n)
_, status = os.waitpid(pid, 0)
code, text, _ = run('snapshot')
step('with the pane closed, a command says how to open one', os.waitstatus_to_exitcode(status) == 0 and code == 2 and 'No Chrome pane' in text and 'chrome-pane' in text.split('No Chrome pane')[1])
server.shutdown()
sys.exit(1 if fails else 0)
