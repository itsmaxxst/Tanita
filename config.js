'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Load and validate session.config.json.
 * Pass process.argv ? honours --config <path> flag.
 */
function loadConfig(argv) {
  const flagIdx = argv.indexOf('--config');
  let cfgPath   = (flagIdx !== -1 && argv[flagIdx + 1])
    ? argv[flagIdx + 1]
    : path.join(process.cwd(), 'config.json');

  cfgPath = path.resolve(cfgPath);
  if (!fs.existsSync(cfgPath)) throw new Error('Config file not found: ' + cfgPath);

  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { throw new Error('Cannot parse config JSON: ' + e.message); }

  // Ensure all sections exist
  cfg.log
  cfg.port           = cfg.port           || {};
  cfg.output         = cfg.output         || {};

  // Defaults
  const defaults = {
    socket:   { zeromqIp: "127.0.0.1", zeromqPort: "9900"},
    manufacturer: "",
    port:     { baudRate: 9600, vid: '', pid: '', path: 'COM2' },
    timeout:  30000,
    log:   { logDir: 'C:\\log', console: false, logName: "default", level: "INFO"},
  };

  for (const section of Object.keys(defaults)) {
    for (const [key, val] of Object.entries(defaults[section])) {
      if (cfg[section][key] === undefined) cfg[section][key] = val;
    }
  }

  return cfg;
}

module.exports = { loadConfig };
