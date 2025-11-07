import { Router } from 'express';
import { state } from '../worker/appState.js';
import { getJobs } from '../job/job.js'; // <-- Added this import

/**
 * Creates the router for all DLQ-related endpoints.
 * @param {import('sql.js').Database} db - The DB instance.
 * @returns {import('express').Router}
 */
export function createDlqRouter(db) {
  const router = Router(); // Create the router

  // All logic goes INSIDE the function, using 'router'

  // Path is now '/' (mounted at /dlq)
  router.get('/', async (req, res) => {
    try {
      const jobs = await getJobs('dead', db); // Use imported getJobs
      res.status(200).json(jobs);
    } catch (err) {
      console.error("[API/DLQ] Error listing DLQ jobs:", err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 1. RETRY SINGLE JOB
   */
  // Path is now '/retry/:id'
  router.post('/retry/:id', async (req, res) => {
    // Use shared state
    if (state.isShuttingDown) { 
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
        $state: 'dead',
        $now: now
      });

      if (result.changes === 0) {
        return res.status(404).json({ message: `No dead job found with id ${jobId}.` });
      }

      state.isDbChanged = true; // Use shared state
      console.log(`[API] Job ${jobId} re-queued from DLQ.`);
      res.status(200).json({ message: `Job ${jobId} re-queued.` });

    } catch (err) {
      console.error("[API/DLQ] Error retrying single job:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Path is now '/retry-all'
  router.post('/retry-all', async (req, res) => {
    // Use shared state
    if (state.isShuttingDown) {
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
        $state: 'dead'
      });

      const count = result.changes;
      
      if (count > 0) {
        state.isDbChanged = true; // Use shared state
        console.log(`[API] ${count} jobs re-queued from DLQ.`);
        res.status(200).json({ message: `${count} jobs re-queued.` });
      } else {
        res.status(404).json({ message: "No jobs found in DLQ to retry." });
      }
    } catch (err) {
      console.error("[API/DLQ] Error retrying all jobs:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router; // Return the configured router
}