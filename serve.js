'use strict';

const ipTools = require('ip-utils');
const Redis = require("ioredis");
const appConfig = require("./config");
const logger = require('./logger');
const express = require('express');
const stringify = require('csv').stringify;
const fileUpload = require('express-fileupload');
const rateLimit = require('express-rate-limit');
const { createWebSocketServer } = require('./websocket');
const http = require('http');
const dns = require('dns').promises;

const app = express();
const router = express.Router();
const maxUpload = 10 * 1024 * 1024; // 10MB

// Redis connection pool
let redis = null;
let redisPrefix = null;
let serverInstance = null; // Track server instance to prevent multiple calls

/**
 * Initialize Redis connection pool
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
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => {
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
            enableReadyCheck: true,
            enableOfflineQueue: true
        });

        redis.on('error', (err) => {
            logger.error({ error: err.message }, 'Redis connection error');
        });

        redis.on('connect', () => {
            logger.info('Redis connected');
        });

        redis.on('ready', () => {
            logger.info('Redis ready');
        });

        redis.on('close', () => {
            logger.warn('Redis connection closed');
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
            // Remove all event listeners to prevent handles from staying open
            redis.removeAllListeners();
            // Disconnect immediately without waiting for pending commands
            redis.disconnect(false); // false = don't wait for pending commands
        } catch (e) {
            // Ignore errors during disconnect
        }
        redis = null;
    }
}

/**
 * Check if DroneBL lookup should be enabled based on query parameter
 * @param {Object} query - Request query object
 * @returns {boolean} True if DroneBL should be included
 */
function shouldIncludeDroneBL(query) {
    return [1, '1', true, 'true'].includes(query.dronebl);
}

/**
 * Lookup IP address in DroneBL via DNS
 * @param {string} ip - IP address to lookup
 * @returns {Promise<Object|null>} DroneBL result with type code, or null if not listed
 */
const lookupDroneBL = async (ip) => {
    if (!ipTools.isValidIpv4(ip)) {
        return null;
    }

    try {
        // Reverse the IP octets: 193.46.255.99 -> 99.255.46.193
        const parts = ip.split('.');
        const reversedIP = parts.reverse().join('.');
        const dnsblHostname = `${reversedIP}.dnsbl.dronebl.org`;

        // Query DNS A record
        const addresses = await dns.resolve4(dnsblHostname);
        
        if (addresses && addresses.length > 0) {
            // DroneBL returns an IP address where the last octet is the type code
            // Extract the type code from the first A record
            const typeIP = addresses[0];
            const typeParts = typeIP.split('.');
            const typeCode = parseInt(typeParts[typeParts.length - 1], 10);
            
            return {
                name: `dronebl_type_${typeCode}`,
                source: 'dronebl',
                type: typeCode
            };
        }
        
        return null;
    } catch (error) {
        // ENOTFOUND or ENODATA means IP is not listed (this is normal)
        if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') {
            return null;
        }
        // Log other DNS errors but don't fail the lookup
        logger.warn({ error: error.message, ip, code: error.code }, 'DroneBL DNS lookup error');
        return null;
    }
};

/**
 * Lookup IP address in Redis and optionally DroneBL
 * @param {string} ip - IP address to lookup
 * @param {boolean} includeDroneBL - Whether to include DroneBL DNS lookup (default: false)
 * @returns {Promise<Object|null|false>} Lookup result
 */
