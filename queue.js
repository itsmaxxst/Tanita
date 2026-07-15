'use strict';

const { EventEmitter } = require('events');

/**
 * Lightweight Job Queue System
 * Features: Concurrency control, priority queues, retries, delayed jobs
 *
 */
class JobQueue extends EventEmitter {
  #concurrency;
  #retryDelay;
  #defaultTimeout;
  #jobs;
  #running;
  #paused;
  #handlers;
  #stats;

  constructor(options = {}) {
    super();
    this.#concurrency    = options.concurrency || 1;
    this.#retryDelay     = options.retryDelay  ?? 1000;
    this.#defaultTimeout = options.timeout     || 30_000;
    this.#jobs    = [];
    this.#running = 0;
    this.#paused  = false;
    this.#handlers = new Map();

    this.#stats = {
      completed: 0,
      failed:    0,
      retried:   0,
    };
  }

  // --- Public API ------------------------------------------------------------

  /**
   * Register a handler for a job type.
   * @param {string}   jobType
   * @param {Function} handler  async (data, job) => result
   */
  process(jobType, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('Handler must be a function');
    }
    this.#handlers.set(jobType, handler);
    return this;
  }

  /**
   * Add a job to the queue.
   * @returns {string} jobId
   */
  add(jobType, data = {}, options = {}) {
    const job = {
      id:          this.#generateId(),
      type:        jobType,
      data,
      priority:    options.priority    ?? 0,
      attempts:    0,
      maxAttempts: options.maxAttempts ?? 1,
      timeout:     options.timeout     ?? this.#defaultTimeout,
      delay:       options.delay       ?? 0,
      createdAt:   Date.now(),
      status:      'pending',
      result:      undefined,
      error:       undefined,
      startedAt:   undefined,
      completedAt: undefined,
      failedAt:    undefined,
    };

    this.emit('job:added', job);

    if (job.delay > 0) {
      job.status = 'delayed';
      // Keep the job visible in #jobs immediately so getJob() works
      this.#jobs.push(job);
      setTimeout(() => {
        job.status = 'delayed->pending'; // transient sentinel
        job.delay  = 0;
        this.#jobs.splice(this.#jobs.indexOf(job), 1);
        job.status = 'pending';
        this.#insertJob(job);
        this.#fillSlots();
      }, job.delay);
    } else {
      this.#insertJob(job);
      this.#fillSlots();
    }

    return job.id;
  }

  pause() {
    this.#paused = true;
    this.emit('queue:paused');
    return this;
  }

  resume() {
    this.#paused = false;
    this.emit('queue:resumed');
    this.#fillSlots(); // fill ALL available concurrency slots, not just one
    return this;
  }

  getJob(jobId) {
    return this.#jobs.find(j => j.id === jobId) ?? null;
  }

  getJobs(status) {
    return status
      ? this.#jobs.filter(j => j.status === status)
      : [...this.#jobs];
  }

  getStats() {
    return {
      ...this.#stats,
      pending:    this.#jobs.filter(j => j.status === 'pending').length,
      processing: this.#running,
      delayed:    this.#jobs.filter(j => j.status === 'delayed').length,
      total:      this.#jobs.length,
    };
  }

  clear() {
    this.#jobs = [];
    this.emit('queue:cleared');
    return this;
  }

  // --- Internals ------------------------------------------------------------

  /**
   * Insert a job maintaining descending priority order.
   * Jobs with equal priority are appended (FIFO within same priority).
   */
  #insertJob(job) {
    const idx = this.#jobs.findIndex(j => j.status !== 'delayed' && job.priority > j.priority);
    if (idx === -1) {
      this.#jobs.push(job);
    } else {
      this.#jobs.splice(idx, 0, job);
    }
  }

  /**
   * Fill all available concurrency slots.
   * Calling this multiple times is safe ? each call dequeues at most one job
   * per available slot.
   */
  #fillSlots() {
    while (!this.#paused && this.#running < this.#concurrency) {
      // Atomically claim the next pending job to avoid double-processing
      const job = this.#jobs.find(j => j.status === 'pending');
      if (!job) break;
      job.status = 'processing'; // claim immediately, before any await
      this.#running++;
      this.emit('job:start', job);
      this.#executeJob(job).finally(() => {
        this.#running--;
        this.#fillSlots(); // re-check after this slot frees up
        if (this.#running === 0 && !this.#jobs.some(j => j.status === 'pending' || j.status === 'delayed')) {
          this.emit('queue:drain');
        }
      });
    }
  }

  /**
   * Execute a single job with timeout and retry logic.
   */
  async #executeJob(job) {
    const handler = this.#handlers.get(job.type);

    if (!handler) {
      const err = new Error(`No handler registered for job type: ${job.type}`);
      job.status  = 'failed';
      job.error   = err.message;
      job.failedAt = Date.now();
      this.#stats.failed++;
      this.emit('job:failed', job, err);
      this.#removeJob(job.id);
      return;
    }

    job.attempts++;
    job.startedAt = Date.now();

    try {
      // Create a timeout that cleans up after itself
      let timeoutHandle;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Job timed out after ${job.timeout}ms`)),
          job.timeout
        );
      });

      const result = await Promise.race([
        Promise.resolve(handler(job.data, job)).finally(() => clearTimeout(timeoutHandle)),
        timeoutPromise,
      ]);

      job.status      = 'completed';
      job.result      = result;
      job.completedAt = Date.now();
      this.#stats.completed++;
      this.emit('job:completed', job, result);
      this.#removeJob(job.id);

    } catch (error) {
      job.error = error.message;

      if (job.attempts < job.maxAttempts) {
        // Exponential backoff: 1x, 2x, 4x, ? of retryDelay
        const backoff = this.#retryDelay * 2 ** (job.attempts - 1);
        job.status = 'pending';
        this.#stats.retried++;
        this.emit('job:retry', job, error);

        // Re-insert with correct priority after backoff.
        // Remove first so #insertJob doesn't find a duplicate.
        this.#removeJob(job.id);
        setTimeout(() => {
          this.#insertJob(job);
          this.#fillSlots();
        }, backoff);

      } else {
        job.status   = 'failed';
        job.failedAt = Date.now();
        this.#stats.failed++;
        this.emit('job:failed', job, error);
        this.#removeJob(job.id);
      }
    }
  }

  /**
   * Remove job from queue
   */
  #removeJob(jobId) {
    const idx = this.#jobs.findIndex(j => j.id === jobId);
    if (idx !== -1) this.#jobs.splice(idx, 1);
  }

  /**
   * Generate unique job ID
   */
  #generateId() {
    // crypto.randomUUID() is available in Node 14.17+ / Node 24
    return `${Date.now()}-${crypto.randomUUID().split('-')[0]}`;
  }
}

// --- Example usage -----------------------------------------------------------

if (require.main === module) {
  const queue = new JobQueue({
    concurrency: 2,   // run 2 jobs in parallel
    retryDelay:  100,
  });

  queue.on('job:added',     (job)         => console.log(`[+] Added     ${job.id} (${job.type})`));
  queue.on('job:start',     (job)         => console.log(`[>] Start     ${job.id} attempt ${job.attempts}`));
  queue.on('job:completed', (job, result) => console.log(`[?] Done      ${job.id} ? ${result}`));
  queue.on('job:retry',     (job, err)    => console.log(`[?] Retry     ${job.id} (${err.message})`));
  queue.on('job:failed',    (job, err)    => console.log(`[?] Failed    ${job.id} ? ${err.message}`));
  queue.on('queue:drain',   ()            => console.log('\n[=] Queue drained.\n', queue.getStats()));

  queue.process('email', async (data) => {
    await new Promise(r => setTimeout(r, 80));
    return `Email sent to ${data.to}`;
  });

  queue.process('report', async (data) => {
    await new Promise(r => setTimeout(r, 150));
    if (Math.random() > 0.7) throw new Error('Report generation failed');
    return `Report ${data.name} generated`;
  });

  queue.process('backup', async (data) => {
    await new Promise(r => setTimeout(r, 80));
    return `Backup of ${data.database} completed`;
  });

  queue.add('email',  { to: 'user@example.com'  }, { priority: 2 });
  queue.add('report', { name: 'Q4-2024'          }, { priority: 1, maxAttempts: 5 });
  queue.add('backup', { database: 'production'   }, { priority: 1 });
  queue.add('email',  { to: 'admin@example.com'  }, { priority: 2 });
  queue.add('report', { name: 'Monthly-Stats'    }, { priority: 1, maxAttempts: 3 });
  queue.add('email',  { to: 'delayed@example.com'}, { delay: 500, priority: 3 });
}

module.exports = JobQueue;
