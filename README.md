# queuectl - A CLI-based Background Job Queue

queuectl is a minimal, production-grade job queue system built with Node.js. It supports enqueuing
shell commands, parallel processing with multiple workers, persistent job storage, exponential backoff
retries, and a dead-letter queue (DLQ).

## Installation

1. Clone the repository

    ```bash
    git clone  https://github.com/Un-ConnectEd/queuectl.git
    cd queuectl
    ```

2. Install dependencies using pnpm:

```
pnpm install
```

(This will install all dependencies from package.json, including express, commander, axios,
sql.js, uuid, and execa.)

## Architecture Overview

The queuectl system is composed of two main parts that run in a single worker start command:

1. The API Server: A lightweight HTTP server built with Express.js. It exposes endpoints for
    enqueuing jobs, listing jobs, and managing configuration. The queuectl CLI tool is an HTTP client
    that interacts with this server.
2. The Worker Manager: A background process that manages a pool of child workers.
    Persistence: Job data is stored in a queue.db file (in the db/ directory). This is an in-
    memory sql.js (SQLite) database that is loaded on start and saved to disk periodically and
    on shutdown.
    Job Scheduler (Ticker): The manager runs a "tick" loop. On each tick, it queries the
    database for pending jobs whose run_after time has passed.
    Worker Pool: It forks multiple worker_child.js processes. When a job is found, it is
    assigned to an idle worker.
    IPC: The manager and workers communicate over Node.js's built-in IPC (message passing) to
    assign jobs and report back completed or failed status.

## Usage

The queuectl command is the main interface. All commands (except worker start) send HTTP
requests to the running server.

1. Start the Server and Workers

This is the main command. It must be running in a terminal for any other commands to work.
```
# Start the server with default worker processes
pnpm start
```
(This will run the start script defined in package.json).

or

```
# Start the server with 3 worker processes
node ./bin/queuectl.js worker start --count 3
```

_Options:_

```
--count <number>: Specify the number of parallel workers to run.
```
2. Stop the Server

This command sends a graceful shutdown signal to the server.

```
node ./bin/queuectl.js worker stop
```
The server will stop accepting new jobs, wait for all _processing_ jobs to finish, and then exit.

3. Enqueue a Job

Add a new job (a shell command) to the queue.

```
# Enqueue a simple job
node ./bin/queuectl.js enqueue "echo 'Hello World'"
# Enqueue a job that will fail, with custom retries
node ./bin/queuectl.js enqueue "exit 1" --retries 2
```
_Options:_

```
--retries <number>: Set a custom max_retries for this job.
```
4. Check System Status

Get a summary of the system's health.

```
node ./bin/queuectl.js status
```
_Example Output:_

```
--- Job Summary ---
┌───────────┬────────┐
│ (index) │ Values │
├───────────┼────────┤
│ pending │ 5 │
│ processing│ 3 │
│ completed │ 10 │
│ dead │ 2 │
└───────────┴────────┘
--- Worker Summary ---
┌──────────────┬────────┐
│ (index) │ Values │
├──────────────┼────────┤
│ Processing │ 3 │
│ Idle (Ready) │ 0 │
│ Live Workers │ 3 │
```

```
└──────────────┴────────┘
```
5. List Jobs

View all jobs or filter by a specific state.

```
# List all jobs
node ./bin/queuectl.js list
# List only jobs in the dead-letter queue
node ./bin/queuectl.js list --state dead
```
_Options:_

```
--state <state>: Filter by pending, processing, completed, failed, or dead.
```
6. Manage the Dead Letter Queue (DLQ)

Manage jobs that have failed all their retry attempts.

```
# List all jobs in the DLQ
node ./bin/queuectl.js dlq list
# Retry a specific job from the DLQ
node ./bin/queuectl.js dlq retry <job-id>
# Retry all jobs in the DLQ
node ./bin/queuectl.js dlq retry --all
```
7. Manage Configuration

View and change the server's configuration on-the-fly.

```
# List all current config values
node ./bin/queuectl.js config list
# Get a single value
node ./bin/queuectl.js config get max_retries
# Set a new value
node ./bin/queuectl.js config set max_retries 5
```
_Configurable Keys:_

```
max_retries: Default number of retries for new jobs.
backoff_base: The base for the exponential backoff calculation.
backoff_factor_ms: The multiplier (in ms) for the backoff.
tick_interval_ms: How often the manager checks for new jobs.
save_interval_ms: How often the database is saved to disk.
```

also can check what any commands by using --help flag

## Assumptions and Trade-offs

```
Persistence: This system uses sql.js (SQLite compiled to Wasm). The database runs in-
memory and is persisted to a file (db/queue.db). This is lightweight and requires no external
database server, but it is not as robust as a dedicated PostgreSQL or MySQL server. The entire
database must fit in memory. and is very easy to setup
Job Locking: Job concurrency is handled at the manager level. The manager's tick() loop is
single-threaded and assigns one job at a time to an idle worker, which is a simple and effective
locking mechanism.
Cross-Platform Commands: The worker_child.js executes commands using { shell: true
}. This means platform-specific commands (like sleep 0.5 vs. ping) must be considered.
Trade-off: sql.js is slow in write into memory can use better-sqlite3/sqlite3 but if the builded 
ones for your node versionor cpp build tools are not present can cause problem in setting up, sql.js
is just a library and very easy set-up but traded for speed.
```
## Testing

A full end-to-end test script is included. This script will start and stop the server, clean the database,
and run through all core test scenarios (success, failure, DLQ, and concurrency).

To run the test suite:

```
pnpm test
```
(This will run the test script defined in package.json).


