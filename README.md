# MIDSnap: Photostrip Maker (Flask + MySQL)

The UI is the original page, unchanged (same HTML/CSS/JS, now served as `templates/` + `static/`).
The browser still renders the strips; Flask + MySQL now store them.

## Run it

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# MySQL (5.7.8+ / 8.x): create the database and a user
mysql -u root -p -e "CREATE DATABASE midsnap CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
                     CREATE USER 'midsnap'@'localhost' IDENTIFIED BY 'change-me';
                     GRANT ALL ON midsnap.* TO 'midsnap'@'localhost';"

cp .env.example .env        # fill in the password and PUBLIC_BASE_URL
flask --app app init-db     # creates the tables
flask --app app run --host 0.0.0.0        # or: gunicorn -w 2 -b 0.0.0.0:5000 app:app
```

Photos and frames are stored as BLOBs, so raise MySQL's packet size (`my.cnf`, `[mysqld]`): `max_allowed_packet=128M`.

## Settings (`.env`)

| Variable | Purpose |
|---|---|
| `MYSQL_*` | database connection |
| `PUBLIC_BASE_URL` | address customers' phones can open, e.g. `http://192.168.1.20:5000`. It goes inside the QR codes. If it is unset the app uses the address you browsed with, and `localhost` will not work on a phone. |
| `STAFF_USER` / `STAFF_PASSWORD` | optional login for the staff app. Customer links (`/s/...`) never need it. If the app is reachable from the internet, set a password and use HTTPS. |
| `SHARE_TTL_HOURS` | how long a customer link works (default `24` = 1 day) |

## What changed

- **MIDSnapped section** (was "Ready queue"): every MIDSnapped strip is a database record with download count, print count (copies), created time, last downloaded / last printed time, and a full event history (hover the chips). **Remove** deletes the record, its history and its link.
- **QR code**: the strip is rendered (JPG, 102 x 152 mm, 300 dpi), saved on the server, and the QR points to `/s/<token>`. Customers scan it, see their strip and tap **Download**. The link works for **1 day** (checked on every request); afterwards it shows an "expired" page and the image is wiped. The staff-side QR stays available after a reload while the link is valid; after expiry press **QR code** again for a fresh link.
- **Photo log**, **recent strips** and **MIDSnapped** are all in MySQL. Only the frame and the photoshoot in progress, plus the print preferences, stay in the browser (they are per-device drafts).
- **MIDSnap-it** now sits directly under the preview in both expanded and collapsed states (it moves together with the preview on tall screens).
- Section headings are 20 px (were 24 px).

## Housekeeping

Expired images are wiped automatically when the staff page is opened or a link is created. To do it on a schedule as well (cron, every 15 minutes):

```
*/15 * * * * cd /path/to/midsnap && .venv/bin/flask --app app purge-expired
```

## Tables

`frames` (SVGs, de-duplicated), `snapshots` + `snapshot_photos` (a captured strip), `midsnapped` (the records with counts and times), `usage_events` (each download/print), `share_links` (customer links with `expires_at`), `photo_log`. See `schema.sql`.
