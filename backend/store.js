const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const root = path.resolve(__dirname, "..");
const databasePath = process.env.KAKASA_DB_PATH || path.join(root, "db", "kakasa.sqlite");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS saccos (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tier TEXT NOT NULL CHECK (tier IN ('Lite', 'Standard', 'Pro')),
    district TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transactions (
    receipt_id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    sacco_id TEXT NOT NULL REFERENCES saccos(id),
    member_ref TEXT NOT NULL,
    record_json TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    FOREIGN KEY (sacco_id) REFERENCES saccos(id)
  );
  CREATE TABLE IF NOT EXISTS anchors (
    id TEXT PRIMARY KEY,
    merkle_root TEXT NOT NULL,
    tx_count INTEGER NOT NULL,
    validators_json TEXT NOT NULL,
    sealed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS anchor_items (
    receipt_id TEXT PRIMARY KEY REFERENCES transactions(receipt_id),
    anchor_id TEXT NOT NULL REFERENCES anchors(id),
    fingerprint TEXT NOT NULL,
    sacco_id TEXT NOT NULL REFERENCES saccos(id)
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL,
    sacco_id TEXT NOT NULL REFERENCES saccos(id),
    status TEXT NOT NULL CHECK (status IN ('MODIFIED', 'DELETED', 'UNANCHORED', 'RESOLVED')),
    details TEXT NOT NULL,
    note TEXT,
    approved_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS transactions_sacco_idx ON transactions(sacco_id);
  CREATE INDEX IF NOT EXISTS alerts_status_idx ON alerts(status);
`);

module.exports = { db, databasePath };
