#!/usr/bin/env node
import { Command } from 'commander';
import { enqueueJob as enqueue ,getJobs as listJobs } from '../src/job/job.js';


const program = new Command();
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
  .argument('<job>', 'Job JSON string')
  .action(async (job) => {
    try {
      const jobData = JSON.parse(job);
      const result = await enqueue(jobData);
      console.log('Job added:', result);
    } catch (err) {
      console.error('Invalid job JSON:', err.message);
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
    await listJobs(opts.state);
  });

//
// WORKERS
//
