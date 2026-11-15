# MIDSnap: Photostrip Maker

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