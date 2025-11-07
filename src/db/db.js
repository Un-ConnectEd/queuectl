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
        db.run(
          `CREATE TABLE jobs(
            id TEXT PRIMARY KEY,
            command TEXT,
            state TEXT,
            attempts INTEGER DEFAULT 0,
            max_retries INTEGER DEFAULT 3,
            run_after INTEGER DEFAULT 0,
            created_at INTEGER,
            updated_at INTEGER
          )`
        );
        db.run(
          `CREATE INDEX idx_jobs_state_run_after
           ON jobs (state, run_after)`
        );
        db.run(
          `CREATE TABLE config(
            key TEXT PRIMARY KEY,
            value TEXT
          )`
        );
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


export async function closeAndSaveDb(db) {
  
}