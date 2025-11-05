import { openDb } from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Enqueue a new job
 */
export async function enqueueJob(jobData) {
  const db = await openDb();

  const id = jobData.id || uuidv4();
  const now = Date.now();

  const job = {
    id,
    command: jobData.command,
    state: 'pending',
    attempts: 0,
    max_retries: jobData.max_retries || 3,
    run_after: jobData.run_after || 0,
    created_at: now,
    updated_at: now
  };

  await db.run(
    `INSERT INTO jobs (id, command, state, attempts, max_retries, run_after, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      job.id,
      job.command,
      job.state,
      job.attempts,
      job.max_retries,
      job.run_after,
      job.created_at,
      job.updated_at
    ]
  );

  await db.close();
  return job;
}

/**
 * Get jobs by state (e.g. pending, completed, failed)
 */
export async function getJobs(state) {
  const db = await openDb();

  let rows;
  if (state) {
    rows = await db.all(`SELECT * FROM jobs WHERE state = ? ORDER BY created_at DESC`, [state]);
  } else {
    rows = await db.all(`SELECT * FROM jobs ORDER BY created_at DESC`);
  }

  await db.close();
  return rows;
}