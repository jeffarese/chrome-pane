"""Runs the viewer in a pty that plays the terminal, then clicks, types and navigates.

    viewer_test.py <launcher> <chrome profile> <state folder> [<cell width>x<cell height> [<zoom>]]

A cell 26 pixels high or more makes the viewer treat the screen as Retina (2 pixels per page
pixel): then moving frames come at half size and the sharp picture follows once the page rests.
<zoom> is the zoom the profile gives every page (0.8 for 80%): the page then has more CSS pixels
than the window has points, and a click must still land where it was made.
"""
import base64, os, pty, select, struct, sys, time, fcntl, termios, urllib.parse, re, subprocess

launcher, profile, state = sys.argv[1:4]
cell_w, cell_h = (int(v) for v in (sys.argv[4] if len(sys.argv) > 4 else '10x20').split('x'))
scale = 2 if cell_h >= 26 else 1
zoom = float(sys.argv[5]) if len(sys.argv) > 5 else 1.0
COLS, ROWS = 100, 41
full = (COLS * cell_w, (ROWS - 1) * cell_h)
# A button that reports where it was clicked and sets a square moving for 1.5 s, a field, and a
# square that blinks like a caret does.
page = ('<body style="margin:0;background:#fff"><button id=b style="position:absolute;left:100px;top:100px;width:200px;height:60px" '
        'onclick="document.title=\'clicked@\'+event.clientX+\',\'+event.clientY;go()">b</button>'
        '<input id=i style="position:absolute;left:100px;top:200px;width:300px;height:30px" oninput="document.title=\'typed:\'+this.value">'
        '<div id=k style="position:absolute;left:500px;top:100px;width:40px;height:40px;background:#000"></div>'
        '<div id=m style="position:absolute;left:0;top:400px;width:60px;height:60px;background:#08f"></div>'
        '<button id=f style="position:absolute;left:500px;top:200px;width:100px;height:40px" onclick="flood()">f</button>'
        '<script>setInterval(()=>{k.style.visibility=k.style.visibility?\'\':\'hidden\'},700);'
        'function go(){const t0=performance.now();(function f(){const t=performance.now()-t0;'
        'if(t<1500){m.style.left=(t/5)+\'px\';requestAnimationFrame(f)}else m.style.left=\'0px\'})()}'
        'function flood(){const t0=performance.now();(function f(){const t=performance.now()-t0;'
        'if(t<1500){document.body.style.background=\'hsl(\'+Math.round(t/4)+\',80%,70%)\';requestAnimationFrame(f)}else document.body.style.background=\'#fff\'})()}</script>')
