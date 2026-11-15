# MIDSnap: Photostrip Maker

## Run it

```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# MySQL (5.7.8+ / 8.x): create the database and a user
mysql -u root -p -e "CREATE DATABASE midsnap CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
                     CREATE USER 'midsnap'@'localhost' IDENTIFIED BY 'change-me';
                     GRANT ALL ON midsnap.* TO 'midsnap'@'localhost';"

cp .env.example .env        # fill in the MySQL password and the Cloudinary URL
flask --app app init-db     # creates the tables (also upgrades a database from an older version)
flask --app app run --host 0.0.0.0        # or: gunicorn -w 2 -b 0.0.0.0:5000 app:app   (Windows: waitress-serve app:app)
```

## Customer download links (Cloudinary)

Press **QR code** on a MIDSnapped strip: the high-quality PNG (600 dpi) is uploaded to Cloudinary and the QR code
points straight to the Cloudinary URL, so phones can open it from anywhere (no public server address needed).
The link works for 24 hours (`SHARE_TTL_HOURS`), then the file is deleted from Cloudinary. Expired files are removed
when the app runs, and you can also run `flask --app app purge-expired` from cron (for example every 15 minutes).
Cloudinary's free plan accepts images up to 10 MB: if a 600 dpi PNG is larger than `SHARE_MAX_MB`, that strip is
uploaded as a 300 dpi PNG instead.

## Printing (4 x 6 in, glossy photo paper, high quality, borderless)

These settings are fixed (the Output section shows them but they cannot be changed). A browser cannot choose the
paper type or the quality, so MIDSnap prints from the server when it can, with `PRINT_BACKEND=auto` (default):

* **Windows**: through `pywin32` (paper size, glossy media type and high quality are sent to the driver).
* **Linux / macOS**: through CUPS `lp` (`media`, `media-type=photographic-glossy`, `print-quality=5`, borderless).

The server must run on the computer the printer is connected to. Driver option names differ, so you can override
them in `.env` (see `CUPS_*`); borderless in particular depends on the driver being set up for borderless 4x6.
If no server printer is available, Print falls back to the browser's print window (4 x 6 in, no margins) and
reminds you to choose glossy photo paper and high quality there.

Saved strips can be reopened with **Edit** in the MIDSnapped section.
