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

Press **Generate QR code** in a strip's popup: the high-quality PNG (600 dpi) is uploaded to Cloudinary and the QR code
points straight to the Cloudinary URL, so phones can open it from anywhere (no public server address needed).
The link works for 24 hours (`SHARE_TTL_HOURS`), then the file is deleted from Cloudinary. Expired files are removed
when the app runs, and you can also run `flask --app app purge-expired` from cron (for example every 15 minutes).
Cloudinary's free plan accepts images up to 10 MB: if a 600 dpi PNG is larger than `SHARE_MAX_MB`, that strip is
uploaded as a 300 dpi PNG instead.

## Printing (4 x 6 in, borderless)

**Print** opens the browser's own print window with the strip at 4 x 6 in and no margins (nothing is sent from the server).
A browser cannot choose the paper type or the quality, so a reminder asks you to pick glossy photo paper and high
quality in that window.

## Using it

* After **MIDSnap-it**, a popup opens for the new strip with **Download PNG / JPG**, **Generate QR code** and **Print**.
  Clicking any row in the MIDSnapped section opens the same popup. Rows only have **Edit** and **Remove**.
* Every strip has an ID (`XXXX-XXXX`) shown in the Preview heading before it is MIDSnapped, and on its MIDSnapped row.
* The MIDSnapped list scrolls once it has 5 or more rows.
* The **Print details** section is collapsed by default.

Saved strips can be reopened with **Edit** in the MIDSnapped section.
