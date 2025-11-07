import { spawn } from 'child_process';

process.on('message', (job) => {
  if (!job || !job.command) {
    console.error(`[Worker ${process.pid}] Received an invalid or undefined job. Ignoring.`);
    process.send({ status: 'failed', job: { id: 'unknown' }, error: 'Invalid job received' });
    return;
  }

  console.log(`[Worker ${process.pid}] Received job: ${job.id}`);

  let stdout = '';
  let stderr = '';
  
  let hasFailed = false;

  // error handling
  const sendFailure = (errorMsg) => {
    if (hasFailed) return;
    hasFailed = true;
    
    console.error(`[Worker ${process.pid}] Job ${job.id} failed`, errorMsg);
    process.send({ status: 'failed', job, error: errorMsg });
  };

  try {
    const child = spawn(job.command, [], { shell: true });


    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0 && !hasFailed) {
        // loging on the console the sucess
        console.log(`[Worker ${process.pid}] Job ${job.id} completed`, stdout);
        process.send({ status: 'completed', job, output: stdout });
      } else if (code !== 0) {
        sendFailure(stderr || `Process exited with code ${code}`);
      }
    });

    child.on('error', (err) => {
      sendFailure(`Failed to spawn: ${err.message}`);
    });

  } catch (err) {
    sendFailure(`Internal worker error: ${err.message}`);
  }
});

// Tell the manager we are ready
process.send({ status: 'ready' });