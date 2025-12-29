'use strict';

const { createTestRedis, cleanupTestRedis, flushTestRedis } = require('../helpers/redis');
const { testIps, sampleRanges } = require('../helpers/fixtures');

describe('Redis Integration Tests', () => {
    let redis;

    beforeAll(async () => {
        redis = createTestRedis();
        try {
            await redis.ping();
        } catch (error) {
            console.warn('Redis not available, skipping integration tests');
            return;
        }
        await flushTestRedis();
    });

    afterAll(async () => {
        if (redis) {
            await cleanupTestRedis();
            await redis.quit();
        }
    });

    beforeEach(async () => {
        if (redis) {
            await flushTestRedis();
            // Also explicitly delete the ranges key to ensure clean state
            await redis.del('test_ip_lists:ranges');
        }
    });

    test('should connect to Redis', async () => {
        if (!redis) return;
        
        const result = await redis.ping();
        expect(result).toBe('PONG');
    });

    test('should store and retrieve IP ranges', async () => {
        if (!redis) return;
        
        const key = 'test_ip_lists:ranges';
        const range = sampleRanges[0];
        const value = `${range.start}|${range.end}|${JSON.stringify({ list: [{ name: range.list }] })}`;
        
        await redis.zadd(key, range.end, value);
        
        const result = await redis.zrangebyscore(key, range.start, '+inf', 'LIMIT', 0, 1);
        
        expect(result).toHaveLength(1);
        expect(result[0]).toBe(value);
    });

    test('should lookup IP in range', async () => {
        if (!redis) return;
        
        const key = 'test_ip_lists:ranges';
        const range = sampleRanges[0];
        const testIp = 167772160 + 100; // 10.0.0.100
        const value = `${range.start}|${range.end}|${JSON.stringify({ list: [{ name: 'test1' }] })}`;
        
        await redis.zadd(key, range.end, value);
        
        const result = await redis.zrangebyscore(key, testIp, '+inf', 'LIMIT', 0, 1);
        
        expect(result).toHaveLength(1);
        const [start, end] = result[0].split('|');
        expect(parseInt(start)).toBeLessThanOrEqual(testIp);
        expect(parseInt(end)).toBeGreaterThanOrEqual(testIp);
    });

    test('should handle atomic rename operation', async () => {
        if (!redis) return;
        
        const tempKey = 'test_ip_lists:temp';
        const finalKey = 'test_ip_lists:ranges';
        const value = 'test_value';
        
        await redis.zadd(tempKey, 100, value);
        await redis.rename(tempKey, finalKey);
        
        const exists = await redis.exists(tempKey);
        const finalExists = await redis.exists(finalKey);
        
        expect(exists).toBe(0);
        expect(finalExists).toBe(1);
    });

    test('should handle pipeline operations', async () => {
        if (!redis) return;
        
        const key = 'test_ip_lists:ranges';
        const pipeline = redis.pipeline();
        
        for (const range of sampleRanges) {
            const value = `${range.start}|${range.end}|test`;
            pipeline.zadd(key, range.end, value);
        }
        
        await pipeline.exec();
        
        const count = await redis.zcard(key);
        expect(count).toBe(sampleRanges.length);
    });
});

