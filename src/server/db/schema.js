/**
 * SQLite 数据库 DDL 定义
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS config_records (
  owner_handle TEXT NOT NULL,
  content_type TEXT NOT NULL,
  item_uid TEXT NOT NULL,
  display_name TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  current_checksum TEXT,
  mime_type TEXT,
  ext TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  updated_by_client TEXT,
  PRIMARY KEY (owner_handle, content_type, item_uid)
);

CREATE TABLE IF NOT EXISTS config_versions (
  owner_handle TEXT NOT NULL,
  content_type TEXT NOT NULL,
  item_uid TEXT NOT NULL,
  version INTEGER NOT NULL,
  operation TEXT NOT NULL,
  checksum TEXT,
  mime_type TEXT,
  ext TEXT,
  blob_path TEXT,
  version_title TEXT,
  size_bytes INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by_client TEXT,
  PRIMARY KEY (owner_handle, content_type, item_uid, version)
);

CREATE TABLE IF NOT EXISTS change_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_handle TEXT NOT NULL,
  content_type TEXT NOT NULL,
  item_uid TEXT NOT NULL,
  version INTEGER NOT NULL,
  operation TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS share_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_handle TEXT NOT NULL,
  grantee_handle TEXT,
  scope_type TEXT NOT NULL,
  content_type TEXT NOT NULL,
  item_uid TEXT,
  permission TEXT NOT NULL DEFAULT 'read',
  grant_method TEXT NOT NULL,
  share_code_hash TEXT,
  code_usage TEXT DEFAULT 'single_use',
  code_used INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 0,
  is_public INTEGER NOT NULL DEFAULT 0,
  inject_secrets INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_handle TEXT NOT NULL,
  action TEXT NOT NULL,
  target_handle TEXT,
  content_type TEXT,
  item_uid TEXT,
  result TEXT NOT NULL DEFAULT 'success',
  client_instance_id TEXT,
  ip TEXT,
  details TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS binding_locks (
  requester_handle TEXT NOT NULL,
  owner_handle     TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  item_uid         TEXT NOT NULL,
  locked           INTEGER NOT NULL DEFAULT 1,
  locked_at        INTEGER NOT NULL,
  PRIMARY KEY (requester_handle, owner_handle, content_type, item_uid)
);

CREATE INDEX IF NOT EXISTS idx_change_events_seq ON change_events(seq);
CREATE INDEX IF NOT EXISTS idx_change_events_owner ON change_events(owner_handle, seq);
CREATE INDEX IF NOT EXISTS idx_config_versions_lookup ON config_versions(owner_handle, content_type, item_uid, version DESC);
CREATE INDEX IF NOT EXISTS idx_share_grants_lookup ON share_grants(grantee_handle, owner_handle, content_type, status);
CREATE INDEX IF NOT EXISTS idx_share_grants_code ON share_grants(share_code_hash);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_handle, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_handle, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_binding_locks_lookup ON binding_locks(requester_handle, content_type);
`;
