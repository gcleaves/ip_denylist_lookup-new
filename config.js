'use strict';

require('dotenv').config();
const Joi = require('joi');

/**
 * Environment variable validation schema
 */
const envSchema = Joi.object({
    // Redis configuration
    REDIS_HOST: Joi.string().default('localhost'),
    REDIS_PORT: Joi.number().port().default(6379),
    REDIS_IP_FAMILY: Joi.number().valid(4, 6).default(4),
    REDIS_PASS: Joi.string().allow('').default(''),
    REDIS_DB: Joi.number().min(0).default(0),

    // Application configuration
    IP_REDIS_PREFIX: Joi.string().default('ip_lists:'),
    IP_DOWNLOAD_LOCATION: Joi.string().default('./ipFile'),
    IP_COLLECT_GARBAGE: Joi.string().valid('true', 'false', '').default(''),
    IP_HTTP_PORT: Joi.number().port().default(3000),
    IP_PREFIX: Joi.string().default('/'),
    IP_CRON: Joi.string().default('5 2 * * *'),
    IP_CRON_TIMEZONE: Joi.string().default('UTC'),

    // Logging configuration
    LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').default('info'),
    LOG_PRETTY: Joi.string().valid('true', 'false', '').default(''),
    NODE_ENV: Joi.string().valid('development', 'production', 'test').default('production'),

    // Rate limiting configuration
    RATE_LIMIT_WINDOW_MS: Joi.number().min(1000).default(60000), // 1 minute
    RATE_LIMIT_MAX_REQUESTS: Joi.number().min(1).default(1000),
    RATE_LIMIT_WS_MAX_MESSAGES: Joi.number().min(1).default(5000),

    // WebSocket configuration
    WS_ENABLED: Joi.string().valid('true', 'false', '').default('true'),

    // Health check configuration
    HEALTH_CHECK_ENABLED: Joi.string().valid('true', 'false', '').default('true')
}).unknown();

/**
 * Validates and returns configuration object
 * @returns {Object} Validated configuration
 */
function loadConfig() {
    const { error, value } = envSchema.validate(process.env, {
        abortEarly: false,
        stripUnknown: true
    });

    if (error) {
        const errorMessages = error.details.map(detail => detail.message).join(', ');
        throw new Error(`Configuration validation error: ${errorMessages}`);
    }

    // Convert string booleans to actual booleans
    const config = {
        redis: {
            host: value.REDIS_HOST,
            port: value.REDIS_PORT,
            family: value.REDIS_IP_FAMILY,
            password: value.REDIS_PASS || undefined,
            db: value.REDIS_DB
        },
        app: {
            redisPrefix: value.IP_REDIS_PREFIX,
            downloadLocation: value.IP_DOWNLOAD_LOCATION,
            collectGarbage: value.IP_COLLECT_GARBAGE === 'true',
            httpPort: value.IP_HTTP_PORT,
            prefix: value.IP_PREFIX,
            cron: value.IP_CRON,
            cronTimezone: value.IP_CRON_TIMEZONE
        },
        logging: {
            level: value.LOG_LEVEL,
            pretty: value.LOG_PRETTY === 'true' || value.NODE_ENV === 'development'
        },
        rateLimit: {
            windowMs: value.RATE_LIMIT_WINDOW_MS,
            maxRequests: value.RATE_LIMIT_MAX_REQUESTS,
            wsMaxMessages: value.RATE_LIMIT_WS_MAX_MESSAGES
        },
        websocket: {
            enabled: value.WS_ENABLED !== 'false'
        },
        healthCheck: {
            enabled: value.HEALTH_CHECK_ENABLED !== 'false'
        }
    };

    return config;
}

module.exports = loadConfig();

