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

program.parse(process.argv);