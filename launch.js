'use strict';

const fs = require('fs');
const { CronJob } = require('cron');
const { format } = require('date-fns');
const args = require('minimist')(process.argv.slice(2), {
    boolean: [
        'download',
        'load',
        'serve',
        'gc',
        'process'
    ],
    default: {
        download: true,
        load: true,
        serve: true,
        process: true,
        collectGarbage: false
    }
});

const appConfig = require('./config');
const logger = require('./logger');
const updateLock = require('./updateLock');
const redisPrefix = appConfig.app.redisPrefix;
const csvFile = appConfig.app.downloadLocation;
const tempCsvFile = csvFile + '.tmp';
const collectGarbage = appConfig.app.collectGarbage || args.collectGarbage;
const includePath = __dirname + '/staging';
const lockKey = redisPrefix + 'update_lock';
const statusKey = redisPrefix + 'update_status';

const Redis = require('ioredis');

/**
 * Get Redis connection for status updates
 * @returns {Redis} Redis instance
 */
function getStatusRedis() {
    return new Redis({
        host: appConfig.redis.host,
        port: appConfig.redis.port,
        family: appConfig.redis.family,
        password: appConfig.redis.password,
        db: appConfig.redis.db
    });
}

/**
 * Update status in Redis
 * @param {string} status - Status value
 * @param {Object} metadata - Additional metadata
 * @returns {Promise<void>}
 */
async function updateStatus(status, metadata = {}) {
    try {
        const redis = getStatusRedis();
        const statusData = {
            status,
            timestamp: new Date().toISOString(),
            pid: process.pid,
            ...metadata
        };
        await redis.set(statusKey, JSON.stringify(statusData));
        await redis.quit();
    } catch (error) {
        logger.warn({ error: error.message, status }, 'Failed to update status');
    }
}

/**
 * Validate CSV file before loading
 * @param {string} file - CSV file path
 * @returns {Promise<boolean>} True if valid
 */
async function validateCsvFile(file) {
    try {
        if (!fs.existsSync(file)) {
            logger.error({ file }, 'CSV file does not exist');
            return false;
        }

        const stats = fs.statSync(file);
        if (stats.size === 0) {
            logger.error({ file }, 'CSV file is empty');
            return false;
        }

        // Check minimum expected size (header line)
        if (stats.size < 20) {
            logger.error({ file, size: stats.size }, 'CSV file too small');
            return false;
        }

        // Read first few lines to validate format
        const readline = require('readline');
        const stream = fs.createReadStream(file, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream });
        
        let lineCount = 0;
        let headerFound = false;
        
        for await (const line of rl) {
            lineCount++;
            if (lineCount === 1) {
                // Check header
                if (line.includes('start_int') && line.includes('end_int') && line.includes('list')) {
                    headerFound = true;
                }
            } else if (lineCount <= 10) {
                // Validate a few data lines
                const parts = line.split('|');
                if (parts.length !== 3) {
                    logger.error({ file, line, lineCount }, 'Invalid CSV format');
                    rl.close();
                    return false;
                }
                // Check that first two parts are numbers
                if (isNaN(parseInt(parts[0])) || isNaN(parseInt(parts[1]))) {
                    logger.error({ file, line, lineCount }, 'Invalid numeric values in CSV');
                    rl.close();
                    return false;
                }
            } else {
                break; // Only check first 10 lines
            }
        }
        
        rl.close();
        
        if (!headerFound) {
            logger.error({ file }, 'CSV header not found');
            return false;
        }
        
        if (lineCount < 2) {
            logger.error({ file }, 'CSV file has no data rows');
            return false;
        }

        logger.info({ file, size: stats.size, lines: lineCount }, 'CSV file validation passed');
        return true;
    } catch (error) {
        logger.error({ error: error.message, file }, 'CSV validation error');
        return false;
    }
}

const concat = async (sourceFile, destination) => {
    logger.info({ sourceFile }, 'Concatenating file');
    return new Promise((resolve, reject) => {
        const source = fs.createReadStream(sourceFile);
        source.on('close', function() {
            logger.info({ sourceFile }, 'Finished writing file');
            resolve();
        });
        source.on('error', (err) => {
            logger.error({ error: err.message, sourceFile }, 'Error reading file');
            reject(err);
        });
        source.pipe(destination);
    });
};

