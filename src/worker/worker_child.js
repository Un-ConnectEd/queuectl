import { spawn } from 'child_process';
import { parse } from 'shell-quote';

function parseCommand(commandStr) {
  const [command, ...args] = parse(commandStr);
  return { command, args };
}

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
    const { command, args } = parseCommand(job.command);
    
    //allows shell comands but will be passed through shell-parser to detect and eliminate shell injection
    const child = spawn(command, args, { shell: true });


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
      // if hasFailed is true, the 'error' handler already sent the message
    });

    child.on('error', (err) => {
      // This fires for spawn errors like ENOENT
      sendFailure(`Failed to spawn: ${err.message}`);
    });

  } catch (err) {
    // This catches shell-quote.parse errors for security(shell-quote)
    sendFailure(`Unparseable command: ${err.message}`);
  }
});

// Tell the manager we are ready
process.send({ status: 'ready' });