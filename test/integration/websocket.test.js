'use strict';

const WebSocket = require('ws');
const { createTestRedis, cleanupTestRedis, flushTestRedis } = require('../helpers/redis');

describe('WebSocket Integration Tests', () => {
    let redis;
    let server;
    let wsServer;
    const testPort = 3003; // Use different port to avoid conflicts

    beforeAll(async () => {
        redis = createTestRedis();
        try {
            await redis.ping();
        } catch (error) {
            console.warn('Redis not available, skipping WebSocket tests');
            return;
        }
        
        await flushTestRedis();
        
        // Set up test data
        const key = 'test_ip_lists:ranges';
        const testRange = {
            start: 167772160, // 10.0.0.0
            end: 167772415,   // 10.0.0.255
            data: { list: [{ name: 'test-list', source: 'test' }] }
        };
        const value = `${testRange.start}|${testRange.end}|${JSON.stringify(testRange.data)}`;
        await redis.zadd(key, testRange.end, value);
        
        // Start HTTP server
        process.env.IP_REDIS_PREFIX = 'test_ip_lists:';
        process.env.IP_HTTP_PORT = testPort.toString();
        process.env.WS_ENABLED = 'true';
        
        const http = require('http');
        const app = require('express')();
        app.get('/health', (req, res) => res.json({ status: 'ok' }));
        
        server = http.createServer(app);
        server.listen(testPort);
        
        // Set up WebSocket server
        const { createWebSocketServer } = require('../../websocket');
        const lookupIP = async (ip) => {
            const long = require('ip-utils').toLong(ip);
            const answer = await redis.zrangebyscore(key, long, '+inf', 'LIMIT', 0, 1);
            if (answer && answer.length > 0) {
                const item = answer[0];
                const [startInt, endInt, lists] = item.split('|');
                if (long >= parseInt(startInt) && long <= parseInt(endInt)) {
                    return JSON.parse(lists);
                }
            }
            return null;
        };
        
        const config = {
            app: { prefix: '/' },
            rateLimit: { windowMs: 60000, wsMaxMessages: 100 }
        };
        
        wsServer = createWebSocketServer({
            server,
            lookupIP,
            config
        });
        
        // Wait for server to start
        await new Promise(resolve => setTimeout(resolve, 100).unref());
    });

    afterAll(async () => {
        if (wsServer) {
            wsServer.close();
            // Wait for WebSocket server to close
            await new Promise(resolve => setTimeout(resolve, 100).unref());
        }
        if (server) {
            await new Promise((resolve) => {
                server.close(() => {
                    setTimeout(resolve, 100).unref();
                });
            });
        }
        if (redis) {
            await cleanupTestRedis();
            await redis.quit();
        }
        // Clear module cache
        delete require.cache[require.resolve('../../websocket')];
        delete require.cache[require.resolve('../../serve')];
        delete require.cache[require.resolve('../../config')];
    });

    test('should connect to WebSocket server', (done) => {
        if (!redis) return done();
        
        const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
        
        ws.on('open', () => {
            ws.close();
            done();
        });
        
        ws.on('error', (error) => {
            done(error);
        });
    });

    test('should receive connected message', (done) => {
        if (!redis) return done();
        
        const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
        
        ws.on('message', (data) => {
            const message = JSON.parse(data);
            if (message.type === 'connected') {
                expect(message.protocols).toContain('lookup');
                expect(message.protocols).toContain('batch');
                ws.close();
                done();
            }
        });
        
        ws.on('error', (error) => {
            done(error);
        });
    });

    test('should handle lookup request', (done) => {
        if (!redis) return done();
        
        const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
        
        ws.on('open', () => {
            ws.send(JSON.stringify({
                type: 'lookup',
                ip: '10.0.0.1',
                requestId: 'test-1'
            }));
        });
        
        ws.on('message', (data) => {
            const message = JSON.parse(data);
            if (message.type === 'result' && message.requestId === 'test-1') {
                expect(message.ip).toBe('10.0.0.1');
                expect(message.data).toBeDefined();
                ws.close();
                done();
            } else if (message.type === 'error') {
                ws.close();
                done(new Error(message.message));
            }
        });
        
        ws.on('error', (error) => {
            done(error);
        });
    });

    test('should handle batch lookup request', (done) => {
        if (!redis) return done();
        
        const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
        
        ws.on('open', () => {
            ws.send(JSON.stringify({
                type: 'batch',
                ips: ['10.0.0.1', '192.168.1.1'],
                requestId: 'test-2'
            }));
        });
        
        ws.on('message', (data) => {
            const message = JSON.parse(data);
            if (message.type === 'batch_result' && message.requestId === 'test-2') {
                expect(message.results).toBeDefined();
                expect(message.results['10.0.0.1']).toBeDefined();
                expect(message.results['192.168.1.1']).toBeDefined();
                ws.close();
                done();
            } else if (message.type === 'error') {
                ws.close();
                done(new Error(message.message));
            }
        });
        
        ws.on('error', (error) => {
            done(error);
        });
    });

    test('should handle ping request', (done) => {
        if (!redis) return done();
        
        const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
        
        ws.on('open', () => {
            ws.send(JSON.stringify({
                type: 'ping',
                requestId: 'test-3'
            }));
        });
        
        ws.on('message', (data) => {
            const message = JSON.parse(data);
            if (message.type === 'pong' && message.requestId === 'test-3') {
                expect(message.timestamp).toBeDefined();
                ws.close();
                done();
            }
        });
        
        ws.on('error', (error) => {
            done(error);
        });
    });

    test('should handle invalid message format', (done) => {
        if (!redis) return done();
        
        const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
        
        ws.on('open', () => {
            ws.send('invalid json');
        });
        
        ws.on('message', (data) => {
            const message = JSON.parse(data);
            if (message.type === 'error') {
                expect(message.message).toContain('Invalid JSON');
                ws.close();
                done();
            }
        });
        
        ws.on('error', (error) => {
            done(error);
        });
    });
});

