'use strict';

const pino = require('pino');

/**
 * Creates and configures a Pino logger instance
 * @param {Object} options - Logger configuration options
 * @param {string} options.level - Log level (default: 'info')
 * @param {boolean} options.pretty - Enable pretty printing for development (default: false)
 * @returns {pino.Logger} Configured Pino logger instance
 */
function createLogger(options = {}) {
    const {
        level = process.env.LOG_LEVEL || 'info',
        pretty = process.env.NODE_ENV === 'development' || process.env.LOG_PRETTY === 'true'
    } = options;

    const loggerOptions = {
        level,
        formatters: {
            level: (label) => {
                return { level: label };
            }
        },
        timestamp: pino.stdTimeFunctions.isoTime
    };

    if (pretty) {
        return pino({
            ...loggerOptions,
            transport: {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'HH:MM:ss Z',
                    ignore: 'pid,hostname'
                }
            }
        });
    }

    return pino(loggerOptions);
}

// Create default logger instance
const logger = createLogger();

module.exports = logger;
module.exports.createLogger = createLogger;

