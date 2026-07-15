'use strict';

/**
 * tanitadc13c EP8280 - main entry point
 *
 * Usage:
 *   node main.js
 *
 */

const { loadConfig }  = require('../lib/config');
const Logger          = require('../lib/logger');
const JobQueue        = require('../lib/queue');
const { TanitaDC13C } = require('./tanitadc13c');
const fs = require('fs');

const zeromq = require('zeromq');
const dealer = new zeromq.Dealer();

process.title = 'tanitadc13cjs';

async function main() {

  // - 1. Load config ----
  let config;
  let tempFile = { inputData: {}, outputData: {}, messages: [] };
  try { config = loadConfig(process.argv || 'config.json'); }
  catch (err) { process.stderr.write(`[FATAL] ${err.message}\n`); process.exit(1); }

  // - 2. Logger ----
  const logger = new Logger({ 
                  logDir: config.log.logDir,
                  logName: config.log.logName, 
                  level: config.log.level ,
                  rotate: config.log.rotate,
                  maxBytes: config.log.maxBytes,
                  maxFiles: config.log.maxFiles,
                  console: config.log.console });
  logger.info('TANITA DC13C driver starting...');

  // Queue definition
  const queue = new JobQueue({ concurrency: 1, retryDelay:0, timeout: 1 });

  // Listen to events
  queue.on('job:added', (job) => {
  logger.debug(`a Job added: ${job.id} (${job.type})`);
  });
  queue.on('job:start', (job) => {
  logger.debug(`p Processing: ${job.id} (attempt ${job.attempts})`);
  });
  queue.on('job:completed', (job, result) => {
  logger.debug(`c Completed: ${job.id} - Result: ${result}`);
  });
  queue.on('job:failed', (job, error) => {
  logger.debug(`x Failed: ${job.id} - ${error.message}`);
  });
  queue.on('job:retry', (job) => {
  logger.debug(`r Retrying: ${job.id} (attempt ${job.attempts})`);
  });
  queue.process('zeromqSendMessage', 
    // Your async work here
    async (data) => {
      await new Promise((resolve, reject) => {
        // Call the async operation and resolve/reject when it finishes
        dealer.send(data.message)
          .then(() => { // success -> resolve the outer promise
            logger.debug( ` < Sent message ${data.message}`)
            return resolve();
          })        
          .catch(reject);         // error   -> reject  the outer promise
      });
      return `Sent message ${data.message}`;
    }
  );
  // end queue definitions

  // - 2. Open tanitadc13c ----
  
  const tanitadc13c = new TanitaDC13C ( config.port.path, config.port.baudRate, config.timeoutStepOn, config.timeout, config.polling, logger, emitMessage, tempFile )
  try { await tanitadc13c.open(); }
  catch (err) {
    logger.error(`Cannot open reader: ${err.message}`);
    logger.close();
    process.exit(1);
  }
  
  // send first command (S?) check status
  try { await tanitadc13c.checkStatus(); }
  catch (err) {
    logger.error(`Cannot check status: ${err.message}`);
    logger.close();
    process.exit(1);
  }
  const endpoint = "tcp://" + config.socket.zeromqIp + ":" + config.socket.zeromqPort;

  // dealer zeroMq listener msg from POD
  async function listenZmq() {
    for await (const [msg] of dealer) {
      try {
        const message = JSON.parse(msg.toString());

        logger.info(` > zmq received: ${message.inputData.cmd}`);

        if (!message.inputData || !message.inputData.cmd) return;

        switch (message.inputData.cmd) {
          case "measureStart":
            logger.debug(`inputData: ${message.inputData}`)
            await tanitadc13c.measureStart(message.inputData);
            break;
          case "measureBW":
            await tanitadc13c.measureBW();
            break;
          case "measureBI":
            await tanitadc13c.measureBI();
            break;
          case "measureStop":
            await tanitadc13c.measureStop();
            break;
          case "reset":
            await tanitadc13c.resetMachine();
            break;
          default:
            emitMessage({outputData: { error: `Missing or invalid command: ${message.inputData.cmd}` }});
            break;
        }
      } catch (error) {
        logger.error(` > zmq error: ${error.message}`);
        emitMessage({ outputData:{
          message:"error",
          errorCode: error.cause
        }})
      }
    }
  }

  // dealer zeroMq bind
  async function initZmq() {
    try {
      await dealer.bind(endpoint);
      logger.info(`ZeroMQ bind on endpoint: ${endpoint}`);
      listenZmq(); 
    } catch (error) {
      logger.error(`ZeroMQ socket problem: ${error}`);
    }
  }

  initZmq();

  /**
   * emitMessage
   * @param {*} payload 
   * sends payload to: 
   * 1) Electron (via registered callback) - for the gauge
   * 2) POD (via zeroMq queue)
   * output flow unified
   */
  function emitMessage(payload) {  
    zeromqSendMessage(JSON.stringify(payload));
    logger.info(` < zmq sent: ${JSON.stringify(payload)}`);
  }

  /**
   * zeromqSendMessage
   * @param {*} msg 
   */
  function zeromqSendMessage(msg) {  
    // Add jobs
    queue.add('zeromqSendMessage', { message: msg } );
  }

  // - Graceful shutdown ----
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`Received ${signal} ? shutting down...`);
    try { await tanitadc13c.close(); } catch (_) {}
    logger.close();
    process.exit(signal === 'error' ? 1 : 0);
  }
  process.on('SIGINT',           () => shutdown('SIGINT'));
  process.on('SIGTERM',          () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => { logger.error(err.stack); shutdown('error'); });
}

main();
