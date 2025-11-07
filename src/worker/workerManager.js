import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { state } from './appState.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Assumes worker_child.js is in the same directory
const WORKER_SCRIPT = path.join(__dirname, 'worker_child.js'); 

/**
 * Manages the pool of child workers and schedules jobs.
 * Emits an 'idle' event when all jobs are done during shutdown.
 */
export class WorkerManager extends EventEmitter {
  /**
   * @param {import('sql.js').Database} db - The DB instance.
   * @param {object} config - The in-memory config object.
   */
  constructor(db, config) {
    super();
    this.db = db;
    this.config = config;
    this.workerQueue = []; // Queue of *available* worker processes
    this.workerJobMap = new Map(); // <worker.pid, job.id>
    this.isTicking = false;
  }

  /**
   * Spawns the initial set of workers.
   * @param {number} count - Number of workers to spawn.
   */
  init(count) {
    console.log(`[Manager] Starting ${count} workers...`);
    for (let i = 0; i < count; i++) {
      this.spawnWorker();
    }
  }

  /**
   * Core job scheduler loop. Finds a pending job and
   * assigns it to an available worker.
   */
  tick() {
    if (state.isShuttingDown || this.isTicking || this.workerQueue.length === 0) {
      return;
    }
    this.isTicking = true;

    try {
      const stmt = this.db.prepare(
        "SELECT * FROM jobs WHERE state = 'pending' AND run_after <= $now ORDER BY created_at ASC LIMIT 1",
      );
      stmt.bind({ $now: Date.now() });

      if (stmt.step()) {
        const job = stmt.getAsObject();
        stmt.free();
        
        // Get an available worker and remove it from the queue
        const worker = this.workerQueue.shift();

        console.log(`[Manager] Assigning job ${job.id} to worker ${worker.pid}`);
        this.db.prepare(
          'UPDATE jobs SET state = $state, updated_at = $now WHERE id = $id',
        ).run({
          $id: job.id,
          $state: 'processing',
          $now: Date.now(),
        });
        
        state.isDbChanged = true;
        this.workerJobMap.set(worker.pid, job.id); // Track the job
        worker.send(job); // Send the job to the child process
      } else {
        stmt.free();
      }
    } catch (err) {
      console.error('[Manager] Error in tick loop:', err.message);
    }
    this.isTicking = false;
  }

  /**
   * Spawns a new worker, sets up listeners, and handles respawning.
   */
  spawnWorker() {
    if (state.isShuttingDown) {
      return;
    }
    const worker = fork(WORKER_SCRIPT);
    
    worker.on('message', (message) =>
      this.handleWorkerMessage(worker, message),
    );
    
    worker.on('exit', (code) => {
      console.warn(`[Manager] Worker ${worker.pid} exited with code ${code}`);
      
      // Remove from available queue just in case
      const queueIndex = this.workerQueue.indexOf(worker);
      if (queueIndex > -1) {
        this.workerQueue.splice(queueIndex, 1);
      }

      // Check if it died while processing a job
      this.resetStuckJob(worker.pid);
      
      // Respawn
      console.log('[Manager] Spawning a replacement worker...');
      this.spawnWorker();
    });

    worker.on('error', (err) => {
      console.error(`[Manager] Worker ${worker.pid} had an error:`, err);
      // Note: 'exit' will also fire, so respawn logic is handled there
    });
  }

  /**
   * Handles messages (ready, completed, failed) from child workers.
   */
  handleWorkerMessage(worker, message) {
    if (message.status === 'ready') {
      console.log(`[Manager] Worker ${worker.pid} is ready.`);
      this.workerQueue.push(worker); // Add to the available pool
      return;
    }

    const { job } = message;
    
    if (job && job.id) {
      // Job is finished, so stop tracking it
      this.workerJobMap.delete(worker.pid); 

      if (message.status === 'completed') {
        console.log(`[Manager] Job ${job.id} completed by ${worker.pid}`);
        this.db.prepare(
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
        const maxRetries = job.max_retries ?? parseInt(this.config.max_retries, 10);
        let newState = newAttempts > maxRetries ? 'dead' : 'pending';
        
        // Use config for backoff
        const base = parseInt(this.config.backoff_base, 10);
        const factor = parseInt(this.config.backoff_factor_ms, 10);
        let newRunAfter = Date.now() + Math.pow(base, newAttempts) * factor;
        
        this.db.prepare(
          'UPDATE jobs SET state = $state, updated_at = $now, attempts = $attempts, run_after = $run_after WHERE id = $id',
        ).run({
          $id: job.id,
          $state: newState,
          $now: Date.now(),
          $attempts: newAttempts,
          $run_after: newRunAfter
        });
      }
      state.isDbChanged = true;
    } else {
       console.warn(`[Manager] Worker ${worker.pid} sent a message for an invalid job.`, message);
    }

    // Add the worker back to the available pool
    this.workerQueue.push(worker); 

    // If we're shutting down, check if this was the last job
    if (state.isShuttingDown && this.workerJobMap.size === 0) {
      console.log(`[Manager] Last job completed.`);
      this.emit('idle'); // Signal to shutdown logic
    }
  }

  /**
   * Resets a job to 'pending' if its worker crashed.
   */
  resetStuckJob(workerPid) {
    const stuckJobId = this.workerJobMap.get(workerPid);
    if (stuckJobId) {
      console.warn(`[Manager] Worker ${workerPid} exited while processing job ${stuckJobId}. Resetting to 'pending'.`);
      try {
        this.db.prepare(
          "UPDATE jobs SET state = 'pending', updated_at = $now WHERE id = $id AND state = 'processing'"
        ).run({
          $id: stuckJobId,
          $now: Date.now(),
        });
        state.isDbChanged = true;
      } catch (err) {
        console.error(`[Manager] FATAL: Could not reset stuck job ${stuckJobId}:`, err);
      }
      this.workerJobMap.delete(workerPid);
    }
  }

  /**
   * Gets the number of jobs currently being processed.
   * @returns {number}
   */
  getProcessingJobCount() {
    return this.workerJobMap.size;
  }

  /**
   * Gets the current worker status counts.
   * @returns {{ processing: number, idle: number, live: number, target: number }}
   */
  getWorkerStats() {
    const processing = this.workerJobMap.size;
    const idle = this.workerQueue.length;
    // 'live' is how many workers are actually connected and ready/processing
    return { 
      processing: processing, 
      idle: idle, 
      live: processing + idle,
    };
  }
}