

import { getDbInstance } from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';

export async function enqueueJob(jobData) {
  try {
    const db = await getDbInstance();
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

    // sql.js uses $name for bindings
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

    console.log('DEbug: job.js: Enqueued job:', job.id);
    return job;

  } catch (err) {
    console.error('DEbug: job.js/ db.js: Failed to enqueue job:', err);
  }
}

/**
 * Get jobs by state (e.g. pending, completed, failed)
 */
export async function getJobs(state) {
  const db = await getDbInstance();
  let stmt;
  
  try {
    if (state) {
      stmt = db.prepare("SELECT * FROM jobs WHERE state = ? ORDER BY created_at DESC");
      stmt.bind([state]);
    } else {
      stmt = db.prepare("SELECT * FROM jobs ORDER BY created_at DESC");
    }

    // Loop over results rows
    const rows = [];
    while (stmt.step()) { 
      rows.push(stmt.getAsObject());
    }
    
    stmt.free();
    return rows;
    
  } catch (err) {
    console.error('Debug:job.js:  Failed to get jobs:', err);
    // free the db state even on error.
    if (stmt) stmt.free();
    return [];
  }
}