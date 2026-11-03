CREATE TABLE installations (
  installation_id TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  version TEXT NOT NULL,
  arch TEXT NOT NULL CHECK (arch IN ('arm64', 'x86_64'))
) WITHOUT ROWID;

CREATE TABLE daily_activity (
  day TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  version TEXT NOT NULL,
  arch TEXT NOT NULL CHECK (arch IN ('arm64', 'x86_64')),
  PRIMARY KEY (day, installation_id)
) WITHOUT ROWID;

CREATE INDEX daily_activity_installation ON daily_activity (installation_id, day);
