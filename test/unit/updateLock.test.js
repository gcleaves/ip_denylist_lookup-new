'use strict';

const updateLock = require('../../updateLock');
const { MockRedis } = require('../helpers/mocks');

// Mock ioredis
jest.mock('ioredis', () => {
    return jest.fn().mockImplementation(() => {
        return new MockRedis();
    });
});

describe('UpdateLock', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Reset mock Redis data and clear timeouts
        const { MockRedis } = require('../helpers/mocks');
        MockRedis.reset();
        // Clear the module cache to get a fresh Redis instance
        delete require.cache[require.resolve('../../updateLock')];
        delete require.cache[require.resolve('ioredis')];
    });
    
    afterEach(() => {
        // Clear any remaining timeouts
        const { MockRedis } = require('../helpers/mocks');
        MockRedis.reset();
    });

    test('should acquire lock successfully', async () => {
        const lockKey = 'test_lock';
        const acquired = await updateLock.acquireLock(lockKey, 60);
        
        expect(acquired).toBe(true);
    });

    test('should fail to acquire lock if already held', async () => {
        const lockKey = 'test_lock';
        
        // Acquire lock first time
        await updateLock.acquireLock(lockKey, 60);
        
        // Try to acquire again
        const acquired = await updateLock.acquireLock(lockKey, 60);
        
        expect(acquired).toBe(false);
    });

    test('should release lock successfully', async () => {
        const lockKey = 'test_lock';
        
        await updateLock.acquireLock(lockKey, 60);
        const lockValue = await updateLock.getLockValue(lockKey);
        
        const released = await updateLock.releaseLock(lockKey, lockValue);
        
        expect(released).toBe(true);
    });

    test('should fail to release lock with wrong value', async () => {
        const lockKey = 'test_lock';
        
        await updateLock.acquireLock(lockKey, 60);
        
        const released = await updateLock.releaseLock(lockKey, 'wrong-value');
        
        expect(released).toBe(false);
    });

    test('should check if lock exists', async () => {
        const lockKey = 'test_lock_2'; // Use different key to avoid conflicts
        
        // Ensure lock doesn't exist first
        const lockValue = await updateLock.getLockValue(lockKey);
        if (lockValue) {
            await updateLock.releaseLock(lockKey, lockValue);
        }
        
        expect(await updateLock.isLocked(lockKey)).toBe(false);
        
        await updateLock.acquireLock(lockKey, 60);
        
        expect(await updateLock.isLocked(lockKey)).toBe(true);
    });

    test('should get lock value', async () => {
        const lockKey = 'test_lock';
        
        await updateLock.acquireLock(lockKey, 60);
        const value = await updateLock.getLockValue(lockKey);
        
        expect(value).toBeDefined();
        expect(typeof value).toBe('string');
    });

    test('should extend lock TTL', async () => {
        const lockKey = 'test_lock';
        
        await updateLock.acquireLock(lockKey, 60);
        const lockValue = await updateLock.getLockValue(lockKey);
        
        const extended = await updateLock.extendLock(lockKey, lockValue, 120);
        
        expect(extended).toBe(true);
    });
});

