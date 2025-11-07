import { Router } from 'express';
import { state } from '../worker/appState.js';
import { enqueueJob, getJobs } from '../job/job.js';

/**
 * Creates the router for core job endpoints (enqueue, list).
 * @param {import('sql.js').Database} db - The DB instance.
 * @param {object} config - The in-memory config object.
 * @returns {import('express').Router}
 */
export function createJobRouter(db, config) {
  const router = Router();

  // Path is '/enqueue' (mounted at /)
  router.post('/enqueue', async (req, res) => {
    try {
      if (state.isShuttingDown) {
        res.status(503).json({ error: "Server is shutting down. Not accepting new jobs." });
        return;
      }
      const job = await enqueueJob(req.body, db, config); 
      console.log(`[API] Enqueued job ${job.id}`);
      res.status(201).json(job);
      state.isDbChanged = true; // Use shared state
    } catch (err) {
      console.error("[API] Error enqueuing job:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Path is '/list' (mounted at /)
  router.get('/list', async (req, res) => {
    try {
      const jobs = await getJobs(req.query.state, db); 
      res.status(200).json(jobs);
    } catch (err) {
      console.error("[API] Error listing jobs:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}