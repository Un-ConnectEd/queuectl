import { Router } from 'express';

/**
 * Creates the router for the main status endpoint.
 * @param {import('sql.js').Database} db
 * @param {import('../worker/workerManager.js').WorkerManager} workerManager
 * @returns {import('express').Router}
 */
export function createStatusRouter(db, workerManager) {
  const router = Router();

  /**
   * @route GET /status
   * @group Status
   * @returns {object} 200 - An object with job and worker summaries
   */
  router.get('/status', async (req, res) => {
    try {
      // 1. Get Job Counts
      const jobCounts = {};
      const states = ['pending', 'processing', 'completed', 'failed', 'dead'];
      
      const stmt = db.prepare("SELECT state, COUNT(*) as count FROM jobs GROUP BY state");
      while (stmt.step()) {
        const row = stmt.getAsObject();
        jobCounts[row.state] = row.count;
      }
      stmt.free();

      // Ensure all states are present, even if count is 0
      for (const state of states) {
        if (!jobCounts[state]) {
          jobCounts[state] = 0;
        }
      }

      // 2. Get Worker Status from the manager
      const workerStats = workerManager.getWorkerStats();

      // 3. Combine and Respond
      res.status(200).json({
        jobSummary: jobCounts,
        workerSummary: workerStats
      });

    } catch (err) {
      console.error("[API/Status] Error fetching status:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}