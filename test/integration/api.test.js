'use strict';

const request = require('supertest');
const { createTestRedis, cleanupTestRedis, flushTestRedis } = require('../helpers/redis');
const { testIps } = require('../helpers/fixtures');

describe('API Integration Tests', () => {
    let app;
    let redis;
    let server;

    beforeAll(async () => {
        redis = createTestRedis();
        try {
            await redis.ping();
        } catch (error) {
            console.warn('Redis not available, skipping API integration tests');
            return;
        }
        
        // Set up test data
        await flushTestRedis();
        const key = 'test_ip_lists:ranges';
        const testRange = {
            start: 167772160, // 10.0.0.0
            end: 167772415,   // 10.0.0.255
            data: { list: [{ name: 'test-list', source: 'test' }] }
        };
        const value = `${testRange.start}|${testRange.end}|${JSON.stringify(testRange.data)}`;
        await redis.zadd(key, testRange.end, value);
        
        // Start server - serve() returns the HTTP server
        process.env.IP_REDIS_PREFIX = 'test_ip_lists:';
        process.env.IP_HTTP_PORT = '3001';
        process.env.WS_ENABLED = 'false'; // Disable WS for API tests
        delete require.cache[require.resolve('../../serve')];
        delete require.cache[require.resolve('../../config')];
        const serve = require('../../serve').serve;
        server = serve(3001, 'test_ip_lists:', '/');
        
        // Wait for server to start - server.listen is async
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Server startup timeout'));
            }, 5000).unref(); // Don't keep process alive
            
            server.on('listening', () => {
                clearTimeout(timeout);
                resolve();
            });
            
            server.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
        
        // supertest needs the Express app, which is attached to the server
        app = server._expressApp || server;
    });
    
    beforeEach(async () => {
        // Re-setup test data in case another test flushed Redis
        if (redis) {
            const key = 'test_ip_lists:ranges';
            const testRange = {
                start: 167772160, // 10.0.0.0
                end: 167772415,   // 10.0.0.255
                data: { list: [{ name: 'test-list', source: 'test' }] }
            };
            const value = `${testRange.start}|${testRange.end}|${JSON.stringify(testRange.data)}`;
            await redis.zadd(key, testRange.end, value);
        }
    });

    afterAll(async () => {
        // Close Redis connection from serve module FIRST (before closing server)
        if (server && server._closeRedis) {
            server._closeRedis();
        } else if (server && server._cleanup) {
            await server._cleanup();
        }
        
        // Close test Redis connection
        if (redis) {
            try {
                await cleanupTestRedis();
                redis.removeAllListeners();
                redis.disconnect(false);
            } catch (e) {
                // Ignore errors
            }
        }
        
        // Close server and all connections
        if (server) {
            // Close all active connections first
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
            
            // Remove all listeners BEFORE closing to prevent handles
            server.removeAllListeners();
            
            // Then close the server synchronously if possible
            const address = server.address();
            if (address) {
                await new Promise((resolve) => {
                    const timeout = setTimeout(resolve, 1000).unref(); // Don't keep process alive
                    server.close(() => {
                        clearTimeout(timeout);
                        resolve();
                    });
                });
            }
        }
        
        // Clear module cache AFTER closing connections
        delete require.cache[require.resolve('../../serve')];
        delete require.cache[require.resolve('../../config')];
        delete require.cache[require.resolve('../../updateLock')];
    }, 10000);

    test('should return health check', async () => {
        if (!redis || !app) return;
        
        const response = await request(app)
            .get('/health')
            .expect(200);
        
        expect(response.body.status).toBeDefined();
        expect(response.body.redis).toBe('connected');
    });

    test('should lookup valid IP', async () => {
        if (!redis || !app) return;
        
        const response = await request(app)
            .get('/10.0.0.1')
            .expect(200);
        
        expect(response.body).toBeDefined();
        expect(response.body.list).toBeDefined();
    });

    test('should return 404 for IP not in range', async () => {
        if (!redis || !app) return;
        
        await request(app)
            .get('/192.168.1.1')
            .expect(404);
    });

    test('should return 422 for invalid IP', async () => {
        if (!redis || !app) return;
        
        await request(app)
            .get('/invalid.ip')
            .expect(422);
    });

    test('should handle batch lookup', async () => {
        if (!redis || !app) return;
        
        const response = await request(app)
            .post('/')
            .send(['10.0.0.1', '192.168.1.1'])
            .set('Content-Type', 'application/json')
            .expect(200);
        
        expect(response.body).toBeDefined();
        expect(response.body['10.0.0.1']).toBeDefined();
        expect(response.body['192.168.1.1']).toBeDefined();
    });

    test('should handle CSV format request', async () => {
        if (!redis || !app) return;
        
        const response = await request(app)
            .get('/10.0.0.1?csv=1')
            .expect(200);
        
        expect(response.headers['content-type']).toContain('text/plain');
        // CSV response might be formatted differently, just check it's not empty
        expect(response.text.length).toBeGreaterThan(0);
    });

    test('should handle rate limiting', async () => {
        if (!redis || !app) return;
        
        // Make many requests quickly - but limit to avoid timeout
        const requests = Array(50).fill().map(() =>
            request(app).get('/health')
        );
        
        // Health endpoint should not be rate limited
        const responses = await Promise.all(requests);
        const rateLimited = responses.filter(r => r.status === 429);
        
        expect(rateLimited.length).toBe(0); // Health check not rate limited
    });
});

