'use strict';

const Redis = require('ioredis');
const appConfig = require('./config');
const logger = require('./logger').child({ module: 'updateLock' });

let redis = null;

/**
 * Get Redis connection for locking
 * @returns {Redis} Redis instance
 */
function getRedis() {
    if (!redis) {
        redis = new Redis({
            host: appConfig.redis.host,
            port: appConfig.redis.port,
            family: appConfig.redis.family,
            password: appConfig.redis.password,
            db: appConfig.redis.db,
            maxRetriesPerRequest: 1,
            retryStrategy: () => null, // Don't retry on lock operations
            lazyConnect: false
        });
    }
    return redis;
}

/**
 * Close Redis connection (for testing)
 */
function closeRedis() {
    if (redis) {
        try {
            redis.removeAllListeners();
            redis.disconnect(false);
        } catch (e) {
            // Ignore errors
        }
        redis = null;
    }
}

/**
 * Acquire distributed lock for update process
 * @param {string} lockKey - Lock key
 * @param {number} ttlSeconds - Lock TTL in seconds
 * @returns {Promise<boolean>} True if lock acquired
 */
async function acquireLock(lockKey, ttlSeconds = 3600) {
    try {
        const client = getRedis();
        
        // Check if lock exists and if it's stale
        const existingLock = await client.get(lockKey);
        if (existingLock) {
            const isStale = await isLockStale(lockKey);
            if (isStale) {
                logger.warn({ lockKey, existingLock }, 'Found stale lock from dead process, cleaning up');
                await client.del(lockKey);
                // Continue to acquire lock below
            } else {
                logger.warn({ lockKey, existingLock }, 'Update lock already held by another process');
                return false;
            }
        }
        
        // Try to acquire lock
        const lockValue = `${process.pid}-${Date.now()}`;
        const result = await client.set(lockKey, lockValue, 'EX', ttlSeconds, 'NX');
        
        if (result === 'OK') {
            logger.info({ lockKey, ttlSeconds }, 'Update lock acquired');
            return true;
        }
        
        return false;
    } catch (error) {
        logger.error({ error: error.message, lockKey }, 'Error acquiring lock');
        throw error;
    }
}

/**
 * Release distributed lock
 * @param {string} lockKey - Lock key
 * @param {string} lockValue - Lock value (must match to release)
 * @returns {Promise<boolean>} True if lock released
 */
async function releaseLock(lockKey, lockValue) {
    try {
        if (!lockValue) {
            logger.warn({ lockKey }, 'Cannot release lock: lock value is null or undefined');
            return false;
        }
        
        const client = getRedis();
        // Trim lock value to handle any whitespace issues
        const trimmedLockValue = String(lockValue).trim();
        
        // Use Lua script to atomically check and delete
        const script = `
            local current = redis.call("get", KEYS[1])
            if current == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
        `;
        const result = await client.eval(script, 1, lockKey, trimmedLockValue);
        
        if (result === 1) {
            logger.info({ lockKey }, 'Update lock released');
            return true;
        }
        
        // Get current lock value for debugging
        const currentLockValue = await client.get(lockKey);
        logger.warn({ 
            lockKey, 
            expected: trimmedLockValue, 
            actual: currentLockValue 
        }, 'Lock value mismatch or lock expired');
        return false;
    } catch (error) {
        logger.error({ error: error.message, lockKey }, 'Error releasing lock');
        return false;
    }
}

/**
 * Get current lock value
 * @param {string} lockKey - Lock key
 * @returns {Promise<string|null>} Lock value or null
 */
async function getLockValue(lockKey) {
    try {
        const client = getRedis();
        const value = await client.get(lockKey);
        // Return trimmed value to avoid whitespace issues
        return value ? String(value).trim() : null;
    } catch (error) {
        logger.error({ error: error.message, lockKey }, 'Error getting lock value');
        return null;
    }
}

/**
 * Check if a process is still running
 * @param {number} pid - Process ID
 * @returns {boolean} True if process is running
 */
function isProcessRunning(pid) {
    try {
        // On Unix-like systems, sending signal 0 checks if process exists
        process.kill(pid, 0);
        return true;
    } catch (e) {
        // ESRCH = no such process
        return e.code !== 'ESRCH';
    }
}

/**
 * Check if lock is stale (held by a dead process)
 * @param {string} lockKey - Lock key
 * @returns {Promise<boolean>} True if lock is stale
 */
async function isLockStale(lockKey) {
    try {
        const client = getRedis();
        const lockValue = await client.get(lockKey);
        if (!lockValue) {
            return false; // No lock, so not stale
        }
        
        // Lock value format: "PID-timestamp"
        const parts = String(lockValue).trim().split('-');
        if (parts.length < 1) {
            return false; // Invalid format, assume not stale
        }
        
        const pid = parseInt(parts[0], 10);
        if (isNaN(pid)) {
            return false; // Invalid PID, assume not stale
        }
        
        // Check if process is still running
        // If it's the current process, it's not stale
        if (pid === process.pid) {
            return false;
        }
        
        return !isProcessRunning(pid);
    } catch (error) {
        logger.error({ error: error.message, lockKey }, 'Error checking if lock is stale');
        return false; // On error, assume not stale to be safe
    }
}

/**
 * Check if lock exists
 * @param {string} lockKey - Lock key
 * @returns {Promise<boolean>} True if lock exists
 */
async function isLocked(lockKey) {
    try {
        const client = getRedis();
        // Use GET instead of EXISTS to ensure we can actually read the value
        const value = await client.get(lockKey);
        return value !== null && value !== undefined;
    } catch (error) {
        logger.error({ error: error.message, lockKey }, 'Error checking lock');
        return false;
    }
}

/**
 * Clean up stale lock (held by dead process)
 * @param {string} lockKey - Lock key
 * @returns {Promise<boolean>} True if stale lock was cleaned up
 */
async function cleanupStaleLock(lockKey) {
    try {
        const isStale = await isLockStale(lockKey);
        if (!isStale) {
            return false;
        }
        
        const client = getRedis();
        await client.del(lockKey);
        logger.warn({ lockKey }, 'Cleaned up stale lock from dead process');
        return true;
    } catch (error) {
        logger.error({ error: error.message, lockKey }, 'Error cleaning up stale lock');
        return false;
    }
}

/**
 * Extend lock TTL
 * @param {string} lockKey - Lock key
 * @param {string} lockValue - Lock value
 * @param {number} ttlSeconds - New TTL in seconds
 * @returns {Promise<boolean>} True if lock extended
 */
async function extendLock(lockKey, lockValue, ttlSeconds) {
    try {
        const client = getRedis();
        const script = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("expire", KEYS[1], ARGV[2])
            else
                return 0
            end
        `;
        const result = await client.eval(script, 1, lockKey, lockValue, ttlSeconds);
        return result === 1;
    } catch (error) {
        logger.error({ error: error.message, lockKey }, 'Error extending lock');
        return false;
    }
}

module.exports = {
    acquireLock,
    releaseLock,
    getLockValue,
    isLocked,
    isLockStale,
    cleanupStaleLock,
    extendLock,
    closeRedis // Export for testing
};

