import { Router } from 'express';
import { allowOnlyLocalhost } from './middleware.js';

/**
 * Creates the router for the shutdown endpoint.
 * @param {Function} shutdownHandler - The main function to call to initiate shutdown.
 * @returns {import('express').Router}
 */
export function createShutdownRouter(shutdownHandler) {
  const router = Router();

  // Path is now '/shutdown' (mounted at /)
  // We apply the localhost middleware just for this route.
  router.post('/shutdown', allowOnlyLocalhost, (req, res) => {
    console.log('[API] Shutdown request received via HTTP...');
    res.status(200).json({ message: "Shutdown initiated." });
    
    // Call the main handler passed in from worker.js
    shutdownHandler(); 
  });

  return router;
}