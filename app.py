"""MIDSnap: Photostrip Maker. Flask + MySQL backend.

The browser still renders the strips (canvas), exactly as before. This server stores the
photostrips, the MIDSnapped records (download / print counts + timestamps), the photo log,
and hosts the customer download links that the QR codes point to: the high-quality PNG is uploaded to
Cloudinary and the link stops working after 24 hours (the file is deleted from Cloudinary).
"""
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone

import cloudinary
import cloudinary.uploader
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
STAFF_USER = os.getenv('STAFF_USER', 'staff')
STAFF_PASSWORD = os.getenv('STAFF_PASSWORD', '')                  # empty = no login (local kiosk)
SHARE_TTL = timedelta(hours=float(os.getenv('SHARE_TTL_HOURS', '24')))   # 1 day

# Cloudinary: either CLOUDINARY_URL=cloudinary://KEY:SECRET@CLOUD or the three separate variables.
if os.getenv('CLOUDINARY_CLOUD_NAME'):
    cloudinary.config(cloud_name=os.getenv('CLOUDINARY_CLOUD_NAME'), api_key=os.getenv('CLOUDINARY_API_KEY'),
                      api_secret=os.getenv('CLOUDINARY_API_SECRET'), secure=True)
else:
    cloudinary.config(secure=True)          # reads CLOUDINARY_URL
CLOUDINARY_FOLDER = os.getenv('CLOUDINARY_FOLDER', 'midsnap')
SHARE_MAX_BYTES = int(float(os.getenv('SHARE_MAX_MB', '9.5')) * 1024 * 1024)   # Cloudinary free plan: 10 MB / image

