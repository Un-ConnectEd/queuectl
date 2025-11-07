import { state } from './appState.js';
import { saveDb } from '../db/db.js';

/**
 * Starts the periodic background save loop.
 * @param {import('sql.js').Database} db - The DB instance.
 * @param {number} saveInterval - Interval in milliseconds.
 */
export function startPersistenceLoop(db, saveInterval) {
  setInterval(() => {
    /**
     *  Check the state flag to see if the DB is changed or not 
     * to implement lazy download into the local file system
      */
    if (state.isDbChanged) {
      console.log('[Manager] Periodic background save...');
      const success = saveDb(db);
      
      if (success) {
        // Only reset the flag if the save was successful so not to miss the saves
        state.isDbChanged = false; 
      } else {
        console.warn('[Manager] Database save failed! Will retry next interval.');
        // We leave isDbChanged = true so it tries again
      }
    }
  }, saveInterval);
}