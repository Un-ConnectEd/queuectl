import express from 'express';
import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDbInstance, saveDb } from '../db/db.js'; 
import { enqueueJob, getJobs } from '../job/job.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, 'worker_child.js');
// have to use .env for better use.
const PORT = 3000;
const TICK_INTERVAL = 250;
const SAVE_INTERVAL = 5000; // Periodic save every 5 seconds to maintain durability at least upto 5 s before an unecpected crash

let isDbChanged = false;

const app = express();
app.use(express.json());

const workerQueue = []; 
let db; 
let isTicking = false;

//worker and job map to assign particular job to the particular worker 
const workerJobMap = new Map(); // <worker.pid, job.id>

let isShuttingDown = false;
let server;

//
// WORKER LOGIC (TICKER): to have a method to do jobs which have to be done after sometime.
//
async function tick() {
  if (isShuttingDown || isTicking || workerQueue.length === 0) {
    return;
  }
  isTicking = true;

  try {
    // making all operations in-memory to avoid stale reads, etc
    const stmt = db.prepare(
      "SELECT * FROM jobs WHERE state = 'pending' AND run_after <= $now ORDER BY created_at ASC LIMIT 1",
    );
    stmt.bind({ $now: Date.now() });

    if (stmt.step()) {
      const job = stmt.getAsObject();
      stmt.free();
      const worker = workerQueue.shift();

      console.log(`[Manager] Assigning job ${job.id} to worker ${worker.pid}`);
      db.prepare(
        'UPDATE jobs SET state = $state, updated_at = $now WHERE id = $id',
      ).run({
        $id: job.id,
        $state: 'processing',
        $now: Date.now(),
      });
      
      isDbChanged = true;
      workerJobMap.set(worker.pid, job.id);

      worker.send(job);
    } else {
      stmt.free();
    }
  } catch (err) {
    console.error('[Manager] Error in tick loop:', err.message);
  }
  isTicking = false;
}

//
// WORKER LOGIC (MESSAGE HANDLER)
//
async function handleWorkerMessage(worker, message) {
  if (message.status === 'ready') {
    console.log(`[Manager] Worker ${worker.pid} is ready.`);
    workerQueue.push(worker);
    return;
  }

  
  const { job } = message;
  
  if (job && job.id) {
    workerJobMap.delete(worker.pid); // remove from the map so it won't do duplicate processes

    if (message.status === 'completed') {
      console.log(`[Manager] Job ${job.id} completed by ${worker.pid}`);
      db.prepare(
        'UPDATE jobs SET state = $state, updated_at = $now WHERE id = $id',
      ).run({
        $id: job.id,
        $state: 'completed',
        $now: Date.now(),
      });
      
    } else if (message.status === 'failed') {
      console.log(`[Manager] Job ${job.id} failed by ${worker.pid}: ${message.error}`);
      const newAttempts = (job.attempts || 0) + 1;
      const maxRetries = job.max_retries || 3;
      let newState = newAttempts > maxRetries ? 'dead' : 'pending';
      let newRunAfter = Date.now() + Math.pow(5, newAttempts) * 1000;
      
      db.prepare(
        'UPDATE jobs SET state = $state, updated_at = $now, attempts = $attempts, run_after = $run_after WHERE id = $id',
      ).run({
        $id: job.id,
        $state: newState,
        $now: Date.now(),
        $attempts: newAttempts,
        $run_after: newRunAfter
      });
    }
    isDbChanged = true;
  } else {
     console.warn(`[Manager] Worker ${worker.pid} sent a message for an invalid job.`, message);
  }
  // Add worker back to pool

  workerQueue.push(worker); 

  if (isShuttingDown && workerJobMap.size === 0) {
    console.log(`[Manager] Last job completed.`);
    awaitIdleAndExit();
  }
}

