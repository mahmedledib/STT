-- STT Data Collection Platform — D1 schema
-- Run: wrangler d1 execute stt-platform-db --remote --file=schema.sql

PRAGMA foreign_keys = ON;

CREATE TABLE config (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    is_secret  INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by TEXT
);

CREATE TABLE departments (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
    id             TEXT PRIMARY KEY,
    full_name      TEXT NOT NULL,
    medical_role   TEXT NOT NULL CHECK (medical_role IN ('doctor','nurse','other')),
    system_role    TEXT NOT NULL DEFAULT 'user' CHECK (system_role IN ('user','admin','superadmin')),
    phone          TEXT NOT NULL UNIQUE,
    password       TEXT NOT NULL,          -- plain text by design
    language_pref  TEXT NOT NULL DEFAULT 'ar' CHECK (language_pref IN ('ar','fr')),
    account_origin TEXT NOT NULL DEFAULT 'self' CHECK (account_origin IN ('self','admin_created')),
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
    created_by     TEXT REFERENCES users(id),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at TEXT
);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_role   ON users(system_role);

CREATE TABLE user_departments (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    department_id TEXT REFERENCES departments(id),
    custom_name   TEXT,
    CHECK ((department_id IS NOT NULL) <> (custom_name IS NOT NULL))
);
CREATE INDEX idx_userdept_user ON user_departments(user_id);
CREATE UNIQUE INDEX idx_userdept_pick ON user_departments(user_id, department_id) WHERE department_id IS NOT NULL;

CREATE TABLE sessions (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    acting_role TEXT NOT NULL CHECK (acting_role IN ('user','admin','superadmin')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE elements (
    id         TEXT PRIMARY KEY,
    category   TEXT NOT NULL CHECK (category IN ('drug','analysis','radiology')),
    name       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT REFERENCES users(id),
    UNIQUE (category, name)
);
CREATE INDEX idx_elements_status   ON elements(status);
CREATE INDEX idx_elements_category ON elements(category);

CREATE TABLE combinations (
    id         TEXT PRIMARY KEY,
    combo_key  TEXT NOT NULL UNIQUE,
    size       INTEGER NOT NULL CHECK (size BETWEEN 1 AND 3),
    status     TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','in_use','retired')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_combinations_status ON combinations(status);

CREATE TABLE combination_elements (
    combination_id TEXT NOT NULL REFERENCES combinations(id),
    element_id     TEXT NOT NULL REFERENCES elements(id),
    position       INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
    PRIMARY KEY (combination_id, position)
);
CREATE INDEX idx_combo_elements_element ON combination_elements(element_id);

CREATE TABLE contributions (
    id                   TEXT PRIMARY KEY,
    user_id              TEXT NOT NULL REFERENCES users(id),
    combination_id       TEXT NOT NULL REFERENCES combinations(id),
    drive_file_id        TEXT,
    drive_folder         TEXT NOT NULL DEFAULT 'main' CHECK (drive_folder IN ('main','demo','deleted','rejected','trash')),
    original_format      TEXT,
    duration_seconds     REAL,
    transcription        TEXT,
    transcription_source TEXT CHECK (transcription_source IN ('accepted_as_is','typed_own')),
    ai_suggestion        TEXT,
    status               TEXT NOT NULL DEFAULT 'recording' CHECK (status IN ('recording','to_transcribe','submitted','final','rejected','deleted','trashed')),
    review_count         INTEGER NOT NULL DEFAULT 0 CHECK (review_count BETWEEN 0 AND 3),
    is_demo              INTEGER NOT NULL DEFAULT 0,
    demo_phase_id        TEXT REFERENCES demo_phases(id),
    device_type          TEXT,
    os                   TEXT,
    browser              TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    submitted_at         TEXT,
    updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_contrib_user    ON contributions(user_id);
CREATE INDEX idx_contrib_serving ON contributions(status, review_count);
CREATE INDEX idx_contrib_status  ON contributions(status);
CREATE INDEX idx_contrib_combo   ON contributions(combination_id);

CREATE TABLE reviews (
    id              TEXT PRIMARY KEY,
    contribution_id TEXT NOT NULL REFERENCES contributions(id),
    reviewer_id     TEXT NOT NULL REFERENCES users(id),
    level           INTEGER NOT NULL CHECK (level BETWEEN 1 AND 3),
    text_seen       TEXT,
    text_left       TEXT,
    text_edited     INTEGER NOT NULL DEFAULT 0,
    is_official     INTEGER NOT NULL DEFAULT 1,
    duration_seconds REAL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (contribution_id, reviewer_id)
);
CREATE INDEX idx_reviews_reviewer ON reviews(reviewer_id);
CREATE INDEX idx_reviews_contrib  ON reviews(contribution_id);

CREATE TABLE flags (
    id                TEXT PRIMARY KEY,
    review_id         TEXT NOT NULL REFERENCES reviews(id),
    contribution_id   TEXT NOT NULL REFERENCES contributions(id),
    category          TEXT NOT NULL CHECK (category IN ('audio','text')),
    code              TEXT NOT NULL,
    free_text         TEXT,
    followup_question TEXT,
    followup_answer   TEXT,
    is_red            INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_flags_contrib ON flags(contribution_id);

CREATE TABLE skips (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id),
    combination_id TEXT NOT NULL REFERENCES combinations(id),
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE notifications (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    type       TEXT NOT NULL,
    title      TEXT,
    body       TEXT NOT NULL,
    is_read    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_notifs_user ON notifications(user_id, is_read);

CREATE TABLE demo_phases (
    id         TEXT PRIMARY KEY,
    label      TEXT,
    status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','destroyed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_log (
    id          TEXT PRIMARY KEY,
    actor_id    TEXT NOT NULL REFERENCES users(id),
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    details     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_actor ON audit_log(actor_id);
CREATE INDEX idx_audit_time  ON audit_log(created_at);

CREATE TABLE export_snapshots (
    id         TEXT PRIMARY KEY,
    label      TEXT,
    criteria   TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE snapshot_contributions (
    snapshot_id          TEXT NOT NULL REFERENCES export_snapshots(id),
    contribution_id      TEXT NOT NULL REFERENCES contributions(id),
    frozen_transcription TEXT,
    frozen_review_count  INTEGER,
    PRIMARY KEY (snapshot_id, contribution_id)
);

-- Default config
INSERT INTO config (key, value, is_secret) VALUES
  ('combo_size_dist',          '{"1":0.7,"2":0.2,"3":0.1}', 0),
  ('buffer_pre_seconds',       '1.5', 0),
  ('buffer_post_seconds',      '1.0', 0),
  ('silence_volume_threshold', '0.02', 0),
  ('min_recording_seconds',    '2', 0),
  ('untranscribed_nudge_at',   '10', 0),
  ('congrats_interval',        '15', 0),
  ('daily_target',             '20', 0),
  ('review_time_min_seconds',  '4', 0),
  ('auto_reject_flags',        '["inaudible","empty"]', 0),
  ('notifications_paused',     'false', 0),
  ('kill_recording',           'false', 0),
  ('kill_transcription',       'false', 0),
  ('kill_review',              'false', 0),
  ('progress_visible_to_users','true', 0),
  ('demo_mode',                'false', 0),
  ('fixit_messages',           '{}', 0),
  ('secret.google_client_id',    NULL, 1),
  ('secret.google_client_secret',NULL, 1),
  ('secret.google_refresh_token',NULL, 1),
  ('secret.assemblyai_key',      NULL, 1);
