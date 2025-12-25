import Database from "better-sqlite3";
import { BlossomSQLite } from "blossom-server-sdk/metadata/sqlite";
import { config } from "../config.js";
import { mkdirp } from "mkdirp";
import { dirname } from "path";

await mkdirp(dirname(config.databasePath));

export const db = new Database(config.databasePath);
export const blobDB = new BlossomSQLite(db);

db.prepare(
  `CREATE TABLE IF NOT EXISTS accessed (
		blob TEXT(64) PRIMARY KEY,
		timestamp INTEGER NOT NULL
	)`,
).run();

db.prepare("CREATE INDEX IF NOT EXISTS accessed_timestamp ON accessed (timestamp)").run();

db.prepare(
  `CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    master_hash TEXT NOT NULL,
    duration INTEGER NOT NULL,
    uploaded INTEGER NOT NULL,
    description TEXT,
    source TEXT,
    preview_hash TEXT,
    sprite_meta_hash TEXT,
    views INTEGER DEFAULT 0,
    width INTEGER,
    height INTEGER,
    blob_count INTEGER,
    total_size INTEGER,
    max_blob_size INTEGER
  )`,
).run();

// Add views column if it doesn't exist (migration for existing databases)
try {
  db.prepare("ALTER TABLE videos ADD COLUMN views INTEGER DEFAULT 0").run();
} catch (e) {
  // Column already exists
}

// Add width/height columns if they don't exist (migration for existing databases)
try {
  db.prepare("ALTER TABLE videos ADD COLUMN width INTEGER").run();
} catch (e) {
  // Column already exists
}
try {
  db.prepare("ALTER TABLE videos ADD COLUMN height INTEGER").run();
} catch (e) {
  // Column already exists
}

// Add blob stats columns if they don't exist (migration for existing databases)
try {
  db.prepare("ALTER TABLE videos ADD COLUMN blob_count INTEGER").run();
} catch (e) {
  // Column already exists
}
try {
  db.prepare("ALTER TABLE videos ADD COLUMN total_size INTEGER").run();
} catch (e) {
  // Column already exists
}
try {
  db.prepare("ALTER TABLE videos ADD COLUMN max_blob_size INTEGER").run();
} catch (e) {
  // Column already exists
}

// In-memory cache of master_hashes for fast view counting
export const masterHashCache: Set<string> = new Set();

// Load all master_hashes into cache
export function loadMasterHashCache() {
  const rows = db.prepare("SELECT master_hash FROM videos").all() as { master_hash: string }[];
  masterHashCache.clear();
  for (const row of rows) {
    masterHashCache.add(row.master_hash);
  }
}

// Add a master_hash to the cache (call when new video is registered)
export function addToMasterHashCache(masterHash: string) {
  masterHashCache.add(masterHash);
}

// Remove a master_hash from the cache (call when video is deleted)
export function removeFromMasterHashCache(masterHash: string) {
  masterHashCache.delete(masterHash);
}

// Increment views for a master_hash
export function incrementVideoViews(masterHash: string) {
  db.prepare("UPDATE videos SET views = views + 1 WHERE master_hash = ?").run(masterHash);
}

// Initialize the cache
loadMasterHashCache();

export default db;