async function main() {
    let lockValue = null;
    
    try {
        // Acquire distributed lock
        const acquired = await updateLock.acquireLock(lockKey, 3600); // 1 hour max
        if (!acquired) {
            const isLocked = await updateLock.isLocked(lockKey);
            if (isLocked) {
                logger.warn('Update already in progress, skipping');
                await updateStatus('skipped', { reason: 'Lock already held' });
                return 'skipped';
            }
            throw new Error('Failed to acquire update lock');
        }
        
        // Get lock value for later release
        lockValue = await updateLock.getLockValue(lockKey);

        await updateStatus('in_progress', { stage: 'starting' });

        // run plugins which stage IP lists
        if (args.download) {
            await updateStatus('in_progress', { stage: 'downloading' });
            const plugins = require('./plugins');
            
            // Add overall timeout for downloads (10 minutes)
            const downloadTimeout = setTimeout(() => {
                logger.error('Download timeout exceeded');
                throw new Error('Download timeout exceeded (10 minutes)');
            }, 600000);

            try {
                const results = await Promise.allSettled(plugins.map(p => p.load()));
                clearTimeout(downloadTimeout);
                
                let k = 0;
                for (const result of results) {
                    if (result.status === 'rejected' && plugins[k].abortOnFail === true) {
                        logger.error({ 
                            plugin: plugins[k].name, 
                            error: result.reason 
                        }, 'Plugin failed and abortOnFail is true');
                        throw new Error(`Abort: plugin [${plugins[k].name}] has been set to abort process on fail.`);
                    }
                    if (result.status === 'rejected') {
                        logger.warn({ 
                            plugin: plugins[k].name, 
                            error: result.reason 
                        }, 'Plugin failed but continuing');
                    }
                    k++;
                }
                logger.info({ results: results.map(r => ({ 
                    status: r.status, 
                    ...(r.status === 'rejected' && { reason: r.reason })
                })) }, 'Plugins done');
            } catch (error) {
                clearTimeout(downloadTimeout);
                throw error;
            }
        }

        if (args.process) {
            await updateStatus('in_progress', { stage: 'processing' });
            // Write to temp file first, then atomically rename
            fs.writeFileSync(tempCsvFile, "start_int|end_int|list\n");

            for (const file of fs.readdirSync(includePath)) {
                const theFile = `${includePath}/${file}`;
                if (file.match(/^\./)) {
                    logger.debug({ file: theFile }, 'Skipping hidden file');
                    continue;
                }
                const destination = fs.createWriteStream(tempCsvFile, { flags: 'a' });
                await concat(theFile, destination);
            }

            // Validate CSV before proceeding
            const isValid = await validateCsvFile(tempCsvFile);
            if (!isValid) {
                throw new Error('CSV validation failed');
            }

            // Atomically rename temp file to final file
            if (fs.existsSync(csvFile)) {
                fs.renameSync(csvFile, csvFile + '.backup');
            }
            fs.renameSync(tempCsvFile, csvFile);
            logger.info('CSV file updated atomically');
        }

        if (args.load) {
            await updateStatus('in_progress', { stage: 'loading' });
            const load = require('./loadToRedis').load;
            await load(csvFile, redisPrefix, collectGarbage);
            logger.info('Loading done');
        }

        await updateStatus('completed', { 
            timestamp: new Date().toISOString() 
        });
        
        // Release lock
        if (lockValue) {
            await updateLock.releaseLock(lockKey, lockValue);
        }

        return 'success';
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack }, 'Main function error');
        
        await updateStatus('failed', { 
            error: error.message,
            timestamp: new Date().toISOString()
        });

        // Release lock on error
        if (lockValue) {
            await updateLock.releaseLock(lockKey, lockValue);
        }

        // Clean up temp file on error
        if (fs.existsSync(tempCsvFile)) {
            try {
                fs.unlinkSync(tempCsvFile);
                logger.info('Cleaned up temp CSV file');
            } catch (cleanupError) {
                logger.warn({ error: cleanupError.message }, 'Failed to cleanup temp CSV file');
            }
        }

        throw error;
    }
}

if (args.serve) {
    try {
        const serve = require('./serve').serve;
        serve(appConfig.app.httpPort, redisPrefix, appConfig.app.prefix);
    } catch (error) {
        logger.error({ error: error.message, port: appConfig.app.httpPort }, 'Failed to start server');
        process.exit(1);
    }
}

// Modern cron syntax - CronJob constructor takes cronTime, onTick, onComplete, start, timezone, context, runOnInit
const job = new CronJob(
    appConfig.app.cron,
    async function() {
        logger.info('Cron job triggered');
        try {
            await main();
            logger.info('Cron job completed successfully');
        } catch (error) {
            logger.error({ error: error.message }, 'Cron job failed');
        }
    },
    null, // onComplete
    true, // start
    appConfig.app.cronTimezone // timezone (configurable via IP_CRON_TIMEZONE env var, default: UTC)
);

main().then(() => {
    if (args.serve) {
        logger.info({ port: appConfig.app.httpPort }, 'Ready to serve!');
    } else {
        logger.info('Update process completed. Server not started (--serve flag not set).');
    }
}).catch(e => {
    logger.error({ error: e.message, stack: e.stack }, 'Startup failed');
    process.exit(1);
});

