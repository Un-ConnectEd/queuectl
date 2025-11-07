/**
 * isDbChanged: Used by API routes and WorkerManager to signal
 * that the DB is "dirty" and needs to be saved.
 * Used by persistence.js to know when to save.
 *
 * isShuttingDown: Used by API routes, WorkerManager, and lifecycle.js
 * to coordinate a graceful shutdown.
 * 
 * which are frequently used
 */
export const state = {
  isDbChanged: false,
  isShuttingDown: false,
};