FORCED = {'paper': 'glossy', 'quality': 'high', 'borderless': True}   # the print settings shown in the app
CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'                          # no 0/O/1/I
CODE_RE = re.compile(r'^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$')

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
    if p.startswith('/static/') or p == '/healthz':
        return None                                  # assets are public
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
def midsnapped_items(where='', args=()):
    rows = qall(
        'SELECT m.id AS mid, m.download_count, m.print_count, m.last_downloaded_at, m.last_printed_at, '
        's.uid, s.code, s.frame_name, s.photo_count, s.layout, s.created_at '
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
    for l in qall(f'SELECT midsnapped_id, url, expires_at FROM share_links WHERE midsnapped_id IN ({ph}) '
                  f'AND url IS NOT NULL AND expires_at > %s ORDER BY id', ids + [utcnow()]):
        links[l['midsnapped_id']] = l
    out = []
    for r in rows:
        lk = links.get(r['mid'])
        out.append({
            'id': r['uid'], 'code': r['code'], 'ts': ms(r['created_at']), 'name': r['frame_name'], 'n': r['photo_count'],
            't': f"/api/snaps/{r['uid']}/thumb", 'layout': jl(r['layout']),
            'dl': r['download_count'], 'pr': r['print_count'],
            'lastDl': ms(r['last_downloaded_at']), 'lastPr': ms(r['last_printed_at']),
            'dlt': dl.get(r['mid'], []), 'prt': pr.get(r['mid'], []),
            'link': lk['url'] if lk else None,
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
    """Drop snapshots that are no longer a MIDSnapped record, then frames nobody uses."""
    run('DELETE FROM snapshots WHERE id NOT IN (SELECT snapshot_id FROM midsnapped)')
    run('DELETE FROM frames WHERE id NOT IN (SELECT frame_id FROM snapshots)')


# ----------------------------------------------------------------------------- Cloudinary
def cloud_ready():
    c = cloudinary.config()
    return bool(c.cloud_name and c.api_key and c.api_secret)


def cloud_delete(public_ids):
    """Delete uploaded strips from Cloudinary. Returns the public ids that are now gone."""
    gone = []
    for pid in public_ids:
        try:
            r = cloudinary.uploader.destroy(pid, resource_type='image', invalidate=True)
        except Exception:
            app.logger.exception('Cloudinary delete failed for %s', pid)
            continue
        if r.get('result') in ('ok', 'not found'):
            gone.append(pid)
    return gone


def purge_expired():
    """Delete expired strips from Cloudinary (a link is only valid for SHARE_TTL), then forget the rows."""
    now = utcnow()
    rows = qall('SELECT id, public_id FROM share_links WHERE expires_at <= %s', (now,))
    gone = set(cloud_delete([r['public_id'] for r in rows if r['public_id']])) if cloud_ready() else set()
    for r in rows:
        if not r['public_id'] or r['public_id'] in gone:
            run('DELETE FROM share_links WHERE id=%s', (r['id'],))
    return len(rows)


_last_purge = 0.0


def maybe_purge():
    global _last_purge
    if time.time() - _last_purge > 300:
        _last_purge = time.time()
        try:
            purge_expired()
        except Exception:
            app.logger.exception('purge failed')


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
    boot = {'midsnapped': midsnapped_items(), 'log': log_items(),
            'share': {'ready': cloud_ready(), 'hours': SHARE_TTL.total_seconds() / 3600, 'max': SHARE_MAX_BYTES}}
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


def new_code():
    s = ''.join(secrets.choice(CODE_ALPHA) for _ in range(8))
    return s[:4] + '-' + s[4:]


def unique_code(wanted):
    """The strip ID shown in the preview (XXXX-XXXX); a new one is made if it is malformed or already used."""
    code = wanted if isinstance(wanted, str) and CODE_RE.match(wanted) else new_code()
    while qone('SELECT 1 AS x FROM snapshots WHERE code=%s', (code,)):
        code = new_code()
    return code


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
    code = unique_code(meta.get('code'))
    sha = hashlib.sha256(frame).hexdigest()
    fr = qone('SELECT id FROM frames WHERE sha256=%s', (sha,))
    frame_id = fr['id'] if fr else insert(
        'INSERT INTO frames (sha256, name, svg, created_at) VALUES (%s,%s,%s,%s)', (sha, name, frame, now))
    snap_id = insert(
        'INSERT INTO snapshots (uid, code, frame_id, frame_name, photo_count, layout, thumb, created_at) '
        'VALUES (%s,%s,%s,%s,%s,%s,%s,%s)', (uid, code, frame_id, name, len(photos), json.dumps(layout), thumb, now))
    for i, mime, data in photos:
        insert('INSERT INTO snapshot_photos (snapshot_id, row_idx, mime, data) VALUES (%s,%s,%s,%s)',
               (snap_id, i, mime, data))
    insert('INSERT INTO midsnapped (snapshot_id, created_at) VALUES (%s,%s)', (snap_id, now))
    log_id = insert(
        'INSERT INTO photo_log (snapshot_uid, shot_at, frame_name, photo_count, thumb, download_times, print_times) '
        'VALUES (%s,%s,%s,%s,%s,%s,%s)', (uid, now, name, len(photos), thumb, '[]', '[]'))
    gc()
    return jsonify(midsnapped=midsnapped_items('WHERE s.uid=%s', (uid,))[0], log=log_items('WHERE id=%s', (log_id,))[0])


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
    cloud_delete([r['public_id'] for r in qall(
        'SELECT l.public_id FROM share_links l JOIN midsnapped m ON m.id = l.midsnapped_id '
        'JOIN snapshots s ON s.id = m.snapshot_id WHERE s.uid=%s AND l.public_id IS NOT NULL', (uid,))])
    n = run('DELETE m FROM midsnapped m JOIN snapshots s ON s.id = m.snapshot_id WHERE s.uid=%s', (uid,))
    if not n:
        abort(404, 'That strip is already gone.')
    gc()
    return '', 204


@app.post('/api/midsnapped/<uid>/events')
def add_event(uid):
    """Count a download or a browser print (and log its timestamp)."""
    m = qone('SELECT m.id FROM midsnapped m JOIN snapshots s ON s.id = m.snapshot_id WHERE s.uid=%s', (uid,))
    if not m:
        abort(404, 'That strip is no longer in MIDSnapped.')
    d = request.get_json(silent=True) or {}
    kind = d.get('kind')
    if kind not in ('download', 'print'):
        abort(400, 'Unknown event.')
    try:
        copies = max(1, min(99, int(d.get('copies') or 1)))
    except (TypeError, ValueError):
        copies = 1
    return add_event_for(uid, m['id'], kind, copies if kind == 'print' else 1)


def add_event_for(uid, mid, kind, copies):
    """Record a download / print: counters, the event row and the photo log. Prints always use the forced settings."""
    now = utcnow()
    details = dict(FORCED, fmt='png', copies=copies) if kind == 'print' else None
    insert('INSERT INTO usage_events (midsnapped_id, kind, copies, details, created_at) VALUES (%s,%s,%s,%s,%s)',
           (mid, kind, copies, json.dumps(details) if details else None, now))
    if kind == 'download':
        run('UPDATE midsnapped SET download_count = download_count + 1, last_downloaded_at=%s WHERE id=%s',
            (now, mid))
    else:
        run('UPDATE midsnapped SET print_count = print_count + %s, last_printed_at=%s WHERE id=%s',
            (copies, now, mid))
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


@app.post('/api/midsnapped/<uid>/share')
def create_share(uid):
    """Upload the high-quality PNG to Cloudinary; the link works for SHARE_TTL (24 hours), then it is deleted."""
    maybe_purge()
    if not cloud_ready():
        abort(503, 'Cloudinary is not set up. Add CLOUDINARY_URL to the .env file.')
    m = qone('SELECT m.id FROM midsnapped m JOIN snapshots s ON s.id = m.snapshot_id WHERE s.uid=%s', (uid,))
    if not m:
        abort(404, 'That strip is no longer in MIDSnapped.')
    data = read_upload('image', 40 * 1024 * 1024)
    if sniff(data) != 'image/png':
        abort(400, 'The strip image is missing or is not a PNG.')
    if len(data) > SHARE_MAX_BYTES:
        abort(413, 'The strip image is too large for Cloudinary. Lower SHARE_MAX_MB or render it at a lower dpi.')
    old = qall('SELECT public_id FROM share_links WHERE midsnapped_id=%s', (m['id'],))
    token, now = secrets.token_urlsafe(24), utcnow()                         # unguessable public id
    exp = now + SHARE_TTL
    try:
        up = cloudinary.uploader.upload(
            io.BytesIO(data), public_id=token, folder=CLOUDINARY_FOLDER, resource_type='image', type='upload',
            overwrite=False, unique_filename=False, use_filename=False,
            tags=['midsnap', 'expires-' + exp.strftime('%Y%m%d%H%M')], context={'expires_at': exp.isoformat() + 'Z'})
    except Exception as e:
        app.logger.exception(e)
        abort(502, 'Cloudinary refused the upload: ' + str(e)[:200])
    cloud_delete([r['public_id'] for r in old if r['public_id']])            # one live link per strip
    run('DELETE FROM share_links WHERE midsnapped_id=%s', (m['id'],))
    insert('INSERT INTO share_links (midsnapped_id, public_id, url, bytes, created_at, expires_at) '
           'VALUES (%s,%s,%s,%s,%s,%s)', (m['id'], up['public_id'], up['secure_url'], len(data), now, exp))
    return jsonify(url=up['secure_url'], expires=ms(exp))


@app.delete('/api/midsnapped/<uid>/share')
def delete_share(uid):
    rows = qall('SELECT l.id, l.public_id FROM share_links l JOIN midsnapped m ON m.id = l.midsnapped_id '
                'JOIN snapshots s ON s.id = m.snapshot_id WHERE s.uid=%s', (uid,))
    gone = set(cloud_delete([r['public_id'] for r in rows if r['public_id']]))
    if any(r['public_id'] and r['public_id'] not in gone for r in rows):
        abort(502, 'Could not delete the online copy from Cloudinary. Try again.')
    for r in rows:
        run('DELETE FROM share_links WHERE id=%s', (r['id'],))
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


# ----------------------------------------------------------------------------- CLI
def migrate(conn):
    """Bring a database made by an older version up to date (safe to run again)."""
    def has_col(t, c):
        with conn.cursor() as cur:
            cur.execute('SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() '
                        'AND table_name=%s AND column_name=%s', (t, c))
            return cur.fetchone()[0] > 0
    with conn.cursor() as cur:
        if not has_col('snapshots', 'code'):                     # strip IDs
            cur.execute("ALTER TABLE snapshots ADD COLUMN code VARCHAR(12) NOT NULL DEFAULT '' AFTER uid, ADD KEY ix_snapshots_code (code)")
            cur.execute("UPDATE snapshots SET code = UPPER(CONCAT(SUBSTRING(uid,1,4),'-',SUBSTRING(uid,5,4))) WHERE code = ''")
        if not has_col('share_links', 'public_id'):
            cur.execute('ALTER TABLE share_links ADD COLUMN public_id VARCHAR(255) NULL AFTER token')
        if not has_col('share_links', 'url'):
            cur.execute('ALTER TABLE share_links ADD COLUMN url VARCHAR(512) NULL AFTER public_id')
        if not has_col('share_links', 'bytes'):
            cur.execute('ALTER TABLE share_links ADD COLUMN bytes INT UNSIGNED NULL AFTER url')
        if has_col('share_links', 'token'):                      # old local links are gone: Cloudinary replaces them
            cur.execute('DELETE FROM share_links WHERE url IS NULL')
            cur.execute('ALTER TABLE share_links DROP COLUMN token')
        if has_col('share_links', 'image'):
            cur.execute('ALTER TABLE share_links DROP COLUMN image')
        if has_col('share_links', 'download_count'):
            cur.execute('ALTER TABLE share_links DROP COLUMN download_count')


@app.cli.command('init-db')
def init_db_cmd():
    with open(os.path.join(BASE_DIR, 'schema.sql'), encoding='utf-8') as fh:
        sql = re.sub(r'--[^\n]*', '', fh.read())
    conn = pymysql.connect(**DB, charset='utf8mb4', autocommit=True)
    with conn.cursor() as c:
        for stmt in (s.strip() for s in sql.split(';')):
            if stmt:
                c.execute(stmt)
    migrate(conn)
    conn.close()
    print('Tables are ready.')


@app.cli.command('purge-expired')
def purge_cmd():
    """Delete expired strips from Cloudinary (run from cron, e.g. every 15 minutes)."""
    with app.app_context():
        n = purge_expired()
        db().commit()
    print(f'Checked {n} expired link(s).')


if __name__ == '__main__':
    app.run()
