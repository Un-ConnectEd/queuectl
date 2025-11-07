import { execa } from 'execa';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { platform } from 'os';

// --- CONFIG ---
const API_URL = 'http://localhost:3000';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '../bin/queuectl.js');
const DB_PATH = path.resolve(__dirname, '../db/queue.db');

const TEST_CONFIG = {
  tick_interval_ms: 100,
  save_interval_ms: 1000,
  backoff_base: 2,
  backoff_factor_ms: 100,
  max_retries: 2, // 1 initial + 2 retries = 3 total attempts
};

const SLEEP_COMMAND =
  platform() === 'win32'
    ? 'ping 127.0.0.1 -n 2 > NUL'
    : 'ping 127.0.0.1 -c 2 > /dev/null';

/**
 * A simple sleep utility.
 * @param {number} ms - Milliseconds to sleep.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Manages the state of the test environment (server process, API calls)
 */
class TestRig {
  constructor() {
    this.serverProcess = null;
    this.api = axios.create({ baseURL: API_URL });
  }

  cleanDb() {
    if (fs.existsSync(DB_PATH)) {
      fs.unlinkSync(DB_PATH);
      console.log('[TEST] ... Cleaned old database file.');
    }
  }

  startServer(args = []) {
    const options = {
      detached: true,
      stdio: 'ignore',
    };
    this.serverProcess = execa('node', [CLI_PATH, 'worker', 'start', ...args], options);
    this.serverProcess.unref();
  }

  async stopServer() {
    try {
      await this.api.post('/shutdown');
      await sleep(1500); // Give it time to shut down
    } catch (err) {
      // Ignore
    }
    if (this.serverProcess) {
      this.serverProcess.kill('SIGTERM', undefined, { forceKillAfterTimeout: 2000 });
    }
    this.serverProcess = null;
  }

  async waitForApi() {
    for (let i = 0; i < 20; i++) { // Max 10s
      try {
        await this.api.get('/status');
        console.log('  ... API is ready.');
        return;
      } catch (err) {
        await sleep(500);
      }
    }
    throw new Error('Timeout waiting for API to respond.');
  }

  async waitForJob(jobId, state) {
    for (let i = 0; i < 30; i++) { // Max 15s
      try {
        const res = await this.api.get('/list');
        const job = res.data.find((j) => j.id === jobId);
        if (job && job.state === state) return job;
      } catch (err) { /* ignore */ }
      await sleep(500);
    }
    throw new Error(`Timeout waiting for job ${jobId} to reach state '${state}'.`);
  }

  async waitForWorkers(status, expectedCount) {
    for (let i = 0; i < 20; i++) { // Max 5s
      try {
        const res = await this.api.get('/status');
        if (res.data.workerSummary[status] === expectedCount) return;
      } catch (err) { /* ignore */ }
      await sleep(250);
    }
    throw new Error(`Timeout waiting for ${status} workers to be ${expectedCount}.`);
  }

  async setFastConfig() {
    console.log('[TEST] Setting fast config for tests...');
    this.cleanDb();
    this.startServer();
    await this.waitForApi();

    for (const [key, value] of Object.entries(TEST_CONFIG)) {
      await this.api.post('/config', { key, value });
    }

    console.log('  ... Config set. Stopping server...');
    await this.stopServer();
    console.log('  ... Server stopped.');
  }
}

/**
 * Helper function to run and log a test.
 * @param {string} name - The name of the test.
 * @param {Function} testFn - The async test function.
 */
async function runTest(name, testFn) {
  console.log(`[TEST] Running Test: ${name}`);
  try {
    await testFn();
    console.log('  ... PASSED');
  } catch (err) {
    console.error(`\n--- ❌ TEST FAILED: ${name} ---`);
    console.error(err.message);
    if (err.response?.data) {
      console.error('--- Server Response ---');
      console.error(err.response.data);
    } else {
      console.error('--- END OF ERROR ---');
    }
    throw err; // Stop the test run
  }
}

// --- MAIN TEST RUNNER ---
async function main() {
  const rig = new TestRig();

  try {
    // 1. One-time setup
    await rig.setFastConfig();

    // 2. Start server for real tests
    console.log('[TEST] Restarting server with 3 workers for testing...');
    rig.startServer(['--count', '3']);
    await rig.waitForApi();

    // 3. Run tests
    await runTest('Successful Job', async () => {
      const res = await rig.api.post('/enqueue', { id: 'job-pass', command: 'echo "success"' });
      const job = await rig.waitForJob(res.data.id, 'completed');
      if (job.attempts !== 0) throw new Error('Success job had attempts > 0');
    });

    await runTest('Failed Job to DLQ', async () => {
      const res = await rig.api.post('/enqueue', { id: 'job-fail', command: 'exit 1' });
      const job = await rig.waitForJob(res.data.id, 'dead');
      if (job.attempts !== 3) throw new Error(`DLQ job had ${job.attempts} attempts, expected 3`);
    });

    await runTest('DLQ Retry', async () => {
      await rig.api.post('/dlq/retry/job-fail'); // Re-use from previous test
      const job = await rig.waitForJob('job-fail', 'dead');
      if (job.attempts !== 3) throw new Error(`Retried job had ${job.attempts} attempts, expected 3`);
    });

    await runTest('Concurrency', async () => {
      const jobIds = [];
      for (let i = 0; i < 5; i++) {
        const res = await rig.api.post('/enqueue', { command: SLEEP_COMMAND });
        jobIds.push(res.data.id);
      }

      console.log('  ... Waiting for workers to pick up jobs...');
      await rig.waitForWorkers('processing', 3);
      console.log('  ... 3 workers are processing.');

      const statusRes = await rig.api.get('/status');
      if (statusRes.data.jobSummary.pending !== 2) {
        throw new Error(`Expected 2 pending jobs, got ${statusRes.data.jobSummary.pending}`);
      }
      console.log('  ... 2 jobs are pending.');

      await Promise.all(jobIds.map(id => rig.waitForJob(id, 'completed')));
      console.log('  ... All 5 jobs completed.');
      
      await rig.waitForWorkers('idle', 3);
    });

    console.log('\n--- ALL TESTS PASSED ---');
    
  } catch (err) {
    // Error is already logged by runTest
  } finally {
    await rig.stopServer();
  }
}

main();