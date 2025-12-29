'use strict';

const csv = require('csv-parser');
const fs = require('fs');
const Redis = require("ioredis");
const { format } = require('date-fns');
const appConfig = require('./config');
const logger = require('./logger').child({ module: 'loadToRedis' });

/**
 * Force garbage collection if available
 */
function forceGC() {
    if (global.gc) {
        global.gc();
    } else {
        logger.warn('No GC hook! Start your program as `node --expose-gc file.js`.');
    }
}

/**
 * Convert IP address to integer
 * @param {string} ip - IP address string
 * @returns {number} IP as integer
 */
function ip2int(ip) {
    return ip.split('.').reduce(function(ipInt, octet) { return (ipInt<<8) + parseInt(octet, 10)}, 0) >>> 0;
}

/**
 * Load IP ranges from CSV file into Redis
 * @param {string} file - CSV file path
 * @param {string} redisPrefix - Redis key prefix
 * @param {boolean} gc - Enable garbage collection
 * @returns {Promise<void>}
 */
exports.load = (file, redisPrefix, gc) => {
    let k = 0;
    const scratch = [];
    
    return new Promise((resolve, reject) => {
        // Create optimized Redis connection
        const redis = new Redis({
            host: appConfig.redis.host,
            port: appConfig.redis.port,
            family: appConfig.redis.family,
            password: appConfig.redis.password,
            db: appConfig.redis.db,
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => {
                const delay = Math.min(times * 50, 2000);
                logger.warn({ times, delay }, 'Redis retry');
                return delay;
            },
            enableReadyCheck: true,
            enableOfflineQueue: true,
            lazyConnect: false
        });

        redis.on('error', (err) => {
            logger.error({ error: err.message }, 'Redis connection error');
            reject(err);
        });

        redis.on('connect', () => {
            logger.info('Redis connected for loading');
        });

        const tempKey = 'arfa45e13grh785gEV4wfw$WF7h';
        
        // Delete temp key if it exists
        redis.del(tempKey).catch(err => {
            logger.warn({ error: err.message }, 'Error deleting temp key (may not exist)');
        });

        const stream = fs.createReadStream(file);
        
        stream.on('error', (err) => {
            logger.error({ error: err.message, file }, 'File read error');
            redis.disconnect();
            reject(err);
        });

        stream
            .pipe(csv({
                separator: '|',
                quote: '~',
                mapValues: ({header, index, value}) => {
                    if (header === 'list') {
                        return value;
                    } else {
                        return parseInt(value);
                    }
                }
            }))
            .on('data', (r) => {
                k++;
                if (!(k % 10000)) {
                    logger.debug({ lines: k }, 'Reading CSV lines');
                }
                scratch.push({n: r.start_int, a: r.list, e: false});
                scratch.push({n: r.end_int, a: r.list, e: true});
            })
            .on('error', (err) => {
                logger.error({ error: err.message }, 'CSV parsing error');
                redis.disconnect();
                reject(err);
            })
            .on('end', async () => {
                try {
                    logger.info({ lines: k, scratchSize: scratch.length }, 'CSV file successfully processed');

                    // Store metadata
                    const lists = await redis.smembers(redisPrefix + 'lists');
                    await redis.lpush(redisPrefix + 'ipListSize', JSON.stringify({
                        date: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
                        size: k,
                        lists: lists
                    }));

                    logger.info('Sorting scratch array...');
                    scratch.sort((a, b) => {
                        if (a.n < b.n) return -1;
                        if (a.n > b.n) return 1;
                        if (a.e < b.e) return -1;
                        if (a.e > b.e) return 1;
                        return 0;
                    });
                    logger.info('Sorting finished');

                    let s = [];
                    let n;
                    let m;

                    let pipeline = redis.pipeline();
                    const batchSize = 100000;
                    
                    for (let k = 0; k < scratch.length - 1; k++) {
                        if (!(k % 10000)) {
                            logger.debug({ processed: k, total: scratch.length }, 'Flattening ranges');
                        }
                        
                        if (!(k % batchSize)) {
                            await pipeline.exec();
                            if (gc) {
                                forceGC();
                                logger.debug('Garbage collection triggered');
                            }
                            pipeline = redis.pipeline();
                        }
                        
                        const cur = scratch[k];
                        const nex = scratch[k + 1];
                        
                        if (cur.e === false) {
                            s.push(cur.a);
                        } else {
                            const index = s.indexOf(cur.a);
                            if (index > -1) s.splice(index, 1);
                        }
                        
                        if (cur.e === false) {
                            n = cur.n;
                        } else {
                            n = cur.n + 1;
                        }
                        
                        if (nex.e === false) {
                            m = nex.n - 1;
                        } else {
                            m = nex.n;
                        }

                        if (n <= m && s.length) {
                            s = [...new Set(s)];

                            const data = {};
                            for (const i of s) {
                                const j = JSON.parse(i);
                                const type = j.type;
                                delete j.type;
                                if (!data[type]) data[type] = [];
                                data[type].push(j);
                            }

                            pipeline.zadd(tempKey, m, `${n}|${m}|${JSON.stringify(data)}`);
                        }
                    }
                    
                    // Execute final pipeline
                    const pipelineResults = await pipeline.exec();
                    
                    // Check for pipeline errors
                    if (pipelineResults) {
                        const errors = pipelineResults.filter(r => r[0] !== null);
                        if (errors.length > 0) {
                            logger.error({ errors }, 'Pipeline execution errors');
                            throw new Error(`Pipeline errors: ${errors.length} commands failed`);
                        }
                    }
                    
                    // Check if temp key has data before renaming
                    const tempKeySize = await redis.zcard(tempKey);
                    if (tempKeySize === 0) {
                        logger.warn('Temp key is empty, aborting rename');
                        throw new Error('No data to load - temp key is empty');
                    }
                    
                    logger.info({ tempKeySize }, 'Temp key populated, proceeding with atomic rename');
                    
                    // Atomically rename temp key to final key
                    // This is atomic - either succeeds or fails, no partial state
                    await redis.rename(tempKey, redisPrefix + 'ranges');
                    
                    // Verify the rename succeeded
                    const finalKeySize = await redis.zcard(redisPrefix + 'ranges');
                    if (finalKeySize !== tempKeySize) {
                        logger.error({ tempKeySize, finalKeySize }, 'Key size mismatch after rename');
                        throw new Error('Key size mismatch after rename - possible corruption');
                    }
                    
                    // Clean up temp key (shouldn't exist after rename, but just in case)
                    await redis.del(tempKey).catch(() => {});

                    logger.info({ finalKeySize }, 'Loading to Redis completed successfully');
                    
                    await redis.quit();
                    resolve();
                } catch (error) {
                    logger.error({ error: error.message, stack: error.stack }, 'Error during Redis loading');
                    
                    // Clean up temp key on error to prevent leaving orphaned data
                    try {
                        const tempKeyExists = await redis.exists(tempKey);
                        if (tempKeyExists) {
                            await redis.del(tempKey);
                            logger.info('Cleaned up temp key after error');
                        }
                    } catch (cleanupError) {
                        logger.warn({ error: cleanupError.message }, 'Failed to cleanup temp key');
                    }
                    
                    await redis.quit().catch(() => {});
                    reject(error);
                }
            });
    });
};

