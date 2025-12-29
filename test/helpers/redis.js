'use strict';

const Redis = require('ioredis');
const appConfig = require('../../config');

/**
 * Create a test Redis client
 * @returns {Redis} Redis instance
 */
function createTestRedis() {
    return new Redis({
        host: process.env.TEST_REDIS_HOST || 'localhost',
        port: parseInt(process.env.TEST_REDIS_PORT || '6379'),
        family: 4,
        password: process.env.TEST_REDIS_PASS || undefined,
        db: parseInt(process.env.TEST_REDIS_DB || '15')
    });
}

/**
 * Clean up test Redis database
 * @returns {Promise<void>}
 */
async function cleanupTestRedis() {
    const redis = createTestRedis();
    const keys = await redis.keys('test_ip_lists:*');
    if (keys.length > 0) {
        await redis.del(...keys);
    }
    await redis.quit();
}

/**
 * Flush test database
 * @returns {Promise<void>}
 */
async function flushTestRedis() {
    const redis = createTestRedis();
    await redis.flushdb();
    await redis.quit();
}

module.exports = {
    createTestRedis,
    cleanupTestRedis,
    flushTestRedis
};

