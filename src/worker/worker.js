import { getDbInstance, getConfig } from '../db/db.js';
// The new modular imports
import { createApi } from '../api/index.js';
import { WorkerManager } from './workerManager.js';
import { startPersistenceLoop } from './persistence.js';
import { setServer, initiateShutdown } from './lifecycle.js';
// Note: We don't need to import 'appState' here,
// as the modules that need it import it directly.

const PORT = process.env.PORT || 3000;

//
// MAIN STARTUP FUNCTION
//
export async function startWorkers(count) {
  // 1. Initialize DB and Config
  const db = await getDbInstance();
  const config = await getConfig(db);
  console.log('[Manager] Configuration loaded:', config);

  // Set intervals from loaded config
  const TICK_INTERVAL = parseInt(config.tick_interval_ms, 10);
  const SAVE_INTERVAL = parseInt(config.save_interval_ms, 10);

  // 2. Initialize Core Services
  // The WorkerManager is the "engine"
  const workerManager = new WorkerManager(db, config);
  
  // Create a handler for shutdown that has access to the services
  const shutdownHandler = () => initiateShutdown(workerManager, db);

  // The API is the "interface"
  // Pass workerManager to the API so it can access worker stats
  const app = createApi(db, config, shutdownHandler, workerManager); // <-- Pass workerManager

  // 4. Start Services
  // Start the worker pool
  workerManager.init(count);
  
  // Start the background DB save loop
  startPersistenceLoop(db, SAVE_INTERVAL);
  
  // Start the job scheduler loop
  setInterval(() => workerManager.tick(), TICK_INTERVAL);

  // 5. Start HTTP Server
  const server = app.listen(PORT, () => {
    console.log(`[Manager] HTTP server listening on http://localhost:${PORT}`);
  });
  
  // Give the lifecycle module a reference to the server
  // so it can call server.close()
  setServer(server); 

  // 6. Set up Graceful Shutdown
  process.on('SIGINT', () => {
    console.log('\n[Manager] SIGINT (Ctrl+C) received.');
    shutdownHandler();
  });
}