import express from 'express';
import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDbInstance, saveDb, getConfig, setConfig, getOneConfig } from '../db/db.js'; 
import { enqueueJob, getJobs } from '../job/job.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, 'worker_child.js');
const PORT = process.env.PORT || 3000; 
let TICK_INTERVAL = 250; 
let SAVE_INTERVAL = 5000;

let isDbChanged = false;

const app = express();
app.use(express.json());

const workerQueue = []; 
let db; 
let config; // Module-level config object
let isTicking = false;

const workerJobMap = new Map(); // <worker.pid, job.id>

let isShuttingDown = false;
let server;

//
// WORKER LOGIC (TICKER)
//
async function tick() {
  if (isShuttingDown || isTicking || workerQueue.length === 0) {
    return;
  }
  isTicking = true;

  try {
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
    workerJobMap.delete(worker.pid); 

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
      // Use config for retry logic
      const newAttempts = (job.attempts || 0) + 1;
      const maxRetries = job.max_retries ?? parseInt(config.max_retries, 10);
      let newState = newAttempts > maxRetries ? 'dead' : 'pending';
      
      // Use config for backoff
      const base = parseInt(config.backoff_base, 10);
      const factor = parseInt(config.backoff_factor_ms, 10);
      let newRunAfter = Date.now() + Math.pow(base, newAttempts) * factor;
      
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
    
    const queueIndex = workerQueue.indexOf(worker);
    if (queueIndex > -1) {
      workerQueue.splice(queueIndex, 1);
    }

    resetStuckJob(worker.pid);
    
    console.log('[Manager] Spawning a replacement worker...');
    spawnWorker();
  });

  worker.on('error', (err) => {
    console.error(`[Manager] Worker ${worker.pid} had an error:`, err);
    // Note: 'exit' will also fire, so respawn logic is handled there
  });
}

