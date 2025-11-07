import express from 'express';
import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDbInstance, saveDb } from '../db/db.js'; 
import { enqueueJob, getJobs } from '../job/job.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, 'worker_child.js');
const PORT = 3000;
const TICK_INTERVAL = 250;
const SAVE_INTERVAL = 5000; // Periodic save every 5 seconds to maintain durability at least upto 5 s before an unecpected crash

const app = express();
app.use(express.json());

const workerPool = [];
const workerQueue = []; 
let db; 
let isTicking = false;

//morker and job map to assign particular job to the particular worker 
const workerJobMap = new Map(); // <worker.pid, job.id>

//
// WORKER LOGIC (TICKER): to have a method to do jobs which have to be done after sometime.
//
async function tick() {
  if (isTicking || workerQueue.length === 0) {
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

  workerJobMap.delete(worker.pid);
  
  const { job } = message;
  
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
    console.log(`[Manager] Job ${job.id || 'unknown'} failed by ${worker.pid}: ${message.error}`);
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
  // Add worker back to pool

  workerQueue.push(worker); 
}

//
// 3. FAULT TOLERANCE - RESET STUCK JOBS
//
function resetStuckJob(workerPid) {
  const stuckJobId = workerJobMap.get(workerPid);
  if (stuckJobId) {
    console.warn(`[Manager] Worker ${workerPid} exited while processing job ${stuckJobId}. Resetting to 'pending'.`);
    try {
      db.prepare(
        "UPDATE jobs SET state = 'pending', updated_at = $now WHERE id = $id AND state = 'processing'"
      ).run({
        id: stuckJobId,
        now: Date.now(),
      });
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
    //TODO: have to change it for retry method with fixed retry and after that we have to push it into dlq
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
// 5. HTTP SERVER ROUTES (for the CLI client)
//
app.post('/enqueue', async (req, res) => {
  try {
    const jobData = req.body;
    const job = await enqueueJob(jobData, db);
    console.log(`[Server] Enqueued job ${job.id} via HTTP`);
    res.status(201).json(job);
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

//
// 6. MAIN STARTUP FUNCTION
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

  // Start periodic background saves for durability
  setInterval(() => {
    console.log('[Manager] Periodic background save...');
    saveDb(db);
  }, SAVE_INTERVAL);

  app.listen(PORT, () => {
    console.log(`[Manager] HTTP server listening on http://localhost:${PORT}`);
  });

  // This is now the FINAL save on graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[Manager] SIGINT (Ctrl+C) received. Saving database to disk...');
    saveDb(db); // Final save
    console.log('[Manager] Exiting.');
    process.exit(0);
  });
}