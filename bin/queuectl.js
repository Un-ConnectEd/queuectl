#!/usr/bin/env node
import { Command } from 'commander';
import { enqueueJob as enqueue, getJobs as listJobs } from '../src/job/job.js';
import { closeAndSaveDb } from '../src/db/db.js';

const program = new Command();
console.log('queuectl CLI starting...');
console.log('Node version:', process.version);

program
  .name('queuectl')
  .description('CLI-based background job queue system')
  .version('1.0.0');

//
// ENQUEUE
//
program
  .command('enqueue')
  .description('Add a new job to the queue')
  .argument('<command>', 'The command string to run')
  .option('-r, --retries <number>', 'Number of retries', 3)
  .action(async (commandStr, opts) => {
    console.log('Building job...');
    try {
      const jobData = {
        command: commandStr,
        max_retries: parseInt(opts.retries, 10)
      };
      console.log('Job data:', jobData);
      const result = await enqueue(jobData);
      console.log(' Job added:', result.id);
    } catch (err) {
      console.error('Debug: db.js: DB error:', err);
    }
  });

//
// LIST JOBS
//
program
  .command('list')
  .description('List jobs by state')
  .option('--state <state>', 'Job state filter (pending, processing, completed, failed, dead)')
  .action(async (opts) => {
    const jobs = await listJobs(opts.state);
    if (jobs && jobs.length > 0) {
      console.table(jobs);
    } else {
      console.log('Empty DB or not enqueued: check db.js/ No jobs found.');
    }
  });

//
// WORKERS
//

// This hook forces the DB to save
program.hook('postAction', async () => {
  await closeAndSaveDb();
});

program.parse(process.argv);