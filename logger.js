'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

const COLORS = {
  DEBUG : '\x1b[36m',
  INFO  : '\x1b[32m',
  WARN  : '\x1b[33m',
  ERROR : '\x1b[31m',
  RESET : '\x1b[0m',
};

// How often to check for date-based rotation (ms).
const ROTATION_CHECK_INTERVAL_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a compact local date string: "2025-04-08" */
function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Serialize any value to a loggable string. */
function serialize(msg) {
  if (msg instanceof Error)  return `${msg.message}\n${msg.stack}`;
  if (typeof msg === 'object' && msg !== null) {
    try { return JSON.stringify(msg); } catch { return String(msg); }
  }
  return String(msg);
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * A persistent, rotation-aware logger for long-running Node.js services.
 *
 * Options
 * -------
 * @param {object}  opts
 * @param {string}  [opts.logDir='./logs']       Directory that holds log files.
 * @param {string}  [opts.logName='app']         Base name: logName.log, logName.log.1 ...
 * @param {string}  [opts.level='INFO']          Minimum level to emit (DEBUG|INFO|WARN|ERROR).
 * @param {boolean} [opts.console=true]          Mirror output to stdout with ANSI colours.
 * @param {'daily'|'size'|'none'} [opts.rotate='daily']
 *   Rotation strategy:
 *     'daily' - rotate once per calendar day (checked every minute).
 *     'size'  - rotate when the file exceeds opts.maxBytes.
 *     'none'  - never rotate; just keep appending.
 * @param {number}  [opts.maxBytes=10_485_760]   Rotation threshold for 'size' mode (10 MiB).
 * @param {number}  [opts.maxFiles=7]            How many rotated archives to keep (.log.1 ... .log.N).
 * @param {boolean} [opts.registerShutdown=true] Auto-close on SIGINT / SIGTERM.
 */
class Logger {
  constructor(opts = {}) {
    this.minLevel  = LEVELS[String(opts.level || 'INFO').toUpperCase()] ?? LEVELS.INFO;
    this.toConsole = opts.console !== false;
    this.logDir    = opts.logDir  || './logs';
    this.logName   = opts.logName || 'app';
    this.rotate    = opts.rotate  ?? 'daily';
    this.maxBytes  = opts.maxBytes ?? 10 * 1024 * 1024; // 10 MiB
    this.maxFiles  = Math.max(1, opts.maxFiles ?? 7);

    this._stream       = null;
    this._closed       = false;
    this._currentDate  = dateStamp();
    this._rotateTimer  = null;
    this._pendingWrite = Promise.resolve(); // simple async-safe write queue

    this._ensureDir();
    this._openStream();
    this._writeBanner('START');

    if (opts.registerShutdown !== false) this._registerShutdown();
    if (this.rotate === 'daily') this._startRotationTimer();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  debug(msg) { this._enqueue('DEBUG', msg); }
  info (msg) { this._enqueue('INFO',  msg); }
  warn (msg) { this._enqueue('WARN',  msg); }
  error(msg) { this._enqueue('ERROR', msg); }

  /**
   * Flush pending writes, write a shutdown banner, then close the file stream.
   * Safe to call multiple times.
   */
  close() {
    if (this._closed) return Promise.resolve();
    this._closed = true;

    if (this._rotateTimer) { clearInterval(this._rotateTimer); this._rotateTimer = null; }

    // Drain the queue, then close.
    this._pendingWrite = this._pendingWrite.then(() => {
      this._writeDirect('INFO', '--- logger closed ---');
      return new Promise(resolve => {
        if (this._stream) {
          this._stream.end(resolve);
          this._stream = null;
        } else {
          resolve();
        }
      });
    });

    return this._pendingWrite;
  }

  // -------------------------------------------------------------------------
  // Internal - stream management
  // -------------------------------------------------------------------------

  _ensureDir() {
    try {
      if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
    } catch (e) {
      process.stderr.write(`[Logger] Cannot create log dir: ${e.message}\n`);
    }
  }

  /** Full path of the active (current) log file. */
  _logPath() {
    return path.join(this.logDir, `${this.logName}.log`);
  }

  /** Path of the N-th rotated archive (1-based). */
  _archivePath(n) {
    return path.join(this.logDir, `${this.logName}.log.${n}`);
  }

  _openStream() {
    try {
      this._stream = fs.createWriteStream(this._logPath(), { flags: 'a' });
      this._stream.on('error', e => {
        process.stderr.write(`[Logger] Stream error: ${e.message}\n`);
      });
    } catch (e) {
      process.stderr.write(`[Logger] Cannot open log file: ${e.message}\n`);
    }
  }

  // -------------------------------------------------------------------------
  // Internal - rotation
  // -------------------------------------------------------------------------

  /**
   * Perform a Unix-style rotation:
   *   app.log.7 -> deleted
   *   app.log.6 -> app.log.7
   *   ...
   *   app.log.1 -> app.log.2
   *   app.log   -> app.log.1
   *   (new)     -> app.log
   */
  _rotateNow() {
    // Close current stream before renaming the underlying file.
    if (this._stream) {
      try { this._stream.end(); } catch (_) {}
      this._stream = null;
    }

    try {
      // Delete the oldest archive if it exists.
      const oldest = this._archivePath(this.maxFiles);
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

      // Shift existing archives: N-1 -> N ... 1 -> 2
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const from = this._archivePath(i);
        if (fs.existsSync(from)) fs.renameSync(from, this._archivePath(i + 1));
      }

      // Rename active log -> .1
      const active = this._logPath();
      if (fs.existsSync(active)) fs.renameSync(active, this._archivePath(1));

    } catch (e) {
      process.stderr.write(`[Logger] Rotation failed: ${e.message}\n`);
    }

    // Open a fresh stream for the new active file.
    this._openStream();
    this._writeBanner('ROTATE');
    this._currentDate = dateStamp();
  }

  /** Called every minute; triggers rotation if the calendar day has changed. */
  _startRotationTimer() {
    this._rotateTimer = setInterval(() => {
      if (dateStamp() !== this._currentDate) this._rotateNow();
    }, ROTATION_CHECK_INTERVAL_MS);

    // Don't keep the event loop alive just for the logger.
    if (this._rotateTimer.unref) this._rotateTimer.unref();
  }

  // -------------------------------------------------------------------------
  // Internal - writing
  // -------------------------------------------------------------------------

  _enqueue(level, rawMsg) {
    if (this._closed) return;
    this._pendingWrite = this._pendingWrite.then(() => this._flushOne(level, rawMsg));
  }

  async _flushOne(level, rawMsg) {
    if (LEVELS[level] < this.minLevel) return;

    // Size-based rotation check (sync stat is cheap and called infrequently).
    if (this.rotate === 'size') {
      try {
        const { size } = fs.statSync(this._logPath());
        if (size >= this.maxBytes) this._rotateNow();
      } catch (_) {}
    }

    this._writeDirect(level, serialize(rawMsg));
  }

  /** Low-level: formats and emits one line synchronously for ordering guarantees. */
  _writeDirect(level, text) {
    const ts   = new Date().toISOString();
    const line = `[${ts}] [${level.padEnd(5)}] ${text}`;

    if (this.toConsole && COLORS[level]) {
      process.stdout.write(`${COLORS[level]}${line}${COLORS.RESET}\n`);
    } else if (this.toConsole) {
      process.stdout.write(`${line}\n`);
    }

    if (this._stream && !this._stream.destroyed) {
      this._stream.write(line + '\n');
    }
  }

  _writeBanner(event) {
    const banner = `${'-'.repeat(20)} ${event} pid=${process.pid} ${'-'.repeat(20)}`;
    this._writeDirect('INFO', banner);
  }

  // -------------------------------------------------------------------------
  // Internal - graceful shutdown
  // -------------------------------------------------------------------------

  _registerShutdown() {
    const onSignal = (sig) => {
      this._writeDirect('INFO', `Received ${sig}, shutting down logger?`);
      this.close();
      // Give the stream a tick to drain before the process exits.
      this._pendingWrite.finally(() => process.exit(0));
    };

    // Avoid stacking duplicate listeners if multiple Logger instances are created.
    if (!Logger._shutdownRegistered) {
      Logger._shutdownRegistered = true;
      process.once('SIGINT',  () => onSignal('SIGINT'));
      process.once('SIGTERM', () => onSignal('SIGTERM'));
    }
  }
}

// Class-level flag so multiple Logger instances share one set of signal handlers.
Logger._shutdownRegistered = false;

module.exports = Logger;
