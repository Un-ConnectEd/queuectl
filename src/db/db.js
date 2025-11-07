import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.join(__dirname, '../../db');

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log('Created DB folder at', dbDir);
}

const DB_FILE = path.join(dbDir, 'queue.db');
const TEMP_DB_FILE = path.join(dbDir, 'queue.db.tmp'); // For atomic saves
console.log('DB file path:', DB_FILE);

let dbPromise = null;
const DEFAULT_CONFIG = {
  max_retries: '3',
  backoff_base: '5',
  backoff_factor_ms: '1000', // 5^attempts * 1000ms = 5^attempts seconds
  tick_interval_ms: '250',
  save_interval_ms: '5000',
};

function getDb() {
  if (dbPromise) {
    return dbPromise;
  }

  // create the promise that will load/init the DB if not exists.
  dbPromise = (async () => {
    try {
      const SQL = await initSqlJs();
      let db;

      if (fs.existsSync(DB_FILE)) {
        console.log('Loading existing DB from file into memory...');
        const fileBuffer = fs.readFileSync(DB_FILE);
        db = new SQL.Database(fileBuffer);
      } else {
        console.log('Creating new in-memory DB...');
        db = new SQL.Database();
        
        console.log('Running migrations...');
        // Job table - REMOVED "DEFAULT 3" from max_retries
        db.run(
          `CREATE TABLE jobs(
            id TEXT PRIMARY KEY,
            command TEXT,
            state TEXT,
            attempts INTEGER DEFAULT 0,
            max_retries INTEGER, 
            run_after INTEGER DEFAULT 0,
            created_at INTEGER,
            updated_at INTEGER
          )`
        );
        db.run(
          `CREATE INDEX idx_jobs_state_run_after
           ON jobs (state, run_after)`
        );
        // Config table
        db.run(
          `CREATE TABLE config(
            key TEXT PRIMARY KEY,
            value TEXT
          )`
        );
        console.log('Seeding default configuration...');
        const stmt = db.prepare(
          'INSERT OR IGNORE INTO config (key, value) VALUES ($key, $value)',
        );
        for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
          stmt.run({ $key: key, $value: value });
        }
        stmt.free();
        // Do an initial save
        saveDb(db);
      }
      
      console.log('Database initialized and loaded into memory.');
      return db; // This 'db' object is now the singleton
    } catch (err) {
      console.error('ERROR: Failed to initialize DB:', err);
      process.exit(1);
    }
  })();

  return dbPromise;
}

/**
 * Atomically saves the DB by writing to a temp file
 * and then renaming it.
 */
export function saveDb(db) {
  if (!db) return false; // Add a return value to see if the save is sucessful or not
  console.log('Saving DB to file (atomic)...');
  const data = db.export();
  try {
    fs.writeFileSync(TEMP_DB_FILE, Buffer.from(data));
    fs.renameSync(TEMP_DB_FILE, DB_FILE);
    console.log('Database save complete.');
    return true; // Report success
  } catch (err) {
    console.error('FATAL: Failed to save DB atomically!', err);
    return false; // Report failure
  }
}

/**
 * This function ALWAYS returns the singleton promise.
 */
export async function getDbInstance() {
  return getDb();
}

//
// CONFIGURATION HELPERS
//

/**
 * Loads all config keys and values from the DB into an object.
 * @param {import('sql.js').Database} db
 * @returns {Promise<Object<string, string>>}
 */
export async function getConfig(db) {
  const config = {};
  try {
    const stmt = db.prepare('SELECT key, value FROM config');
    while (stmt.step()) {
      const row = stmt.getAsObject();
      config[row.key] = row.value;
    }
    stmt.free();
  } catch (err) {
    console.error('Failed to load config from DB:', err);
  }
  return config;
}

/**
 * Gets a single config value from the DB.
 * @param {string} key
 * @param {import('sql.js').Database} db
 * @returns {string | undefined}
 */
export function getOneConfig(key, db) {
  try {
    const stmt = db.prepare('SELECT value FROM config WHERE key = $key');
    stmt.bind({ $key: key });
    let value;
    if (stmt.step()) {
      value = stmt.get()[0];
    }
    stmt.free();
    return value;
  } catch (err) {
    console.error(`Failed to get config key ${key}:`, err);
    return undefined;
  }
}

/**
 * Sets a single config value in the DB.
 * @param {string} key
 * @param {string} value
 * @param {import('sql.js').Database} db
 */
export function setConfig(key, value, db) {
  try {
    db.prepare(
      'INSERT OR REPLACE INTO config (key, value) VALUES ($key, $value)',
    ).run({ $key: key, $value: String(value) }); // Ensure value is a string
  } catch (err) {
    console.error(`Failed to set config key ${key}:`, err);
    throw err; // Re-throw to be caught by the server route
  }
}


export async function closeAndSaveDb(db) {
  
}