const lookupIP = async (ip, includeDroneBL = false) => {
    if (!ipTools.isValidIpv4(ip)) {
        return false;
    }

    try {
        const redisClient = getRedis();
        // Include DroneBL flag in cache key so cached results are separate
        const cacheKey = redisPrefix + 'cache:' + ip + (includeDroneBL ? ':dronebl' : '');
        const cacheTTL = 48 * 60 * 60; // 48 hours in seconds

        // Check cache first
        const cachedResult = await redisClient.get(cacheKey);
        if (cachedResult !== null) {
            // Cache hit - return immediately without Redis skip list or DNS lookup
            // Handle both null (not found) and result object
            if (cachedResult === 'null') {
                return null;
            }
            try {
                return JSON.parse(cachedResult);
            } catch (parseError) {
                // If cache value is corrupted, log and continue to fresh lookup
                logger.warn({ error: parseError.message, ip }, 'Failed to parse cached result, performing fresh lookup');
            }
        }

        // Cache miss - perform lookup
        const long = ipTools.toLong(ip);
        
        // Query Redis skip list and optionally DroneBL in parallel
        const queries = [
            redisClient.zrangebyscore(
                redisPrefix + 'ranges', 
                long, 
                '+inf', 
                'LIMIT', 
                0, 
                1
            )
        ];
        
        if (includeDroneBL) {
            queries.push(lookupDroneBL(ip));
        }
        
        const results = await Promise.all(queries);
        const answer = results[0];
        const droneblResult = includeDroneBL ? results[1] : null;

        let redisResult = null;
        if (answer && answer.length > 0) {
            const item = answer[0];
            const [startInt, endInt, lists] = item.split('|');
            if (long >= parseInt(startInt) && long <= parseInt(endInt)) {
                redisResult = JSON.parse(lists);
            }
        }

        // Merge results
        let result = null;
        if (redisResult === null && droneblResult === null) {
            result = null;
        } else {
            // Initialize result object
            result = redisResult || { list: [], geo: [] };
            
            // Ensure list array exists
            if (!result.list) {
                result.list = [];
            }

            // Add DroneBL result if found
            if (droneblResult) {
                result.list.push(droneblResult);
            }
        }

        // Store result in cache with 48-hour TTL
        // Store 'null' as string for null results, JSON stringify for objects
        const cacheValue = result === null ? 'null' : JSON.stringify(result);
        await redisClient.setex(cacheKey, cacheTTL, cacheValue).catch(err => {
            // Log cache write errors but don't fail the lookup
            logger.warn({ error: err.message, ip }, 'Failed to write to cache');
        });

        return result;
    } catch (error) {
        logger.error({ error: error.message, ip }, 'Lookup IP error');
        throw error;
    }
};

/**
 * Create rate limiter middleware
 * @param {Object} config - Rate limit configuration
 * @returns {Function} Rate limiter middleware
 */
function createRateLimiter(config) {
    return rateLimit({
        windowMs: config.windowMs,
        max: config.maxRequests,
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => {
            // Skip rate limiting for health checks
            return req.path === '/health' || req.path.endsWith('/health');
        },
        handler: (req, res) => {
            logger.warn({ 
                ip: req.ip, 
                path: req.path 
            }, 'Rate limit exceeded');
            res.status(429).json({
                error: 'Too many requests',
                message: 'Rate limit exceeded. Please try again later.'
            });
        }
    });
}

/**
 * Request logging middleware
 */
function requestLogger(req, res, next) {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.debug({
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration,
            ip: req.ip
        }, 'HTTP request');
    });
    next();
}

/**
 * Error handling middleware
 */
function errorHandler(err, req, res, next) {
    logger.error({ 
        error: err.message, 
        stack: err.stack,
        path: req.path,
        method: req.method
    }, 'Request error');

    if (res.headersSent) {
        return next(err);
    }

    res.status(err.status || 500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
    });
}

/**
 * Serve function - sets up Express server
 * @param {number} port - HTTP port
 * @param {string} rp - Redis prefix
 * @param {string} prefix - URL prefix
 */
