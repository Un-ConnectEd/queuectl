import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const DB_FILE = '../db/queue.db';

export async function openDb() {
  const db = await open({ filename: DB_FILE, driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS jobs(
      id TEXT PRIMARY KEY,
      command TEXT,
      state TEXT,
      attempts INTEGER,
      max_retries INTEGER,
      run_after INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS config(
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  return db;
}
