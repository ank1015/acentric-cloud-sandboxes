// The agent: a small Python program the gateway sends with every call and runs
// with `python3 -c`, so nothing is installed in the sandbox. It keeps each
// execution's state in files under `<root>/<id>/`, which survive any
// disconnect:
//
//   main.py     the code
//   supervisor  the PID of the `start` process that runs and watches it
//   started     start time, Unix milliseconds
//   pgid        the process group Python leads (Python's own PID)
//   out.log     stdout and stderr, in the order written
//   end         JSON {code | signal, endedAt}, written once Python has ended
//   killed      time `kill` was asked, Unix milliseconds
//   timed_out   time `maxRuntimeMs` ran out
//
// Every command prints one JSON line on stdout. Written for Python 3.6+.

export const AGENT_PY = String.raw`
import base64, hashlib, json, os, re, shutil, signal, subprocess, sys, time

ID = re.compile(r'^[A-Za-z0-9_-]{1,64}$')

def now():
    return int(time.time() * 1000)

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
    sys.stdout.flush()

def text(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except (IOError, OSError):
        return None

def number(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None

def put(path, value):
    with open(path + '.tmp', 'w') as f:
        f.write(value)
    os.rename(path + '.tmp', path)

def alive(root, id):
    pid = text(os.path.join(root, id, 'supervisor'))
    if not pid:
        return False
    if os.path.isdir('/proc'):
        try:
            with open('/proc/%s/cmdline' % pid, 'rb') as f:
                args = f.read().split(b'\0')
        except (IOError, OSError):
            return False
        return b'start' in args and root.encode() in args and id.encode() in args
    try:
        os.kill(int(pid), 0)
    except PermissionError:
        return True
    except (OSError, ValueError):
        return False
    return True

def state(root, id):
    d = os.path.join(root, id)
    if not os.path.isdir(d):
        return None
    end = text(os.path.join(d, 'end'))
    running = False
    if end is None:
        running = alive(root, id)
        if not running:
            end = text(os.path.join(d, 'end'))
    try:
        size = os.path.getsize(os.path.join(d, 'out.log'))
    except OSError:
        size = 0
    s = {
        'id': id,
        'pid': number(text(os.path.join(d, 'supervisor'))),
        'startedAt': number(text(os.path.join(d, 'started'))),
        'now': now(),
        'size': size,
    }
    killed = number(text(os.path.join(d, 'killed')))
    if end is None:
        s['status'] = 'running' if running else 'lost'
        return s
    end = json.loads(end)
    s['endedAt'] = end['endedAt']
    if 'signal' in end:
        s['signal'] = end['signal']
    else:
        s['exitCode'] = end['code']
    if os.path.exists(os.path.join(d, 'timed_out')):
        s['status'] = 'timed_out'
    elif killed is not None and killed <= end['endedAt']:
        s['status'] = 'killed'
    elif 'signal' in end:
        s['status'] = 'killed'
    else:
        s['status'] = 'exited'
    return s

def output(root, id, cursor, size, limit, mode):
    if cursor > size:
        return {'error': 'cursor'}
    available = size - cursor
    if available == 0:
        return {'head': ''}
    with open(os.path.join(root, id, 'out.log'), 'rb') as f:
        f.seek(cursor)
        if available <= limit or mode == 'head':
            return {'head': base64.b64encode(f.read(min(available, limit))).decode()}
        head = f.read(limit // 2)
        tail_start = size - (limit - limit // 2)
        f.seek(tail_start)
        tail = f.read(limit - limit // 2)
    return {
        'head': base64.b64encode(head).decode(),
        'tail': base64.b64encode(tail).decode(),
        'tailStart': tail_start,
    }

def answer(root, id, cursor, limit, mode):
    s = state(root, id)
    if s is None:
        return {'missing': True}
    result = {'state': s}
    result.update(output(root, id, cursor, s['size'], limit, mode))
    return result

def detach():
    """Leaves the caller: a child carries on in a session of its own, the parent
    prints the child's first line and exits. For providers whose commands must end."""
    read_end, write_end = os.pipe()
    if os.fork():
        os.close(write_end)
        data = b''
        while True:
            chunk = os.read(read_end, 65536)
            if not chunk:
                break
            data += chunk
        sys.stdout.write(data.decode())
        sys.stdout.flush()
        os._exit(0)
    os.close(read_end)
    os.setsid()
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    sys.stdout = os.fdopen(write_end, 'w')

def start(root, id, code, cwd, python, max_ms, env, detached):
    if detached:
        detach()
    d = os.path.join(root, id)
    try:
        os.makedirs(root)
    except OSError:
        pass
    try:
        os.mkdir(d)
    except OSError:
        if not os.path.isdir(d):
            raise
        for _ in range(50):
            if text(os.path.join(d, 'started')) is not None:
                break
            time.sleep(0.05)
        try:
            with open(os.path.join(d, 'main.py'), 'rb') as f:
                digest = hashlib.sha256(f.read()).hexdigest()
        except (IOError, OSError):
            digest = None
        emit({'exists': True, 'sha256': digest, 'state': state(root, id)})
        return
    with open(os.path.join(d, 'main.py'), 'wb') as f:
        f.write(base64.b64decode(code))
    put(os.path.join(d, 'supervisor'), str(os.getpid()))
    started = now()
    put(os.path.join(d, 'started'), str(started))
    log = open(os.path.join(d, 'out.log'), 'ab', 0)
    cwd = cwd or os.path.expanduser('~')
    process = None
    if not os.path.isdir(cwd):
        log.write(('acentric: no such directory: %s\n' % cwd).encode())
    else:
        try:
            environment = dict(os.environ)
            environment.update(json.loads(base64.b64decode(env).decode()) if env else {})
            process = subprocess.Popen(
                [python, '-u', os.path.join(d, 'main.py')],
                cwd=cwd, env=environment,
                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                start_new_session=True)
        except OSError as e:
            log.write(('acentric: cannot run %s: %s\n' % (python, e.strerror)).encode())
    if process is None:
        put(os.path.join(d, 'end'), json.dumps({'code': 127, 'endedAt': now()}))
        emit({'startedAt': started, 'pid': os.getpid()})
        return
    put(os.path.join(d, 'pgid'), str(process.pid))
    emit({'startedAt': started, 'pid': os.getpid()})
    sys.stdout.close()
    try:
        code = process.wait(max_ms / 1000.0 if max_ms else None)
    except subprocess.TimeoutExpired:
        put(os.path.join(d, 'timed_out'), str(now()))
        group(process.pid, signal.SIGKILL)
        code = process.wait()
    end = {'code': code} if code >= 0 else {'signal': signal_name(-code)}
    end['endedAt'] = now()
    put(os.path.join(d, 'end'), json.dumps(end))

def signal_name(number):
    try:
        return signal.Signals(number).name
    except ValueError:
        return 'SIG%d' % number

def group(pgid, sig):
    if pgid is None or pgid <= 1:
        return
    try:
        os.killpg(pgid, sig)
    except OSError:
        pass

def wait(root, id, cursor, yield_ms, limit, mode, final):
    deadline = time.time() + yield_ms / 1000.0
    while True:
        s = state(root, id)
        if s is None:
            emit({'missing': True})
            return
        if s['status'] != 'running' or (mode == 'head' and s['size'] - cursor >= limit):
            break
        if time.time() >= deadline:
            if not final:
                emit({'state': s})
                return
            break
        time.sleep(0.1)
    emit(answer(root, id, cursor, limit, mode))

def until_ended(root, id, seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        s = state(root, id)
        if s is None or s['status'] != 'running':
            return
        time.sleep(0.05)

def kill(root, id, cursor, grace_ms, limit, mode):
    d = os.path.join(root, id)
    s = state(root, id)
    if s is None:
        emit({'missing': True})
        return
    pgid = number(text(os.path.join(d, 'pgid')))
    if s['status'] == 'running':
        put(os.path.join(d, 'killed'), str(now()))
        group(pgid, signal.SIGTERM)
        until_ended(root, id, grace_ms / 1000.0)
        if state(root, id)['status'] == 'running':
            group(pgid, signal.SIGKILL)
            until_ended(root, id, 5)
    # Children that stayed in the group outlive Python; end them too.
    group(pgid, signal.SIGKILL)
    emit(answer(root, id, cursor, limit, mode))

def entries(root):
    try:
        names = os.listdir(root)
    except OSError:
        return []
    return [n for n in names if ID.match(n) and os.path.isdir(os.path.join(root, n))]

def listing(root):
    states = [state(root, n) for n in entries(root)]
    emit({'executions': [s for s in states if s is not None]})

def remove(root, id):
    s = state(root, id)
    if s is None:
        return 'missing'
    if s['status'] == 'running':
        return 'running'
    shutil.rmtree(os.path.join(root, id), ignore_errors=True)
    return 'deleted'

def main(args):
    command, root = args[0], args[1]
    if command == 'start':
        start(root, args[2], args[3], args[4], args[5], number(args[6]), args[7], args[8] == '1')
    elif command == 'wait':
        wait(root, args[2], int(args[3]), int(args[4]), int(args[5]), args[6], args[7] == '1')
    elif command == 'kill':
        kill(root, args[2], int(args[3]), int(args[4]), int(args[5]), args[6])
    elif command == 'list':
        listing(root)
    elif command == 'delete':
        emit({'result': remove(root, args[2])})
    elif command == 'delete-all':
        results = dict((n, remove(root, n)) for n in entries(root))
        emit({
            'deleted': [n for n, r in results.items() if r == 'deleted'],
            'running': [n for n, r in results.items() if r == 'running'],
        })

main(sys.argv[1:])
`;
