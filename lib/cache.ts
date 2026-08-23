import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/* Render, Hostinger and Docker all run a long-lived Node process, so a local
   SQLite file persists fine. In Docker, /app/data is a mounted volume. */
const DB_PATH = process.env.DB_PATH || join(process.cwd(), 'data', 'cache.db');

export type SavedPlaylist = {
  id: string;
  name: string;
  url: string;
  art: string | null;
  trackCount: number;
  lastPlayedAt: number;
};

declare global {
  var __spotifreeDb: DatabaseSync | undefined;
}

/* Opened lazily on first use, never at import time: `next build` collects page
   data with several parallel workers, and each one importing this module would
   race the others to create the schema ("database is locked"). */
function db(): DatabaseSync {
  if (globalThis.__spotifreeDb) return globalThis.__spotifreeDb;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  const handle = new DatabaseSync(DB_PATH);

  // WAL lets reads proceed during a write; busy_timeout waits instead of
  // throwing if two requests do overlap.
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA busy_timeout = 5000');
  handle.exec(`
    CREATE TABLE IF NOT EXISTS track_map (
      spotify_id  TEXT PRIMARY KEY,
      video_id    TEXT NOT NULL,
      label       TEXT,
      resolved_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS quota (
      day   TEXT PRIMARY KEY,
      units INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS playlists (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      url            TEXT NOT NULL,
      art            TEXT,
      track_count    INTEGER NOT NULL DEFAULT 0,
      added_at       INTEGER NOT NULL,
      last_played_at INTEGER NOT NULL
    );
  `);

  globalThis.__spotifreeDb = handle;
  return handle;
}

const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------- track cache */

export function getMapping(spotifyId: string): string | null {
  const row = db().prepare('SELECT video_id FROM track_map WHERE spotify_id = ?').get(spotifyId) as
    | { video_id: string }
    | undefined;
  return row?.video_id ?? null;
}

export function countCached(ids: string[]): number {
  return ids.filter((id) => getMapping(id)).length;
}

export function putMapping(spotifyId: string, videoId: string, label: string) {
  db().prepare(
    'INSERT OR REPLACE INTO track_map (spotify_id, video_id, label, resolved_at) VALUES (?, ?, ?, ?)'
  ).run(spotifyId, videoId, label, Date.now());
}

export function dropMapping(spotifyId: string) {
  db().prepare('DELETE FROM track_map WHERE spotify_id = ?').run(spotifyId);
}

/* -------------------------------------------------------------------- quota */

export function spendQuota(units: number) {
  db().prepare(
    'INSERT INTO quota (day, units) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET units = units + excluded.units'
  ).run(today(), units);
}

export function quotaUsed(): number {
  const row = db().prepare('SELECT units FROM quota WHERE day = ?').get(today()) as
    | { units: number }
    | undefined;
  return row?.units ?? 0;
}

/* ------------------------------------------------------------------ library */

export function listPlaylists(): SavedPlaylist[] {
  const rows = db()
    .prepare('SELECT id, name, url, art, track_count, last_played_at FROM playlists ORDER BY last_played_at DESC')
    .all() as any[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    art: r.art ?? null,
    trackCount: r.track_count,
    lastPlayedAt: r.last_played_at,
  }));
}

/** Upsert, but keep the original added_at so the library keeps a stable history. */
export function savePlaylist(p: Omit<SavedPlaylist, 'lastPlayedAt'>) {
  const now = Date.now();
  db().prepare(
    `INSERT INTO playlists (id, name, url, art, track_count, added_at, last_played_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       url = excluded.url,
       art = excluded.art,
       track_count = excluded.track_count,
       last_played_at = excluded.last_played_at`
  ).run(p.id, p.name, p.url, p.art, p.trackCount, now, now);
}

export function removePlaylist(id: string) {
  db().prepare('DELETE FROM playlists WHERE id = ?').run(id);
}
