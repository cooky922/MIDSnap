-- MIDSnap: Photostrip Maker. MySQL 5.7.8+ / 8.x (MariaDB 10.2.7+ also works).
-- Create the database first:  CREATE DATABASE midsnap CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- Then run:                   flask --app app init-db
-- All timestamps are stored in UTC.

-- Frame SVGs, stored once and shared by every strip that uses them (de-duplicated by SHA-256).
CREATE TABLE IF NOT EXISTS frames (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sha256      CHAR(64)     NOT NULL,
  name        VARCHAR(255) NOT NULL,
  svg         LONGBLOB     NOT NULL,
  created_at  DATETIME(3)  NOT NULL,
  UNIQUE KEY uq_frames_sha256 (sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One captured photostrip: frame + crop settings + thumbnail. The photos live in snapshot_photos.
-- A snapshot is kept while it is a MIDSnapped record or one of the last 5 "recent strips".
CREATE TABLE IF NOT EXISTS snapshots (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  uid          CHAR(16)        NOT NULL,
  frame_id     INT UNSIGNED    NOT NULL,
  frame_name   VARCHAR(255)    NOT NULL,
  photo_count  TINYINT UNSIGNED NOT NULL,
  layout       JSON            NOT NULL,  -- per row: {has, z, ox, oy}
  thumb        MEDIUMBLOB      NOT NULL,  -- JPEG thumbnail
  is_recent    TINYINT(1)      NOT NULL DEFAULT 1,
  created_at   DATETIME(3)     NOT NULL,
  UNIQUE KEY uq_snapshots_uid (uid),
  KEY ix_snapshots_recent (is_recent, created_at),
  CONSTRAINT fk_snapshots_frame FOREIGN KEY (frame_id) REFERENCES frames (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS snapshot_photos (
  snapshot_id  BIGINT UNSIGNED NOT NULL,
  row_idx      TINYINT UNSIGNED NOT NULL,
  mime         VARCHAR(32)     NOT NULL,
  data         LONGBLOB        NOT NULL,
  PRIMARY KEY (snapshot_id, row_idx),
  CONSTRAINT fk_photos_snapshot FOREIGN KEY (snapshot_id) REFERENCES snapshots (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The MIDSnapped section: one record per MIDSnapped strip, with download / print counts and timestamps.
-- Removing the record in the interface deletes this row (and its events and share links).
CREATE TABLE IF NOT EXISTS midsnapped (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  snapshot_id         BIGINT UNSIGNED NOT NULL,
  download_count      INT UNSIGNED    NOT NULL DEFAULT 0,
  print_count         INT UNSIGNED    NOT NULL DEFAULT 0,  -- counts copies
  last_downloaded_at  DATETIME(3)     NULL,
  last_printed_at     DATETIME(3)     NULL,
  created_at          DATETIME(3)     NOT NULL,
  UNIQUE KEY uq_midsnapped_snapshot (snapshot_id),
  KEY ix_midsnapped_created (created_at),
  CONSTRAINT fk_midsnapped_snapshot FOREIGN KEY (snapshot_id) REFERENCES snapshots (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every download and print, with its own timestamp.
CREATE TABLE IF NOT EXISTS usage_events (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  midsnapped_id  BIGINT UNSIGNED NOT NULL,
  kind           ENUM('download','print') NOT NULL,
  copies         SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  details        JSON            NULL,   -- print settings used
  created_at     DATETIME(3)     NOT NULL,
  KEY ix_events_midsnapped (midsnapped_id, created_at),
  CONSTRAINT fk_events_midsnapped FOREIGN KEY (midsnapped_id) REFERENCES midsnapped (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Customer download links (the QR code points here). A link is valid for 1 day (expires_at);
-- afterwards the image is wiped (purge) and the link answers "expired".
CREATE TABLE IF NOT EXISTS share_links (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  midsnapped_id   BIGINT UNSIGNED NOT NULL,
  token           CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,  -- case-sensitive
  image           LONGBLOB        NULL,   -- rendered JPG, 102 x 152 mm at 300 dpi
  created_at      DATETIME(3)     NOT NULL,
  expires_at      DATETIME(3)     NOT NULL,
  download_count  INT UNSIGNED    NOT NULL DEFAULT 0,
  UNIQUE KEY uq_share_token (token),
  KEY ix_share_midsnapped (midsnapped_id),
  KEY ix_share_expires (expires_at),
  CONSTRAINT fk_share_midsnapped FOREIGN KEY (midsnapped_id) REFERENCES midsnapped (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The photo log. Independent of MIDSnapped: removing a MIDSnapped record does not touch the log.
CREATE TABLE IF NOT EXISTS photo_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  snapshot_uid    CHAR(16)        NOT NULL,
  shot_at         DATETIME(3)     NOT NULL,
  frame_name      VARCHAR(255)    NOT NULL,
  photo_count     TINYINT UNSIGNED NOT NULL,
  thumb           MEDIUMBLOB      NOT NULL,
  downloads       INT UNSIGNED    NOT NULL DEFAULT 0,
  prints          INT UNSIGNED    NOT NULL DEFAULT 0,
  download_times  JSON            NOT NULL,  -- [epoch ms, ...]
  print_times     JSON            NOT NULL,  -- [epoch ms, ...] one per copy
  print_details   JSON            NULL,      -- settings of the last print
  KEY ix_log_uid (snapshot_uid),
  KEY ix_log_shot (shot_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