//
// RESET STUCK JOBS
//
function resetStuckJob(workerPid) {
  const stuckJobId = workerJobMap.get(workerPid);
  if (stuckJobId) {
    console.warn(`[Manager] Worker ${workerPid} exited while processing job ${stuckJobId}. Resetting to 'pending'.`);
    try {
      db.prepare(
        "UPDATE jobs SET state = 'pending', updated_at = $now WHERE id = $id AND state = 'processing'"
      ).run({
        $id: stuckJobId,
        $now: Date.now(),
      });
      isDbChanged = true;
    } catch (err) {
      console.error(`[Manager] FATAL: Could not reset stuck job ${stuckJobId}:`, err);
    }
    workerJobMap.delete(workerPid);
  }
}

//
//  SPAWN/RESPAWN WORKERS
//
function spawnWorker() {
  if (isShuttingDown) {
    return;
  }
  const worker = fork(WORKER_SCRIPT);
  
  worker.on('message', (message) =>
    handleWorkerMessage(worker, message),
  );
  
  worker.on('exit', (code) => {
    console.warn(`[Manager] Worker ${worker.pid} exited with code ${code}`);
    
    // Remove worker from the queue if it was in there
    const queueIndex = workerQueue.indexOf(worker);
    if (queueIndex > -1) {
      workerQueue.splice(queueIndex, 1);
    }

    // Reset any job it was working 
    resetStuckJob(worker.pid);
    
    // Respawn the worker to worker maintain pool
    console.log('[Manager] Spawning a replacement worker...');
    spawnWorker();
  });

  worker.on('error', (err) => {
    console.error(`[Manager] Worker ${worker.pid} had an error:`, err);
  });
  
}


//
// HTTP SERVER ROUTES (for the CLI client)
//
app.post('/enqueue', async (req, res) => {
  try {
    if (isShuttingDown) {
    res.status(503).json({ error: "Server is shutting down. Not accepting new jobs." });
    return;
  }
    const jobData = req.body;
    const job = await enqueueJob(jobData, db);
    console.log(`[Server] Enqueued job ${job.id} via HTTP`);
    res.status(201).json(job);
    isDbChanged = true;
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/list', async (req, res) => {
  try {
    const jobs = await getJobs(req.query.state, db); 
    res.status(200).json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function awaitIdleAndExit() {
  console.log('\n[Manager] All workers are idle. Saving database to disk...');
  saveDb(db);
  console.log('[Manager] Database saved. Exiting gracefully.');
  process.exit(0);
}

//
// MAIN STARTUP FUNCTION
//
export async function startWorkers(count) {
  // Load the database into memory ONCE
  db = await getDbInstance();
  
  console.log(`[Manager] Starting ${count} workers...`);
  for (let i = 0; i < count; i++) {
    spawnWorker(); // Use the new fault-tolerant spawner
  }

  // Start the job-finding ticker
  setInterval(tick, TICK_INTERVAL);


  setInterval(() => {
    if (isDbChanged) {
      console.log('[Manager] Periodic background save...');
      const success = saveDb(db); 
      
      if (success) {
        isDbChanged = false; // Only reset if save worked
      } else {

        console.warn('[Manager] Database save failed! Will retry next interval.');
      }
    } else {
      console.log('[Manager] no changes so no save');
    }
  }, SAVE_INTERVAL);

  server = app.listen(PORT, () => {
    console.log(`[Manager] HTTP server listening on http://localhost:${PORT}`);
  });

  process.on('SIGINT', () => {
    console.log('\n[Manager] SIGINT (Ctrl+C) received. Initiating graceful shutdown...');
    isShuttingDown = true;
    
    // 1. Stop the ticker
    console.log('[Manager] Stopping job ticker...');

    // 2. Stop the HTTP server
    console.log('[Manager] Stopping HTTP server from accepting new connections...');
    server.close(() => {
      console.log('[Manager] HTTP server closed.');
    });

    // 3. Check if we are already idle
    if (workerJobMap.size === 0) {
      console.log('[Manager] No jobs are currently processing.');
      awaitIdleAndExit();
    } else {
      console.log(`[Manager] Waiting for ${workerJobMap.size} processing job(s) to complete...`);
      // handleWorkerMessage() will call awaitIdleAndExit() when the last job finishes.
    }
  });
}