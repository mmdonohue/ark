// LoggerAdapter — wraps log4js. Same interface regardless of underlying logger.

const log4js = require('log4js');

class LoggerAdapter {
  constructor(config = {}) {
    this.logger = log4js.getLogger(config.category || 'packet');
  }

  async connect() {}

  info(msg, ...args)  { this.logger.info(msg, ...args); }
  debug(msg, ...args) { this.logger.debug(msg, ...args); }
  warn(msg, ...args)  { this.logger.warn(msg, ...args); }
  error(msg, ...args) { this.logger.error(msg, ...args); }

  // Structured event log
  event(name, data = {}) {
    this.logger.info(`[event:${name}]`, JSON.stringify(data));
  }
}

module.exports = LoggerAdapter;
