'use strict';

const BasePlugin = require('../../../plugins/base');

describe('BasePlugin', () => {
    test('should create plugin instance', () => {
        const plugin = new BasePlugin({ name: 'test-plugin' });
        
        expect(plugin).toBeDefined();
        expect(plugin.name).toBe('test-plugin');
        expect(plugin.version).toBe('1.0.0');
    });

    test('should require name', () => {
        expect(() => {
            new BasePlugin({});
        }).toThrow('Plugin name is required');
    });

    test('should initialize plugin', async () => {
        const plugin = new BasePlugin({ name: 'test-plugin' });
        
        await plugin.init();
        
        expect(plugin._initialized).toBe(true);
    });

    test('should throw error if load not implemented', async () => {
        const plugin = new BasePlugin({ name: 'test-plugin' });
        
        await expect(plugin.load()).rejects.toThrow('must implement load()');
    });

    test('should validate data', async () => {
        const plugin = new BasePlugin({ name: 'test-plugin' });
        
        const isValid = await plugin.validate({});
        
        expect(isValid).toBe(true);
    });

    test('should perform health check', async () => {
        const plugin = new BasePlugin({ name: 'test-plugin' });
        
        const health = await plugin.healthCheck();
        
        expect(health).toEqual({
            name: 'test-plugin',
            status: 'healthy',
            initialized: false
        });
    });

    test('should cleanup resources', async () => {
        const plugin = new BasePlugin({ name: 'test-plugin' });
        
        await expect(plugin.cleanup()).resolves.not.toThrow();
    });

    test('should retry with exponential backoff', async () => {
        const plugin = new BasePlugin({ name: 'test-plugin' });
        
        let attempts = 0;
        const fn = jest.fn(async () => {
            attempts++;
            if (attempts < 2) {
                throw new Error('Test error');
            }
            return 'success';
        });
        
        const result = await plugin.retryWithBackoff(fn, { maxRetries: 3 });
        
        expect(result).toBe('success');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    test('should fail after max retries', async () => {
        const plugin = new BasePlugin({ name: 'test-plugin' });
        
        const fn = jest.fn(async () => {
            throw new Error('Always fails');
        });
        
        await expect(
            plugin.retryWithBackoff(fn, { maxRetries: 2 })
        ).rejects.toThrow('Always fails');
        
        expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    test('should get metadata', () => {
        const plugin = new BasePlugin({
            name: 'test-plugin',
            version: '2.0.0',
            description: 'Test description',
            abortOnFail: true
        });
        
        const metadata = plugin.getMetadata();
        
        expect(metadata).toEqual({
            name: 'test-plugin',
            version: '2.0.0',
            description: 'Test description',
            abortOnFail: true
        });
    });
});

