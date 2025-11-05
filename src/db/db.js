// src/db/db.js
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.join(__dirname, '../../db');

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log('DEbug:db.js: Created DB folder at', dbDir);
}

const DB_FILE = path.join(dbDir, 'queue.db');
console.log('Debug:db.js: DB file path:', DB_FILE);

let dbPromise = null;

function getDb() {
  if (dbPromise) {
    return dbPromise;
  }

  // Create a new promise for initialization
  dbPromise = (async () => {
    try {
      console.log('Initializing SQL.js module...');
      const SQL = await initSqlJs();
      let db;

      /**
       * continue the old database by loading it to preserve persistent
       */
      if (fs.existsSync(DB_FILE)) {
        console.log('Loading existing DB from file...');
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
          `CREATE TABLE config(
            key TEXT PRIMARY KEY,
            value TEXT
          )`
        );
        // Do an initial save
        saveDb(db);
      }
      
      console.log('DEbug:db.js:  DB initialized');
      return db;
    } catch (err) {
      console.error('ERROR: Debug:db.js: Failed to initialize DB:', err);
      process.exit(1);
    }
  })();

  return dbPromise;
}

/**
since sql.js is in memory sqlite alternative we need to save the changes before exiting the programm
**/
function saveDb(db) {
  if (!db) return;
  console.log('Saving DB to file...');
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

export async function getDbInstance() {
  return getDb();
}

/**
  Saves and closes the database connection to remain persistant
 **/
export async function closeAndSaveDb() {
  if (dbPromise) {
    const db = await dbPromise;
    saveDb(db);
    db.close();
    dbPromise = null;
  }
}