import { Command } from 'commander';
import axios from 'axios'; // Use axios to send HTTP requests

// Server port
//TODO: have to change into .env variables in the future
const SERVER_URL = 'http://localhost:3000'; 
const program = new Command();

console.log('queuectl CLI starting...');

program
  .name('queuectl')
  .description('CLI-based background job queue system')
  .version('1.0.0');

//
// ENQUEUE (Now an HTTP client)
//
program
  .command('enqueue')
  .description('Add a new job to the queue')
  .argument('<command>', 'The command string to run')
  .option('-r, --retries <number>', 'Number of retries', 3)
  .action(async (commandStr, opts) => {
    console.log('Sending job to worker server...');
    try {
      const jobData = {
        command: commandStr,
        max_retries: parseInt(opts.retries, 10),
      };
      
      const res = await axios.post(`${SERVER_URL}/enqueue`, jobData);
      console.log('Job enqueued:', res.data.id);
    } catch (err) {
      if (err.response) {
        console.error('Error from server:', err.response.data);
      } else if (err.code === 'ECONNREFUSED') {
        console.error('Error: Could not connect to worker server.');
        console.log('Please ensure the worker is running: `node ./bin/queuectl.js worker start`');
      } else {
        console.error('Error enqueuing job:', err.message);
      }
    }
  });

//
// LIST JOBS (Now an HTTP client)
//
program
  .command('list')
  .description('List jobs by state')
  .option(
    '--state <state>',
    'Job state filter (pending, processing, completed, failed, dead)',
  )
  .action(async (opts) => {
    try {
      const res = await axios.get(`${SERVER_URL}/list`, { params: opts });
      const jobs = res.data;
      
      if (jobs && jobs.length > 0) {
        console.table(jobs);
      } else {
        console.log('No jobs found.');
      }
    } catch (err) {
      if (err.response) {
        console.error('Error from server:', err.response.data);
      } else if (err.code === 'ECONNREFUSED') {
        console.error('Error: Could not connect to worker server.');
        console.log('Please ensure the worker is running: `node ./bin/queuectl.js worker start`');
      } else {
        console.error('Error listing jobs:', err.message);
      }
    }
  });

//
// WORKERS (This is the one command that imports the server)
//
const worker = program.command('worker').description('Manage workers');

worker
  .command('start')
  .description('Start the worker server')
  .option('-c, --count <number>', 'Number of worker processes', 3)
  .action(async (opts) => {
    const count = parseInt(opts.count, 10);
    console.log(`Starting worker server with ${count} worker(s)...`);
    
    // Dynamically import the server code
    //TODO: have to be careful maybe a potential security risk
    const { startWorkers } = await import('../src/worker/worker.js');
    await startWorkers(count); // This function will now run forever starts the server.
  });
worker
  .command('stop')
  .description('Stop the worker server')
  .action(async () => {
    try {
      console.log('Sending graceful shutdown signal to worker server...');
      const res = await axios.post(`${SERVER_URL}/shutdown`);
      console.log(`Server response: ${res.data.message}`);
      
    } catch (err) {
      console.error('Error signaling shutdown:', err.response ? err.response.data.message : err.message);
    }
  });



//
// DLQ (list and retry)
//
const dlqCmd = program.command('dlq').description('Manage the Dead Letter Queue (dead jobs)');

dlqCmd
  .command('list')
  .description('List all jobs in the DLQ')
  .action(async () => {
    try {
      const res = await axios.get(`${SERVER_URL}/dlq`);
      const jobs = res.data;
      if (jobs && jobs.length > 0) {
        console.table(jobs);
      } else {
        console.log('No jobs found in DLQ.');
      }
    } catch (err) {
      console.error('Error listing DLQ:', err.response ? err.response.data : err.message);
    }
  });



dlqCmd
  .command('retry')
  .description('Retry a specific job or all jobs from the DLQ')
  .argument('[job-id]', 'The ID of the job to retry')
  .option('-a, --all', 'Retry all jobs in the DLQ')
  .action(async (jobId, options) => {
    try {
      if (options.all) {
        // --- Option 1: User ran 'queuectl dlq retry --all' ---
        console.log('Sending request to re-queue all DLQ jobs...');
        const res = await axios.post(`${SERVER_URL}/dlq/retry-all`);
        console.log(`Success: ${res.data.message}`);

      } else if (jobId) {
        // --- Option 2: User ran 'queuectl dlq retry <job-id>' ---
        await axios.post(`${SERVER_URL}/dlq/retry/${jobId}`);
        console.log(`Job ${jobId} sent to be re-queued.`);

      } else {
        // --- Option 3: User ran 'queuectl dlq retry' (no args) ---
        console.error('Error: You must specify a job-id or use the --all flag.');
        console.log('Example: queuectl dlq retry my-job-id');
        console.log('   ...or: queuectl dlq retry --all');
      }
    } catch (err) {
      console.error('Error retrying job(s):', err.response ? err.response.data : err.message);
    }
  });

//
// CONFIG (NEW)
//
const configCmd = program.command('config').description('Manage server configuration');

configCmd
  .command('list')
  .description('List all configuration keys and values')
  .action(async () => {
    try {
      const res = await axios.get(`${SERVER_URL}/config`);
      console.log('Server Configuration:');
      console.table(res.data);
    } catch (err) {
      console.error('Error fetching config:', err.response ? err.response.data : err.message);
    }
  });

configCmd
  .command('get')
  .description('Get a single configuration value')
  .argument('<key>', 'The config key to get')
  .action(async (key) => {
    try {
      const res = await axios.get(`${SERVER_URL}/config/${key}`);
      console.log(res.data);
    } catch (err) {
      console.error('Error fetching config key:', err.response ? err.response.data : err.message);
    }
  });

configCmd
  .command('set')
  .description('Set a configuration value on the server')
  .argument('<key>', 'The config key to set')
  .argument('<value>', 'The value to set')
  .action(async (key, value) => {
    try {
      const res = await axios.post(`${SERVER_URL}/config`, { key, value });
      console.log(`Config updated: ${key} = ${res.data[key]}`);
      if (key.includes('interval')) {
        console.log('Note: Interval changes may require a server restart to take effect.');
      }
    } catch (err) {
      console.error('Error setting config:', err.response ? err.response.data : err.message);
    }
  });
  
program.parse(process.argv);