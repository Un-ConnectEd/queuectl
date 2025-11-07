// src/job/job.js
import { v4 as uuidv4 } from 'uuid';
// No database imports needed!

/**
 * Enqueues a job into the provided in-memory DB instance.
 */
export async function enqueueJob(jobData, db) {
  try {
    const id = jobData.id || uuidv4();
    const now = Date.now();

    const job = {
      id,
      command: jobData.command,
      state: 'pending',
      attempts: 0,
      max_retries: jobData.max_retries,
      run_after: jobData.run_after || 0,
      created_at: now,
      updated_at: now,
    };

    const stmt = db.prepare(`
      INSERT INTO jobs (id, command, state, attempts, max_retries, run_after, created_at, updated_at)
      VALUES ($id, $command, $state, $attempts, $max_retries, $run_after, $created_at, $updated_at)
    `);
    
    stmt.run({
      $id: job.id,
      $command: job.command,
      $state: job.state,
      $attempts: job.attempts,
      $max_retries: job.max_retries,
      $run_after: job.run_after,
      $created_at: job.created_at,
      $updated_at: job.updated_at,
    });
    stmt.free();
    return job;
  } catch (err) {
    console.error('Failed to enqueue job:', err);
    throw err; // Re-throw to be caught by the server
  }
}

/**
 * Gets jobs from the provided in-memory DB instance.
 */
export async function getJobs(state, db) {
  let stmt;
  try {
    if (state) {
      stmt = db.prepare("SELECT * FROM jobs WHERE state = ? ORDER BY created_at DESC");
      stmt.bind([state]);
    } else {
      stmt = db.prepare("SELECT * FROM jobs ORDER BY created_at DESC");
    }

    const rows = [];
    while (stmt.step()) { 
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  } catch (err) {
    console.error('Failed to get jobs:', err);
    if (stmt) stmt.free();
    throw err; // Re-throw
  }
}