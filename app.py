"""MIDSnap: Photostrip Maker. Flask + MySQL backend.

The browser still renders the strips (canvas), exactly as before. This server stores the
photostrips, the MIDSnapped records (download / print counts + timestamps), the photo log,
and hosts the customer download links that the QR codes point to (valid for 1 day).
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone

import pymysql
import pymysql.cursors
from dotenv import load_dotenv
from flask import Flask, Response, abort, g, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

load_dotenv()
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DB = dict(
    host=os.getenv('MYSQL_HOST'),
    port=int(os.getenv('MYSQL_PORT')),
    user=os.getenv('MYSQL_USER'),
    password=os.getenv('MYSQL_PASSWORD'),
    database=os.getenv('MYSQL_DATABASE'),
)
PUBLIC_BASE_URL = os.getenv('PUBLIC_BASE_URL', '').rstrip('/')   # what customers' phones can reach
STAFF_USER = os.getenv('STAFF_USER', 'staff')
STAFF_PASSWORD = os.getenv('STAFF_PASSWORD', '')                  # empty = no login (local kiosk)
SHARE_TTL = timedelta(hours=float(os.getenv('SHARE_TTL_HOURS', '24')))   # 1 day
RECENT_LIMIT = 5

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 200 * 1024 * 1024
app.json.sort_keys = False


# ----------------------------------------------------------------------------- helpers
def utcnow():
    """Naive UTC datetime, millisecond precision (matches DATETIME(3))."""
    n = datetime.now(timezone.utc).replace(tzinfo=None)
    return n.replace(microsecond=n.microsecond // 1000 * 1000)


def ms(dt):
    return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000) if dt else None


def jl(v):
    """JSON column -> python (PyMySQL hands JSON back as str/bytes)."""
    if v is None:
        return None
    if isinstance(v, (bytes, bytearray)):
        v = v.decode('utf-8')
    return json.loads(v) if isinstance(v, str) else v


def sniff(b):
    if b[:3] == b'\xff\xd8\xff':
        return 'image/jpeg'
    if b[:8] == b'\x89PNG\r\n\x1a\n':
        return 'image/png'
    return None


def clampf(v, lo, hi, default):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    return default if v != v else max(lo, min(hi, v))


# ----------------------------------------------------------------------------- database
def db():
    if 'db' not in g:
        g.db = pymysql.connect(**DB, charset='utf8mb4', cursorclass=pymysql.cursors.DictCursor,
                               autocommit=False, max_allowed_packet=256 * 1024 * 1024)
    return g.db


def qall(sql, args=()):
    with db().cursor() as c:
        c.execute(sql, args)
        return list(c.fetchall())


def qone(sql, args=()):
    with db().cursor() as c:
        c.execute(sql, args)
        return c.fetchone()


def run(sql, args=()):
    with db().cursor() as c:
        c.execute(sql, args)
        return c.rowcount


def insert(sql, args=()):
    with db().cursor() as c:
        c.execute(sql, args)
        return c.lastrowid


@app.after_request
def _finish(resp):
    """One transaction per request: commit on success, roll back on any 4xx/5xx."""
    conn = g.get('db')
    if conn is not None:
        (conn.commit if resp.status_code < 400 else conn.rollback)()
    resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
    if request.path.startswith('/s/'):
        resp.headers['Cache-Control'] = 'no-store'
        resp.headers['Referrer-Policy'] = 'no-referrer'
        resp.headers['X-Robots-Tag'] = 'noindex, nofollow'
    return resp


@app.teardown_appcontext
def _close(exc):
    conn = g.pop('db', None)
    if conn is not None:
        try:
            if exc:
                conn.rollback()
        finally:
            conn.close()


# ----------------------------------------------------------------------------- access control
@app.before_request
def guard():
    p = request.path
    if p.startswith('/s/') or p.startswith('/static/') or p == '/healthz':
        return None                                  # customer links + assets are public
    if STAFF_PASSWORD:
        a = request.authorization
        ok = bool(a) and hmac.compare_digest((a.username or '').encode(), STAFF_USER.encode()) \
            and hmac.compare_digest((a.password or '').encode(), STAFF_PASSWORD.encode())
        if not ok:
            return Response('Staff login required.', 401, {'WWW-Authenticate': 'Basic realm="MIDSnap"'})
    # CSRF guard: browsers cannot send a custom header cross-site without a CORS preflight
    if request.method in ('POST', 'PUT', 'PATCH', 'DELETE') and request.headers.get('X-MIDSnap') != '1':
        abort(400, 'Bad request.')
    return None


@app.errorhandler(Exception)
def on_error(e):
    is_http = isinstance(e, HTTPException)
    if not is_http:
        app.logger.exception(e)
    if request.path.startswith('/api/'):
        code = e.code if is_http else 500
        msg = (e.description if is_http else 'Server error. Check the server log.')
        return jsonify(error=msg), code
    return e if is_http else Response('Server error.', 500)


# ----------------------------------------------------------------------------- serializers
def recent_items():
    rows = qall('SELECT uid, frame_name, photo_count, layout, created_at FROM snapshots '
                'WHERE is_recent=1 ORDER BY created_at DESC, id DESC LIMIT %s', (RECENT_LIMIT,))
    return [{'id': r['uid'], 'ts': ms(r['created_at']), 'name': r['frame_name'], 'n': r['photo_count'],
             't': f"/api/snaps/{r['uid']}/thumb", 'layout': jl(r['layout'])} for r in rows]


def share_url(token):
    base = PUBLIC_BASE_URL or request.host_url.rstrip('/')
    return f'{base}/s/{token}'


def midsnapped_items(where='', args=()):
    rows = qall(
        'SELECT m.id AS mid, m.download_count, m.print_count, m.last_downloaded_at, m.last_printed_at, '
        's.uid, s.frame_name, s.photo_count, s.layout, s.created_at '
        'FROM midsnapped m JOIN snapshots s ON s.id = m.snapshot_id ' + where +
        ' ORDER BY m.created_at DESC, m.id DESC', args)
    if not rows:
        return []
    ids = [r['mid'] for r in rows]
    ph = ','.join(['%s'] * len(ids))
    dl, pr = {}, {}
    for e in qall(f'SELECT midsnapped_id, kind, created_at FROM usage_events '
                  f'WHERE midsnapped_id IN ({ph}) ORDER BY id', ids):
        (dl if e['kind'] == 'download' else pr).setdefault(e['midsnapped_id'], []).append(ms(e['created_at']))
    links = {}
    for l in qall(f'SELECT midsnapped_id, token, expires_at FROM share_links WHERE midsnapped_id IN ({ph}) '
                  f'AND image IS NOT NULL AND expires_at > %s ORDER BY id', ids + [utcnow()]):
        links[l['midsnapped_id']] = l
    out = []
    for r in rows:
        lk = links.get(r['mid'])
        out.append({
            'id': r['uid'], 'ts': ms(r['created_at']), 'name': r['frame_name'], 'n': r['photo_count'],
            't': f"/api/snaps/{r['uid']}/thumb", 'layout': jl(r['layout']),
            'dl': r['download_count'], 'pr': r['print_count'],
            'lastDl': ms(r['last_downloaded_at']), 'lastPr': ms(r['last_printed_at']),
            'dlt': dl.get(r['mid'], []), 'prt': pr.get(r['mid'], []),
            'link': share_url(lk['token']) if lk else None,
            'linkExp': ms(lk['expires_at']) if lk else None,
        })
    return out


def log_items(where='', args=()):
    rows = qall('SELECT id, shot_at, frame_name, photo_count, downloads, prints, download_times, '
                'print_times, print_details FROM photo_log ' + where + ' ORDER BY shot_at, id', args)
    return [{'id': r['id'], 'ts': ms(r['shot_at']), 'f': r['frame_name'], 'n': r['photo_count'],
             'd': r['downloads'], 'p': r['prints'], 'dt': jl(r['download_times']) or [],
             'pt': jl(r['print_times']) or [], 'pd': jl(r['print_details']),
             't': f"/api/log/{r['id']}/thumb"} for r in rows]


def gc():
    """Drop snapshots nobody references any more (not recent, not MIDSnapped), then unused frames."""
    run('DELETE FROM snapshots WHERE is_recent=0 AND id NOT IN (SELECT snapshot_id FROM midsnapped)')
    run('DELETE FROM frames WHERE id NOT IN (SELECT frame_id FROM snapshots)')


def trim_recent():
    keep = [r['id'] for r in qall('SELECT id FROM snapshots WHERE is_recent=1 '
                                  'ORDER BY created_at DESC, id DESC LIMIT %s', (RECENT_LIMIT,))]
    if keep:
        run('UPDATE snapshots SET is_recent=0 WHERE is_recent=1 AND id NOT IN (%s)' % ','.join(['%s'] * len(keep)), keep)


_last_purge = 0.0


def purge_expired():
    """Wipe the images of expired links now; forget the link rows a week later."""
    now = utcnow()
    run('UPDATE share_links SET image=NULL WHERE expires_at <= %s AND image IS NOT NULL', (now,))
    run('DELETE FROM share_links WHERE expires_at < %s', (now - timedelta(days=7),))


def maybe_purge():
    global _last_purge
    if time.time() - _last_purge > 300:
        _last_purge = time.time()
        purge_expired()


def asset_version():
    try:
        return int(max(os.path.getmtime(os.path.join(BASE_DIR, 'static', 'css', 'app.css')),
                       os.path.getmtime(os.path.join(BASE_DIR, 'static', 'js', 'app.js'))))
    except OSError:
        return 0


# ----------------------------------------------------------------------------- staff app
@app.get('/')
def index():
    maybe_purge()
    boot = {'midsnapped': midsnapped_items(), 'recent': recent_items(), 'log': log_items()}
    resp = Response(render_template('index.html', boot=boot, asset_v=asset_version()), mimetype='text/html')
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@app.get('/healthz')
def healthz():
    return jsonify(ok=True)


def read_upload(field, limit):
    f = request.files.get(field)
    data = f.read(limit + 1) if f else b''
    if len(data) > limit:
        abort(413, 'That file is too large.')
    return data


def clean_layout(raw):
    if not isinstance(raw, list) or not 1 <= len(raw) <= 12:
        abort(400, 'Invalid strip layout.')
    return [{'has': False,
             'z': clampf((r or {}).get('z') if isinstance(r, dict) else None, 1, 5, 1),
             'ox': clampf((r or {}).get('ox') if isinstance(r, dict) else None, -5, 5, 0),
             'oy': clampf((r or {}).get('oy') if isinstance(r, dict) else None, -5, 5, 0)} for r in raw]


@app.post('/api/snaps')
def create_snap():
    """MIDSnap-it: store the strip (frame + photos + crops) and open its MIDSnapped record."""
    try:
        meta = json.loads(request.form.get('meta', ''))
        if not isinstance(meta, dict):
            raise ValueError
    except ValueError:
        abort(400, 'Invalid request.')
    layout = clean_layout(meta.get('layout'))
    name = (str(meta.get('name') or '').strip() or 'frame.svg')[:255]

    frame = read_upload('frame', 25 * 1024 * 1024)
    if not re.search(rb'<svg[\s>]', frame[:4000], re.I):
        abort(400, 'The frame is not a valid SVG.')
    thumb = read_upload('thumb', 2 * 1024 * 1024)
    if sniff(thumb) != 'image/jpeg':
        abort(400, 'The strip thumbnail is missing.')
    photos = []
    for i, row in enumerate(layout):
        f = request.files.get(f'photo{i}')
        if f is None:
            continue
        data = f.read(40 * 1024 * 1024 + 1)
        if len(data) > 40 * 1024 * 1024:
            abort(413, f'Photo {i + 1} is too large.')
        mime = sniff(data)
        if mime is None:
            abort(400, f'Photo {i + 1} must be a PNG or JPG.')
        row['has'] = True
        photos.append((i, mime, data))
    if not photos:
        abort(400, 'Add at least one photo first.')

    now, uid = utcnow(), secrets.token_hex(8)
    sha = hashlib.sha256(frame).hexdigest()
    fr = qone('SELECT id FROM frames WHERE sha256=%s', (sha,))
    frame_id = fr['id'] if fr else insert(
        'INSERT INTO frames (sha256, name, svg, created_at) VALUES (%s,%s,%s,%s)', (sha, name, frame, now))
    snap_id = insert(
        'INSERT INTO snapshots (uid, frame_id, frame_name, photo_count, layout, thumb, is_recent, created_at) '
        'VALUES (%s,%s,%s,%s,%s,%s,1,%s)', (uid, frame_id, name, len(photos), json.dumps(layout), thumb, now))
    for i, mime, data in photos:
        insert('INSERT INTO snapshot_photos (snapshot_id, row_idx, mime, data) VALUES (%s,%s,%s,%s)',
               (snap_id, i, mime, data))
    insert('INSERT INTO midsnapped (snapshot_id, created_at) VALUES (%s,%s)', (snap_id, now))
    log_id = insert(
        'INSERT INTO photo_log (snapshot_uid, shot_at, frame_name, photo_count, thumb, download_times, print_times) '
        'VALUES (%s,%s,%s,%s,%s,%s,%s)', (uid, now, name, len(photos), thumb, '[]', '[]'))
    trim_recent()
    gc()
    return jsonify(midsnapped=midsnapped_items('WHERE s.uid=%s', (uid,))[0],
                   recent=recent_items(), log=log_items('WHERE id=%s', (log_id,))[0])


def blob_response(data, mime, svg=False):
    resp = Response(data, mimetype=mime)
    resp.headers['Cache-Control'] = 'private, max-age=3600'
    if svg:  # frames are user-supplied SVG: never let one run scripts if opened directly
        resp.headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    return resp


@app.get('/api/snaps/<uid>/thumb')
def snap_thumb(uid):
    r = qone('SELECT thumb FROM snapshots WHERE uid=%s', (uid,))
    return blob_response(r['thumb'], 'image/jpeg') if r else abort(404)


@app.get('/api/snaps/<uid>/frame')
def snap_frame(uid):
    r = qone('SELECT f.svg FROM snapshots s JOIN frames f ON f.id = s.frame_id WHERE s.uid=%s', (uid,))
    return blob_response(r['svg'], 'image/svg+xml', svg=True) if r else abort(404)


@app.get('/api/snaps/<uid>/photos/<int:i>')
def snap_photo(uid, i):
    r = qone('SELECT p.mime, p.data FROM snapshot_photos p JOIN snapshots s ON s.id = p.snapshot_id '
             'WHERE s.uid=%s AND p.row_idx=%s', (uid, i))
    return blob_response(r['data'], r['mime']) if r else abort(404)


@app.get('/api/log/<int:lid>/thumb')
def log_thumb(lid):
    r = qone('SELECT thumb FROM photo_log WHERE id=%s', (lid,))
    return blob_response(r['thumb'], 'image/jpeg') if r else abort(404)


# ---- MIDSnapped records
@app.get('/api/midsnapped')
def list_midsnapped():
    return jsonify(midsnapped_items())


@app.delete('/api/midsnapped/<uid>')
def delete_midsnapped(uid):
    n = run('DELETE m FROM midsnapped m JOIN snapshots s ON s.id = m.snapshot_id WHERE s.uid=%s', (uid,))
    if not n:
        abort(404, 'That strip is already gone.')
    gc()
    return '', 204


PAPERS, QUALS, FMTS = {'glossy', 'matte'}, {'draft', 'standard', 'high'}, {'png', 'jpg'}


def clean_details(d):
    d = d if isinstance(d, dict) else {}
    try:
        copies = max(1, min(99, int(d.get('copies') or 1)))
    except (TypeError, ValueError):
        copies = 1
    return {'fmt': d.get('fmt') if d.get('fmt') in FMTS else 'png', 'copies': copies,
            'paper': d.get('paper') if d.get('paper') in PAPERS else 'glossy',
            'quality': d.get('quality') if d.get('quality') in QUALS else 'high',
            'borderless': bool(d.get('borderless'))}


@app.post('/api/midsnapped/<uid>/events')
def add_event(uid):
    """Count a download or a print (and log its timestamp)."""
    m = qone('SELECT m.id FROM midsnapped m JOIN snapshots s ON s.id = m.snapshot_id WHERE s.uid=%s', (uid,))
    if not m:
        abort(404, 'That strip is no longer in MIDSnapped.')
    d = request.get_json(silent=True) or {}
    kind = d.get('kind')
    if kind not in ('download', 'print'):
        abort(400, 'Unknown event.')
    copies, details, now = 1, None, utcnow()
    if kind == 'print':
        try:
            copies = max(1, min(99, int(d.get('copies') or 1)))
        except (TypeError, ValueError):
            copies = 1
        details = clean_details(d.get('details'))
    insert('INSERT INTO usage_events (midsnapped_id, kind, copies, details, created_at) VALUES (%s,%s,%s,%s,%s)',
           (m['id'], kind, copies, json.dumps(details) if details else None, now))
    if kind == 'download':
        run('UPDATE midsnapped SET download_count = download_count + 1, last_downloaded_at=%s WHERE id=%s',
            (now, m['id']))
    else:
        run('UPDATE midsnapped SET print_count = print_count + %s, last_printed_at=%s WHERE id=%s',
            (copies, now, m['id']))
    log = qone('SELECT id, download_times, print_times FROM photo_log WHERE snapshot_uid=%s '
               'ORDER BY id DESC LIMIT 1 FOR UPDATE', (uid,))
    log_out = None
    if log:
        dt, pt = jl(log['download_times']) or [], jl(log['print_times']) or []
        if kind == 'download':
            dt.append(ms(now))
            run('UPDATE photo_log SET downloads = downloads + 1, download_times=%s WHERE id=%s',
                (json.dumps(dt), log['id']))
        else:
            pt += [ms(now)] * copies
            run('UPDATE photo_log SET prints = prints + %s, print_times=%s, print_details=%s WHERE id=%s',
                (copies, json.dumps(pt), json.dumps(details), log['id']))
        log_out = log_items('WHERE id=%s', (log['id'],))[0]
    return jsonify(midsnapped=midsnapped_items('WHERE s.uid=%s', (uid,))[0], log=log_out)


def local_warning():
    host = (request.host or '').split(':')[0].strip('[]').lower()
    if not PUBLIC_BASE_URL and host in ('localhost', '127.0.0.1', '::1'):
        return 'Note: this link points to localhost, so phones cannot open it. Set PUBLIC_BASE_URL on the server.'
    return ''


@app.post('/api/midsnapped/<uid>/share')
def create_share(uid):
    """Store the rendered JPG and create a customer download link that expires in 1 day."""
    maybe_purge()
    m = qone('SELECT m.id FROM midsnapped m JOIN snapshots s ON s.id = m.snapshot_id WHERE s.uid=%s', (uid,))
    if not m:
        abort(404, 'That strip is no longer in MIDSnapped.')
    data = read_upload('image', 25 * 1024 * 1024)
    if sniff(data) != 'image/jpeg':
        abort(400, 'The strip image is missing or is not a JPG.')
    run('DELETE FROM share_links WHERE midsnapped_id=%s', (m['id'],))      # one live link per strip
    token, now = secrets.token_urlsafe(24), utcnow()                         # 32 URL-safe characters
    exp = now + SHARE_TTL
    insert('INSERT INTO share_links (midsnapped_id, token, image, created_at, expires_at) VALUES (%s,%s,%s,%s,%s)',
           (m['id'], token, data, now, exp))
    return jsonify(url=share_url(token), expires=ms(exp), warn=local_warning())


@app.delete('/api/midsnapped/<uid>/share')
def delete_share(uid):
    run('DELETE l FROM share_links l JOIN midsnapped m ON m.id = l.midsnapped_id '
        'JOIN snapshots s ON s.id = m.snapshot_id WHERE s.uid=%s', (uid,))
    return '', 204


# ---- recent strips
@app.delete('/api/recent/<uid>')
def delete_recent(uid):
    run('UPDATE snapshots SET is_recent=0 WHERE uid=%s', (uid,))
    gc()
    return '', 204


@app.delete('/api/recent')
def clear_recent():
    run('UPDATE snapshots SET is_recent=0 WHERE is_recent=1')
    gc()
    return '', 204


# ---- photo log
@app.get('/api/log')
def list_log():
    return jsonify(log_items())


@app.delete('/api/log/<int:lid>')
def delete_log(lid):
    run('DELETE FROM photo_log WHERE id=%s', (lid,))
    return '', 204


@app.delete('/api/log')
def clear_log():
    run('DELETE FROM photo_log')
    return '', 204


# ----------------------------------------------------------------------------- customer pages (public)
def link_state(token):
    """-> (row, state) with state in 'ok' | 'expired' | 'missing'. Never loads the image."""
    r = qone('SELECT id, expires_at, (image IS NOT NULL) AS has_image FROM share_links WHERE token=%s', (token,))
    if not r:
        return None, 'missing'
    if r['expires_at'] <= utcnow() or not r['has_image']:
        return r, 'expired'
    return r, 'ok'


def gone_page(state):
    if state == 'expired':
        return render_template('share_gone.html', asset_v=asset_version(), title='This link has expired',
                               msg='Photostrip links are valid for 1 day. Please ask the MIDSnap staff for a new QR code.'), 410
    return render_template('share_gone.html', asset_v=asset_version(), title='Link not found',
                           msg='Check that you scanned the whole QR code, or ask the MIDSnap staff for help.'), 404


@app.get('/s/<token>')
def share_page(token):
    r, state = link_state(token)
    if state != 'ok':
        return gone_page(state)
    exp = r['expires_at']
    return render_template('share.html', token=token, asset_v=asset_version(),
                           expires_iso=exp.strftime('%Y-%m-%dT%H:%M:%SZ'),
                           expires_text=exp.strftime('%Y-%m-%d %H:%M UTC'))


def share_image_row(token):
    r = qone('SELECT l.image, l.expires_at, s.created_at FROM share_links l '
             'JOIN midsnapped m ON m.id = l.midsnapped_id JOIN snapshots s ON s.id = m.snapshot_id '
             'WHERE l.token=%s', (token,))
    if not r:
        abort(404)
    if r['expires_at'] <= utcnow() or not r['image']:
        abort(410)
    return r


@app.get('/s/<token>/image')
def share_image(token):
    return Response(share_image_row(token)['image'], mimetype='image/jpeg')


@app.get('/s/<token>/download')
def share_download(token):
    r = share_image_row(token)
    run('UPDATE share_links SET download_count = download_count + 1 WHERE token=%s', (token,))
    name = f"midsnap-{r['created_at']:%Y%m%d%H%M%S}-102x152mm.jpg"
    resp = Response(r['image'], mimetype='image/jpeg')
    resp.headers['Content-Disposition'] = f'attachment; filename="{name}"'
    return resp


# ----------------------------------------------------------------------------- CLI
@app.cli.command('init-db')
def init_db_cmd():
    with open(os.path.join(BASE_DIR, 'schema.sql'), encoding='utf-8') as fh:
        sql = re.sub(r'--[^\n]*', '', fh.read())
    conn = pymysql.connect(**DB, charset='utf8mb4', autocommit=True)
    with conn.cursor() as c:
        for stmt in (s.strip() for s in sql.split(';')):
            if stmt:
                c.execute(stmt)
    conn.close()
    print('Tables are ready.')


@app.cli.command('purge-expired')
def purge_cmd():
    """Wipe expired customer links (run from cron, e.g. every 15 minutes)."""
    conn = pymysql.connect(**DB, charset='utf8mb4', cursorclass=pymysql.cursors.DictCursor, autocommit=True)
    now = utcnow()
    with conn.cursor() as c:
        c.execute('UPDATE share_links SET image=NULL WHERE expires_at <= %s AND image IS NOT NULL', (now,))
        wiped = c.rowcount
        c.execute('DELETE FROM share_links WHERE expires_at < %s', (now - timedelta(days=7),))
    conn.close()
    print(f'Wiped {wiped} expired image(s).')


if __name__ == '__main__':
    app.run()
