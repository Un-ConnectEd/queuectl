import { state } from './appState.js';
import { saveDb } from '../db/db.js';

/** 
 *We need a place to store the 'server' instance so we can call 'server.close()' 
 *on it when we import it to the worker.js
 */
let serverInstance = null;

/**
 * Stores the HTTP server instance for graceful shutdown.
 * This is called by worker.js after the server is created.
 * @param {import('http').Server} server
 */
export function setServer(server) {
  serverInstance = server;
}

/**
 * The final step of shutdown after all workers are idle.
 */
function awaitIdleAndExit(db) {
  console.log('\n[Manager] All workers are idle. Saving database to disk...');
  saveDb(db);
  console.log('[Manager] Database saved. Exiting gracefully.');
  process.exit(0);
}

/**
 * Initiates a graceful shutdown of the server.
 * @param {import('./workerManager.js').WorkerManager} workerManager
 * @param {import('sql.js').Database} db
 */
export function initiateShutdown(workerManager, db) {
  // Prevent this from running shutdown more than once
  if (state.isShuttingDown) {
    return;
  }

  console.log('\n[Manager] Initiating graceful shutdown...');
  state.isShuttingDown = true;
  
  // The tick() loop in workerManager will now stop on its own
  console.log('[Manager] Stopping job ticker...');

  // Stop the HTTP server from accepting new connections
  if (serverInstance) {
    serverInstance.close(() => {
      console.log('[Manager] HTTP server closed.');
    });
  }

  // Check if any jobs are still running
  const processingCount = workerManager.getProcessingJobCount();
  if (processingCount === 0) {
    console.log('[Manager] No jobs are currently processing.');
    awaitIdleAndExit(db);
  } else {
    // Wait for the running jobs to finish
    console.log(`[Manager] Waiting for ${processingCount} processing job(s) to complete...`);
    
    // workerManager will emit 'idle' when the last job finishes and awaitIdleAndExit is called
    workerManager.once('idle', () => {
      awaitIdleAndExit(db);
    });
  }
}