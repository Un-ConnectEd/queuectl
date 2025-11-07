import express from 'express';
import { createJobRouter } from './job.routes.js';
import { createDlqRouter } from './dlq.routes.js';
import { createConfigRouter } from './config.routes.js';
import { createShutdownRouter } from './shutdown.routes.js';
import { createStatusRouter } from './status.routes.js'; 

/**
 * Creates and configures the main Express application by
 * assembling all the modular routers.
 * * @param {import('sql.js').Database} db - The DB instance.
 * @param {object} config - The in-memory config object.
 * @param {Function} shutdownHandler - Callback to trigger graceful shutdown.
 * @param {import('../worker/workerManager.js').WorkerManager} workerManager - The worker manager instance
 * @returns {object} The configured Express app.
 */
export function createApi(db, config, shutdownHandler, workerManager) {
  const app = express();
  
  // Apply global middleware
  app.use(express.json());

  // Mount the modular routers onto their base paths
  
  // Handles /enqueue, /list
  app.use('/', createJobRouter(db, config)); 
  
  // Handles /dlq, /dlq/retry/:id, /dlq/retry-all
  app.use('/dlq', createDlqRouter(db));
  
  // Handles /config, /config/:key
  app.use('/config', createConfigRouter(db, config));
  
  // Handles /shutdown
  app.use('/', createShutdownRouter(shutdownHandler)); 

  // Handles /status
  app.use('/', createStatusRouter(db, workerManager));

  return app;
}