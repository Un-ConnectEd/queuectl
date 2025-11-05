#!/usr/bin/env node
import { Command } from 'commander';


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
    await enqueue(job);
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
