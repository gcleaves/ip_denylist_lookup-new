'use strict';

const WebSocket = require('ws');
const logger = require('./logger');

/**
 * WebSocket server for IP lookup
 * @param {Object} options - WebSocket server options
 * @param {http.Server} options.server - HTTP server instance
 * @param {Function} options.lookupIP - IP lookup function
 * @param {Object} options.config - Configuration object
 * @returns {WebSocket.Server} WebSocket server instance
 */
function createWebSocketServer({ server, lookupIP, config }) {
    const wsLogger = logger.child({ module: 'websocket' });
    const wss = new WebSocket.Server({ 
        server,
        path: config.app.prefix.replace(/\/$/, '') + '/ws'
    });

    // Rate limiting per connection
    const messageCounts = new Map();
    const rateLimitWindow = config.rateLimit.windowMs;
    const maxMessages = config.rateLimit.wsMaxMessages;

    /**
     * Check if connection has exceeded rate limit
     * @param {string} connectionId - Connection identifier
     * @returns {boolean} True if rate limit exceeded
     */
    function checkRateLimit(connectionId) {
        const now = Date.now();
        const counts = messageCounts.get(connectionId) || { count: 0, resetTime: now + rateLimitWindow };

        if (now > counts.resetTime) {
            counts.count = 0;
            counts.resetTime = now + rateLimitWindow;
        }

        counts.count++;
        messageCounts.set(connectionId, counts);

        if (counts.count > maxMessages) {
            return true;
        }

        return false;
    }

    /**
     * Send error message to client
     * @param {WebSocket} ws - WebSocket connection
     * @param {string} message - Error message
     * @param {string} [requestId] - Optional request ID
     */
    function sendError(ws, message, requestId) {
        const errorResponse = {
            type: 'error',
            message,
            ...(requestId && { requestId })
        };
        ws.send(JSON.stringify(errorResponse));
    }

    /**
     * Handle lookup message
     * @param {WebSocket} ws - WebSocket connection
     * @param {Object} data - Message data
     * @param {string} connectionId - Connection identifier
     */
    async function handleLookup(ws, data, connectionId) {
        const { ip, requestId } = data;

        if (!ip || typeof ip !== 'string') {
            sendError(ws, 'Invalid request: ip is required', requestId);
            return;
        }

        try {
            const result = await lookupIP(ip);
            const response = {
                type: 'result',
                ip,
                data: result === null ? {} : result,
                ...(requestId && { requestId })
            };
            ws.send(JSON.stringify(response));
        } catch (error) {
            wsLogger.error({ error: error.message, ip, connectionId }, 'Lookup error');
            sendError(ws, `Lookup failed: ${error.message}`, requestId);
        }
    }

    /**
     * Handle batch lookup message
     * @param {WebSocket} ws - WebSocket connection
     * @param {Object} data - Message data
     * @param {string} connectionId - Connection identifier
     */
    async function handleBatch(ws, data, connectionId) {
        const { ips, requestId } = data;

        if (!Array.isArray(ips) || ips.length === 0) {
            sendError(ws, 'Invalid request: ips must be a non-empty array', requestId);
            return;
        }

        if (ips.length > 1000) {
            sendError(ws, 'Invalid request: batch size exceeds maximum of 1000', requestId);
            return;
        }

        try {
            const results = {};
            await Promise.all(
                ips.map(async (ip) => {
                    try {
                        const result = await lookupIP(ip);
                        results[ip] = result === null ? {} : result;
                    } catch (error) {
                        wsLogger.warn({ error: error.message, ip }, 'Batch lookup item error');
                        results[ip] = { error: error.message };
                    }
                })
            );

            const response = {
                type: 'batch_result',
                results,
                ...(requestId && { requestId })
            };
            ws.send(JSON.stringify(response));
        } catch (error) {
            wsLogger.error({ error: error.message, connectionId }, 'Batch lookup error');
            sendError(ws, `Batch lookup failed: ${error.message}`, requestId);
        }
    }

    /**
     * Handle ping message
     * @param {WebSocket} ws - WebSocket connection
     * @param {Object} data - Message data
     */
    function handlePing(ws, data) {
        const { requestId } = data;
        const response = {
            type: 'pong',
            timestamp: Date.now(),
            ...(requestId && { requestId })
        };
        ws.send(JSON.stringify(response));
    }

    wss.on('connection', (ws, req) => {
        const connectionId = `${req.socket.remoteAddress}-${Date.now()}`;
        wsLogger.info({ connectionId, remoteAddress: req.socket.remoteAddress }, 'WebSocket connection opened');

        // Send welcome message
        ws.send(JSON.stringify({
            type: 'connected',
            message: 'WebSocket connection established',
            protocols: ['lookup', 'batch', 'ping']
        }));

        ws.on('message', async (message) => {
            // Check rate limit
            if (checkRateLimit(connectionId)) {
                sendError(ws, 'Rate limit exceeded');
                ws.close(1008, 'Rate limit exceeded');
                return;
            }

            try {
                const data = JSON.parse(message.toString());

                if (!data.type) {
                    sendError(ws, 'Invalid request: type is required');
                    return;
                }

                switch (data.type) {
                    case 'lookup':
                        await handleLookup(ws, data, connectionId);
                        break;
                    case 'batch':
                        await handleBatch(ws, data, connectionId);
                        break;
                    case 'ping':
                        handlePing(ws, data);
                        break;
                    default:
                        sendError(ws, `Unknown message type: ${data.type}`);
                }
            } catch (error) {
                if (error instanceof SyntaxError) {
                    sendError(ws, 'Invalid JSON format');
                } else {
                    wsLogger.error({ error: error.message, connectionId }, 'Message handling error');
                    sendError(ws, `Message processing error: ${error.message}`);
                }
            }
        });

        ws.on('close', (code, reason) => {
            messageCounts.delete(connectionId);
            wsLogger.info({ connectionId, code, reason: reason.toString() }, 'WebSocket connection closed');
        });

        ws.on('error', (error) => {
            wsLogger.error({ error: error.message, connectionId }, 'WebSocket error');
        });
    });

    wss.on('error', (error) => {
        wsLogger.error({ error: error.message }, 'WebSocket server error');
    });

    wsLogger.info('WebSocket server initialized');
    return wss;
}

module.exports = { createWebSocketServer };