//
// HTTP SERVER ROUTES
//
app.post('/enqueue', async (req, res) => {
  try {
    if (isShuttingDown) {
    res.status(503).json({ error: "Server is shutting down. Not accepting new jobs." });
    return;
  }
    const jobData = req.body;
    // Pass config to enqueueJob to apply defaults
    const job = await enqueueJob(jobData, db, config); 
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

//
// DLQ ROUTES (ALL FIXES APPLIED)
//
app.get('/dlq', async (req, res) => {
  try {
    const jobs = await getJobs('dead', db);
    res.status(200).json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 1. RETRY SINGLE JOB (Fully Corrected)
 */
app.post('/dlq/retry/:id', async (req, res) => {
  if (isShuttingDown) { 
    return res.status(503).json({ error: "Server is shutting down. Not accepting new requests." });
  }

  try {
    const jobId = req.params.id;

    if (!jobId || typeof jobId !== 'string' || jobId.trim() === '') {
      return res.status(400).json({ error: "Invalid job ID." });
    }

    const now = Date.now();

    const result = db.prepare(
      "UPDATE jobs SET state = 'pending', attempts = 0, run_after = 0, updated_at = $now " +
      "WHERE id = $id AND state = $state" 
    ).run({
      $id: jobId,
      $state: 'dead', // Bind parameter
      $now: now
    });
    var a = result.changes

    if (result.changes === 0) {
      return res.status(404).json({ message: `No dead job found with id ${jobId}.` });
    }

    isDbChanged = true;
    console.log(`[Manager] Job ${jobId} re-queued from DLQ.`);
    res.status(200).json({ message: `Job ${jobId} re-queued.` });

  } catch (err) {
    console.error("[DLQ] Error retrying single job:", err);
    res.status(500).json({ error: err.message });
  }
});


app.post('/dlq/retry-all', async (req, res) => {
  if (isShuttingDown) {
    res.status(503).json({ error: "Server is shutting down. Not accepting new requests." });
    return;
  }

  try {
    const now = Date.now();
    const result = db.prepare(
      "UPDATE jobs SET state = 'pending', attempts = 0, run_after = 0, updated_at = $now " +
      "WHERE state = $state"
    ).run({ 
      $now: now,
      $state: 'dead' // Bind parameter
    });

    const count = result.changes;
    /*TODO: fix the error handeling due to possible race condition . even though the retry is working properly 
    *logging is not handeled correctly
     */ 
    if (count > 0) {
      isDbChanged = true;
      console.log(`[Manager] ${count} jobs re-queued from DLQ.`);
      res.status(200).json({ message: `${count} jobs re-queued.` });
    } else {
      res.status(404).json({ message: "No jobs found in DLQ to retry." });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

//
// CONFIG ROUTES (NEW)
//

// Middleware to protect sensitive routes
const allowOnlyLocalhost = (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    console.warn(`[Manager] Rejected config request from non-localhost IP: ${ip}`);
    return res.status(403).json({ error: "Forbidden: Config requests only allowed from localhost." });
  }
  next();
};

// Get all config
app.get('/config', allowOnlyLocalhost, async (req, res) => {
  try {
    // Read from the in-memory config object
    res.status(200).json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a single config key
app.get('/config/:key', allowOnlyLocalhost, async (req, res) => {
  try {
    const key = req.params.key;
    if (config.hasOwnProperty(key)) {
      res.status(200).json({ [key]: config[key] });
    } else {
      res.status(404).json({ error: `Config key "${key}" not found.` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set a single config key
app.post('/config', allowOnlyLocalhost, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || value === undefined) {
      return res.status(400).json({ error: "Missing 'key' or 'value' in request body." });
    }

    // 1. Update the database
    setConfig(key, value, db);
    isDbChanged = true;

    // 2. Update the in-memory config
    config[key] = String(value);

    // 3. Re-apply any intervals that might have changed
    if (key === 'tick_interval_ms') {
      // This is tricky to change live. For now, we'll log it.
      // A full implementation would clear and reset the interval.
      console.warn(`[Manager] Config 'tick_interval_ms' changed. Restart server to apply.`);
    }
    if (key === 'save_interval_ms') {
      console.warn(`[Manager] Config 'save_interval_ms' changed. Restart server to apply.`);
    }

    console.log(`[Manager] Config updated: ${key} = ${value}`);
    res.status(200).json({ [key]: value });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


//
// SHUTDOWN ROUTES
//
app.post('/shutdown', allowOnlyLocalhost, (req, res) => {
  console.log('[Manager] Shutdown request received via HTTP...');
  res.status(200).json({ message: "Shutdown initiated." });
  initiateShutdown();
});

function awaitIdleAndExit() {
  console.log('\n[Manager] All workers are idle. Saving database to disk...');
  saveDb(db);
  console.log('[Manager] Database saved. Exiting gracefully.');
  process.exit(0);
}

function initiateShutdown() {
  if (isShuttingDown) {
    return;
  }

  console.log('\n[Manager] Initiating graceful shutdown...');
  isShuttingDown = true;
  
  console.log('[Manager] Stopping job ticker...');

  server.close(() => {
    console.log('[Manager] HTTP server closed.');
  });

  if (workerJobMap.size === 0) {
    console.log('[Manager] No jobs are currently processing.');
    awaitIdleAndExit();
  } else {
    console.log(`[Manager] Waiting for ${workerJobMap.size} processing job(s) to complete...`);
  }
}

//
// MAIN STARTUP FUNCTION
//
export async function startWorkers(count) {
  db = await getDbInstance();
  
  // Load config from DB into module-level variable
  config = await getConfig(db);
  console.log('[Manager] Configuration loaded:', config);

  // Set intervals from loaded config
  TICK_INTERVAL = parseInt(config.tick_interval_ms, 10);
  SAVE_INTERVAL = parseInt(config.save_interval_ms, 10);

  console.log(`[Manager] Starting ${count} workers...`);
  for (let i = 0; i < count; i++) {
    spawnWorker();
  }

  setInterval(tick, TICK_INTERVAL);

  setInterval(() => {
    if (isDbChanged) {
      console.log('[Manager] Periodic background save...');
      const success = saveDb(db); 
      
      if (success) {
        isDbChanged = false; 
      } else {
        console.warn('[Manager] Database save failed! Will retry next interval.');
      }
    } else {
      // This is too noisy, let's remove it
      // console.log('[Manager] no changes so no save');
    }
  }, SAVE_INTERVAL);

  server = app.listen(PORT, () => {
    console.log(`[Manager] HTTP server listening on http://localhost:${PORT}`);
  });

  process.on('SIGINT', () => {
    console.log('\n[Manager] SIGINT (Ctrl+C) received.');
    initiateShutdown();
  });
}