exports.serve = (port, rp, prefix) => {
    // Prevent multiple calls to serve()
    if (serverInstance && serverInstance.listening) {
        const address = serverInstance.address();
        logger.warn({ 
            requestedPort: port,
            existingPort: address ? address.port : 'unknown'
        }, 'Server is already running. Ignoring duplicate serve() call.');
        return serverInstance;
    }
    
    redisPrefix = rp;
    prefix = prefix || '/';

    logger.info({ requestedPort: port }, `Starting server on port ${port}...`);

    // Initialize Redis connection
    getRedis();

    // Middleware
    app.use(requestLogger);
    app.use(express.json({ limit: '10mb' }));
    app.use(express.text({ limit: '10mb' }));
    app.use(fileUpload({
        limits: { fileSize: maxUpload }
    }));

    // Rate limiting
    const rateLimiter = createRateLimiter({
        windowMs: appConfig.rateLimit.windowMs,
        maxRequests: appConfig.rateLimit.maxRequests
    });
    app.use(rateLimiter);

    // Routes
    router.get('/', (req, res) => res.redirect('/myip'));

    router.get(['/help', '/docs'], (req, res) => {
        const docsUrl = require('./config.json').docs_url || '';
        if (docsUrl) {
            res.redirect(docsUrl);
        } else {
            res.status(404).json({ error: 'Documentation URL not configured' });
        }
    });

    router.get('/favicon.ico', (req, res) => res.status(204).end());

    // Cleanup stale lock endpoint (admin/debugging)
    router.post('/admin/cleanup-stale-lock', async (req, res) => {
        try {
            const updateLock = require('./updateLock');
            const lockKey = redisPrefix + 'update_lock';
            
            const cleaned = await updateLock.cleanupStaleLock(lockKey);
            if (cleaned) {
                res.json({ 
                    success: true, 
                    message: 'Stale lock cleaned up successfully' 
                });
            } else {
                res.json({ 
                    success: false, 
                    message: 'No stale lock found or lock is still valid' 
                });
            }
        } catch (error) {
            logger.error({ error: error.message }, 'Error cleaning up stale lock');
            res.status(500).json({ 
                success: false, 
                error: error.message 
            });
        }
    });

    // Health check endpoint
    router.get('/health', async (req, res) => {
        try {
            const redisClient = getRedis();
            await redisClient.ping();
            
            // Get update status
            const statusKey = redisPrefix + 'update_status';
            const updateStatusRaw = await redisClient.get(statusKey).catch(() => null);
            let updateStatus = null;
            if (updateStatusRaw) {
                try {
                    updateStatus = JSON.parse(updateStatusRaw);
                } catch (e) {
                    logger.warn({ error: e.message }, 'Failed to parse update status');
                }
            }

            // Get last update info
            const lastUpdateRaw = await redisClient.lindex(redisPrefix + 'ipListSize', 0).catch(() => null);
            let lastUpdate = null;
            if (lastUpdateRaw) {
                try {
                    lastUpdate = JSON.parse(lastUpdateRaw);
                } catch (e) {
                    logger.warn({ error: e.message }, 'Failed to parse last update info');
                }
            }

            // Check if update is in progress
            const updateLock = require('./updateLock');
            const lockKey = redisPrefix + 'update_lock';
            const isLocked = await updateLock.isLocked(lockKey).catch(() => false);
            let isStale = false;
            if (isLocked) {
                isStale = await updateLock.isLockStale(lockKey).catch(() => false);
            }

            const health = {
                status: 'healthy',
                timestamp: new Date().toISOString(),
                redis: 'connected',
                update: {
                    inProgress: isLocked && !isStale,
                    lockStale: isStale,
                    status: updateStatus?.status || 'unknown',
                    lastUpdate: lastUpdate?.date || null,
                    dataSize: lastUpdate?.size || null
                }
            };
            
            // If lock is stale, include warning and mark as degraded
            if (isStale) {
                health.status = 'degraded';
                health.update.warning = 'Update lock is held by a dead process. The lock will expire automatically (TTL) or can be cleaned up manually.';
            }

            // If update failed recently, include warning
            if (updateStatus?.status === 'failed') {
                health.status = 'degraded';
                health.update.error = updateStatus.error;
            }

            res.json(health);
        } catch (error) {
            logger.error({ error: error.message }, 'Health check failed');
            res.status(503).json({
                status: 'unhealthy',
                timestamp: new Date().toISOString(),
                redis: 'disconnected',
                error: error.message
            });
        }
    });

    router.post('/', async (req, res) => {
        try {
            const response = {};
            let ips = [];

            if (Object.keys(req.body).length === 0) {
                return res.status(422).json({ error: 'missing body' });
            }

            if (req.is('application/json')) {
                if (Array.isArray(req.body)) {
                    ips = req.body;
                } else {
                    return res.status(422).json({ error: 'body must be an array of IPs' });
                }
            } else {
                ips = req.body.split(/,|\r?\n/).filter(ip => ip.trim());
            }

            const includeDroneBL = shouldIncludeDroneBL(req.query);
            await Promise.all(ips.map(async ip => {
                const list = await lookupIP(ip, includeDroneBL);
                response[ip] = (list === null) ? [] : list;
            }));

            // Determine response format: check query param first, then Content-Type
            const wantsJson = [1, '1', true, 'true'].includes(req.query.json) || req.is('application/json');

            if (wantsJson) {
                res.json(response);
            } else {
                res.header('Content-Type', 'text/plain');
                const header = (![0, '0', false, 'false'].includes(req.query.header));
                const columns = ['ip', 'list', 'country'];
                const stringifier = stringify({ columns: columns, header: header });

                stringifier.on('readable', function() {
                    let row;
                    while (row = stringifier.read()) {
                        res.write(row);
                    }
                });

                stringifier.on('error', function(err) {
                    logger.error({ error: err.message }, 'CSV stringify error');
                    if (!res.headersSent) {
                        res.status(500).end();
                    }
                });

                stringifier.on('finish', () => res.end());

                for (const ip in response) {
                    let lists = '', countries = '';
                    if (response[ip].list) lists = response[ip].list.map(l => l.name).join('|');
                    if (response[ip].geo) countries = response[ip].geo.map(l => l.country).join('|');
                    stringifier.write([ip, lists, countries]);
                }
                stringifier.end();
            }
        } catch (error) {
            logger.error({ error: error.message }, 'POST / error');
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    router.get('/upload', (req, res) => {
        res.send(`
<html>
  <body>
    <p>Max upload: ${maxUpload / 1024 / 1024} MB (reverse proxy may set lower limit)</p>
    <p>Upload a line/comma separated list of IPs, or a JSON array with a .json file extension.</p>
    <form ref='uploadForm' 
      id='uploadForm'  
      method='post' 
      encType="multipart/form-data">
        <input type="file" name="ipList" />
        <input type='submit' value='Upload!' />
    </form>     
  </body>
</html>`);
    });

    router.post('/upload', async function(req, res) {
        try {
            if (!req.files || Object.keys(req.files).length === 0) {
                return res.status(400).json({ error: 'No files were uploaded.' });
            }

            const fileAsString = req.files.ipList.data.toString();
            const response = {};

            let contentType;
            let fileName;
            let ips = [];
            let stringifier;
            let fileType;

            if (req.files.ipList.name.match(/\.json$/)) {
                try {
                    fileType = 'json';
                    ips = JSON.parse(fileAsString);
                    if (!Array.isArray(ips)) {
                        return res.status(422).json({ error: 'JSON file must contain an array of IPs' });
                    }
                    contentType = 'application/json';
                    fileName = 'ips.json';
                } catch (error) {
                    return res.status(422).json({ error: 'Invalid JSON format' });
                }
            } else {
                fileType = 'csv';
                ips = fileAsString.split(/,|\r?\n/).filter(ip => ip.trim());
                contentType = 'text/csv';
                fileName = 'ips.csv';
                const header = (![0, '0', false, 'false'].includes(req.query.header));
                const columns = ['ip', 'list', 'country'];
                stringifier = stringify({ columns: columns, header: header });

                stringifier.on('readable', function() {
                    let row;
                    while (row = stringifier.read()) {
                        res.write(row);
                    }
                });

                stringifier.on('error', function(err) {
                    logger.error({ error: err.message }, 'CSV stringify error');
                    if (!res.headersSent) {
                        res.status(500).end();
                    }
                });

                stringifier.on('finish', () => res.end());
            }

            res.header('Content-Type', contentType);
            res.attachment(fileName);

            const includeDroneBL = shouldIncludeDroneBL(req.query);
            await Promise.all(ips.map(async ip => {
                const list = await lookupIP(ip, includeDroneBL);
                response[ip] = (list === null) ? [] : list;

                if (fileType === 'csv') {
                    let lists = '', countries = '';
                    if (response[ip].list) lists = response[ip].list.map(l => l.name).join('|');
                    if (response[ip].geo) countries = response[ip].geo.map(l => l.country).join('|');
                    stringifier.write([ip, lists, countries]);
                }
            }));

            if (fileType === 'csv') {
                stringifier.end();
            } else {
                res.send(JSON.stringify(response));
            }
        } catch (error) {
            logger.error({ error: error.message }, 'POST /upload error');
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    router.get('/myip', async (req, res) => {
        try {
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            const response = { ip };
            const includeDroneBL = shouldIncludeDroneBL(req.query);
            const ipLists = await lookupIP(ip, includeDroneBL);
            response.result = ipLists || {};

            if ([1, '1', true, 'true'].includes(req.query.csv)) {
                const header = (![0, '0', false, 'false'].includes(req.query.header));
                res.header('Content-Type', 'text/plain');
                const columns = ['ip', 'list', 'country'];
                let lists = '', countries = '';
                if (ipLists && ipLists.list) lists = ipLists.list.map(l => l.name).join('|');
                if (ipLists && ipLists.geo) countries = ipLists.geo.map(l => l.country).join('|');
                stringify([[ip, lists, countries]], { columns: columns, header: header }, (err, output) => {
                    if (err) {
                        logger.error({ error: err.message }, 'CSV stringify error');
                        return res.status(500).end();
                    }
                    res.send(output);
                });
            } else {
                res.json(response);
            }
        } catch (error) {
            logger.error({ error: error.message }, 'GET /myip error');
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    router.get('/:ip', async (req, res) => {
        try {
            const ip = req.params.ip;
            const includeDroneBL = shouldIncludeDroneBL(req.query);
            const ipLists = await lookupIP(ip, includeDroneBL);

            if (ipLists === false) {
                return res.status(422).json({ error: 'invalid ipv4' });
            } else if (ipLists === null) {
                return res.status(404).json({ error: 'IP not found' });
            }

            if ([1, '1', true, 'true'].includes(req.query.csv)) {
                const header = (![0, '0', false, 'false'].includes(req.query.header));
                res.header('Content-Type', 'text/plain');
                const columns = ['list', 'country'];
                let lists = '', countries = '';
                if (ipLists.list) lists = ipLists.list.map(l => l.name).join('|');
                if (ipLists.geo) countries = ipLists.geo.map(l => l.country).join('|');
                stringify([[lists, countries]], { columns: columns, header: header }, (err, output) => {
                    if (err) {
                        logger.error({ error: err.message }, 'CSV stringify error');
                        return res.status(500).end();
                    }
                    res.send(output);
                });
            } else {
                res.json(ipLists);
            }
        } catch (error) {
            logger.error({ error: error.message }, 'GET /:ip error');
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.use(prefix, router);
    app.use(errorHandler);

    // Create HTTP server
    const server = http.createServer(app);
    serverInstance = server; // Store reference

    // Initialize WebSocket server if enabled
    if (appConfig.websocket.enabled) {
        createWebSocketServer({
            server,
            lookupIP,
            config: appConfig
        });
        logger.info('WebSocket server enabled');
    }

    // Handle port binding errors - must be set up BEFORE calling listen()
    let listenError = null;
    let listenCallbackCalled = false;
    
    server.on('error', (err) => {
        listenError = err;
        if (err.code === 'EADDRINUSE') {
            logger.error({ 
                port, 
                error: err.message,
                code: err.code,
                syscall: err.syscall,
                address: err.address
            }, `Port ${port} is already in use. Server failed to start. Please stop the process using port ${port} or set IP_HTTP_PORT to a different port.`);
            // Close the server if it was partially created
            if (server && !server.listening) {
                server.close();
            }
            // Exit process with error code
            process.exit(1);
        } else {
            logger.error({ 
                port, 
                error: err.message, 
                code: err.code,
                syscall: err.syscall 
            }, 'Server error during startup');
            if (server && !server.listening) {
                server.close();
            }
            process.exit(1);
        }
    });
    
    try {
        server.listen(port, () => {
            listenCallbackCalled = true;
            
            // Check if there was an error before logging success
            if (listenError) {
                logger.error({ error: listenError }, 'Server listen callback called but error occurred - this should not happen');
                server.close();
                process.exit(1);
                return;
            }
            
            const address = server.address();
            if (!address) {
                logger.error({ port }, 'Server address is null - server may not have bound to port');
                server.close();
                process.exit(1);
                return;
            }
            
            const actualPort = address.port;
            const actualAddress = address.address;
            
            // CRITICAL: Verify we got the port we requested (unless port was 0 for auto-assign)
            if (port !== 0 && actualPort !== port) {
                logger.error({ 
                    requestedPort: port, 
                    actualPort 
                }, `CRITICAL: Server bound to port ${actualPort} but requested port ${port}. This indicates a port conflict was not properly detected. Closing server.`);
                server.close();
                process.exit(1);
                return;
            }
            
            // Log using structured logger
            logger.info({ 
                port: actualPort, 
                requestedPort: port,
                boundAddress: actualAddress,
                prefix,
                websocket: appConfig.websocket.enabled
            }, `🚀 IP Denylist Lookup Service started - Listening on ${actualAddress}:${actualPort}${appConfig.websocket.enabled ? ' (WebSocket enabled)' : ''}`);
        });
        
        // Add a timeout to detect if listen() callback never fires (which would indicate an error)
        setTimeout(() => {
            if (!listenCallbackCalled && !listenError) {
                logger.error({ port }, 'Server listen() callback did not fire within timeout - port may be in use');
                server.close();
                process.exit(1);
            }
        }, 1000).unref(); // Don't keep process alive
        
    } catch (err) {
        // Catch synchronous errors (though listen() is async, this is a safety net)
        if (err.code === 'EADDRINUSE') {
            logger.error({ 
                port, 
                error: err.message,
                code: err.code
            }, `Port ${port} is already in use (caught synchronously). Server failed to start.`);
            process.exit(1);
        } else {
            logger.error({ port, error: err.message }, 'Failed to start server');
            throw err;
        }
    }
    
    // Emit listening event for test synchronization
    server.on('listening', () => {
        // Server is ready
    });

    // For testing: attach app to server
    server._expressApp = app;
    
    // Add cleanup method for testing
    server._cleanup = async () => {
        // Close Redis connection
        closeRedis();
        
        // Reset rate limiter if it has cleanup
        if (app._rateLimiter && typeof app._rateLimiter.resetKey === 'function') {
            // Rate limiter cleanup if needed
        }
    };
    
    // Expose Redis connection for cleanup
    server._getRedis = () => redis;
    
    // Expose closeRedis function
    server._closeRedis = closeRedis;
    
    return server;
};

/**
 * Create Express app without starting server (for testing)
 * @param {string} rp - Redis prefix
 * @param {string} prefix - URL prefix
 * @returns {express.Application} Express app
 */
exports.createApp = (rp, prefix) => {
    redisPrefix = rp;
    prefix = prefix || '/';

    // Initialize Redis connection
    getRedis();

    // Middleware
    app.use(requestLogger);
    app.use(express.json({ limit: '10mb' }));
    app.use(express.text({ limit: '10mb' }));
    app.use(fileUpload({
        limits: { fileSize: maxUpload }
    }));

    // Rate limiting
    const rateLimiter = createRateLimiter({
        windowMs: appConfig.rateLimit.windowMs,
        maxRequests: appConfig.rateLimit.maxRequests
    });
    app.use(rateLimiter);

    // Routes (same as serve function)
    // ... routes would be duplicated here, but for now we'll use a different approach
    return app;
};

// Allow serve.js to be run directly from command line
if (require.main === module) {
    const appConfig = require('./config');
    const logger = require('./logger');
    
    const port = parseInt(process.env.IP_HTTP_PORT) || appConfig.app.httpPort;
    const redisPrefix = appConfig.app.redisPrefix;
    const prefix = appConfig.app.prefix;
    
    logger.info({ port, redisPrefix, prefix }, 'Starting server directly from serve.js');
    
    try {
        exports.serve(port, redisPrefix, prefix);
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack }, 'Failed to start server');
        process.exit(1);
    }
}