url = 'data:text/html,' + urllib.parse.quote(page)
env = dict(os.environ, CHROME_PANE_STATE=state, TERM='xterm-256color')
pid, fd = pty.fork()
if pid == 0:
    os.execve(launcher, [launcher, 'view', url, '--user-data-dir', profile], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
out = b''
def pump(until=None, secs=8.0):
    """Reads output, answering the terminal queries, until `until` shows up in what is new."""
    global out
    start, seen = len(out), time.time()
    while time.time() - seen < secs:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: data = os.read(fd, 1 << 16)
            except OSError: return False
            if not data: return False
            out += data
            if b'\x1b[16t' in data: os.write(fd, b'\x1b[6;%d;%dt' % (cell_h, cell_w))
            if b'\x1b[?1016$p' in data: os.write(fd, b'\x1b[?1016;1$y')
            if b'\x1b[c' in data: os.write(fd, b'\x1b[?62c')
        if until is not None and until in out[start:]: return True
    return until is None
def page_value(expr, prefix='data:'):
    here = os.path.dirname(os.path.abspath(__file__))
    return subprocess.run([os.environ.get('NODE', 'node'), os.path.join(here, 'eval.mjs'), expr, prefix], env=env, capture_output=True, text=True).stdout.strip()
def step(name, ok):
    print(('ok   ' if ok else 'FAIL ') + name); return ok
def click(css_x, css_y):
    """A click on that point of the page, as the terminal reports it: in pixels, under the bar."""
    x, y = round(css_x * zoom * scale), round(css_y * zoom * scale) + cell_h
    os.write(fd, b'\x1b[<0;%d;%dM' % (x, y)); os.write(fd, b'\x1b[<0;%d;%dm' % (x, y))
IMAGE = re.compile(rb'\x1b\[(\d+);(\d+)H\x1b_Ga=T,f=100,i=(\d+),p=1,q=2,C=1,c=(\d+),r=(\d+),m=\d;([A-Za-z0-9+/=]{44})')
PART = re.compile(rb'\x1b\[(\d+);(\d+)H\x1b_Ga=T,f=100,i=(\d+),p=1,q=2,C=1,c=(\d+),r=(\d+),z=\d+,m=\d;')
def parts(data):
    """Each part of a picture sent to lay over it: (row, col, cells wide, cells high)."""
    return [(int(m.group(1)), int(m.group(2)), int(m.group(4)), int(m.group(5))) for m in PART.finditer(data)]
def images(data):
    """Each picture sent: (row, col, cells wide, cells high, pixels wide, pixels high)."""
    found = []
    for m in IMAGE.finditer(data):
        head = base64.b64decode(m.group(6))
        found.append((int(m.group(1)), int(m.group(2)), int(m.group(4)), int(m.group(5))) + struct.unpack('>II', head[16:24]))
    return found

ok = True
ok &= step('a frame is drawn', pump(b'\x1b_Ga=T,f=100', 20))
pump(None, 1.5)
last = images(out)[-1]
# The first frame can still have the size the tab had in Chrome; the page settles on the pane's.
ok &= step('the page fills the area under the bar, at full size: %s' % (last,), last == (2, 1, COLS, ROWS - 1) + full)
if scale > 1:
    pump(None, 3.5)
    blink = parts(out)
    ok &= step('a square that blinks costs its own cells, not a picture: %d parts, %s' % (len(blink), sorted(set(b[2:] for b in blink))), len(blink) >= 3 and all(b[2] <= 8 and b[3] <= 6 for b in blink) and len(images(out)) <= 3)
if zoom != 1:
    ratio = page_value('devicePixelRatio')
    ok &= step('the page is zoomed to %d%%: %s device pixels a CSS pixel' % (zoom * 100, ratio), abs(float(ratio or 0) - scale * zoom) < 0.01)
n = len(out)
click(200, 130)
pump(None, 1.2)
title = page_value('document.title')
ok &= step('a click reaches the page where it was made: ' + title, title == 'clicked@200,130')
ok &= step('the bar shows the new title', pump(b'clicked@200,130', 4) or b'clicked@200,130' in out)
pump(None, 2.0)
# The square is 60 px high, at 400 px down the page: under the bar, that is these rows of cells
# (and one more each side, where a picture scaled down from two pixels a point blurs its edge).
cell_pt = cell_h / scale
rows_of_square = (int(400 * zoom // cell_pt) + 2, int(-(-460 * zoom // cell_pt)) + 1)
small = parts(out[n:])
if os.environ.get('SHOW'): print('rows of the square', rows_of_square, 'parts', sorted(set(small)))
ok &= step('while a square moves, only its cells are sent, not the page: %d parts, %d whole pictures, %d KB' % (len(small), len(images(out[n:])), (len(out) - n) // 1024),
           len(small) > 5 and len(images(out[n:])) <= 1 and any(p[0] >= rows_of_square[0] - 1 and p[0] + p[3] - 1 <= rows_of_square[1] + 1 and p[3] <= 5 for p in small) and len(out) - n < 600000)
n = len(out)
click(550, 220)
pump(None, 3.0)
moved = images(out[n:])
if scale > 1:
    half = (full[0] // scale, full[1] // scale)
    ok &= step('while the whole page changes, frames come at half size: %d of %d' % (sum(1 for i in moved if i[4:] == half), len(moved)), any(i[4:] == half for i in moved))
    ok &= step('once it rests, the sharp picture follows: %s' % (moved[-1][4:],), moved[-1][4:] == full)
else:
    ok &= step('every frame is full size: %d' % len(moved), len(moved) > 3 and all(i[4:] == full for i in moved))
click(150, 215); pump(None, 0.4)
os.write(fd, 'héllo W'.encode())
pump(None, 0.6)
v = page_value('document.getElementById("i").value')
ok &= step('typing reaches the focused field: ' + v, v == 'héllo W')
os.write(fd, b'\x1b[200~ pasted\x1b[201~')
pump(None, 0.6)
v = page_value('document.getElementById("i").value')
ok &= step('a paste is inserted: ' + v, v == 'héllo W pasted')
os.write(fd, b'\x0c'); pump(b'Enter go', 3)
os.write(fd, b'about:blank\r')
pump(None, 1.0)
ok &= step('the address bar navigates', page_value('location.href', 'about:blank') == 'about:blank' and page_value('1') == 'NO-TAB')
os.write(fd, b'\x14')
ok &= step('ctrl+t lists the tabs', pump(b'Chrome tabs', 5))
os.write(fd, b'\x1b'); pump(None, 0.6)
n = len(out)
os.write(fd, b'\x11')
pump(b'\x1b[?1049l', 5)
_, status = os.waitpid(pid, 0)
ok &= step('ctrl+q leaves cleanly (exit %d)' % os.waitstatus_to_exitcode(status), os.waitstatus_to_exitcode(status) == 0 and b'\x1b[?1049l' in out[n:] and b'\x1b[?25h' in out[n:])
print('pictures sent: %d, parts of pictures: %d, bytes written to the terminal: %d' % (len(images(out)), len(parts(out)), len(out)))
sys.exit(0 if ok else 1)
