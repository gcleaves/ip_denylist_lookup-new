'use strict';

/**
 * Mock implementations for testing
 */

/**
 * Mock Redis client
 */
class MockRedis {
    constructor() {
        // Use a shared data store that can be reset
        if (!MockRedis.sharedData) {
            MockRedis.sharedData = new Map();
        }
        if (!MockRedis.timeouts) {
            MockRedis.timeouts = new Map();
        }
        this.data = MockRedis.sharedData;
        this.pipelineCommands = [];
    }
    
    static reset() {
        // Clear all timeouts
        if (MockRedis.timeouts) {
            for (const timeout of MockRedis.timeouts.values()) {
                clearTimeout(timeout);
            }
            MockRedis.timeouts.clear();
        }
        MockRedis.sharedData = new Map();
    }

    async get(key) {
        return this.data.get(key) || null;
    }

    async set(key, value, ...args) {
        // Handle SET with options like EX, NX
        if (args.includes('NX')) {
            if (this.data.has(key)) {
                return null;
            }
        }
        this.data.set(key, value);
        
        // Handle EX (expire) - track timeout so it can be cleared
        const exIndex = args.indexOf('EX');
        if (exIndex !== -1 && args[exIndex + 1]) {
            // Clear existing timeout for this key if any
            if (MockRedis.timeouts.has(key)) {
                clearTimeout(MockRedis.timeouts.get(key));
            }
            
            const timeout = setTimeout(() => {
                this.data.delete(key);
                MockRedis.timeouts.delete(key);
            }, args[exIndex + 1] * 1000).unref(); // Don't keep process alive in tests
            
            MockRedis.timeouts.set(key, timeout);
        }
        
        return 'OK';
    }

    async del(...keys) {
        let deleted = 0;
        for (const key of keys) {
            if (this.data.delete(key)) {
                deleted++;
            }
        }
        return deleted;
    }

    async exists(...keys) {
        // Handle multiple keys
        if (keys.length === 1) {
            return this.data.has(keys[0]) ? 1 : 0;
        }
        // Count how many exist
        return keys.filter(k => this.data.has(k)).length;
    }

    async zadd(key, score, member) {
        if (!this.data.has(key)) {
            this.data.set(key, new Map());
        }
        const sortedSet = this.data.get(key);
        sortedSet.set(member, score);
        return 1;
    }

    async zrangebyscore(key, min, max, ...args) {
        const sortedSet = this.data.get(key);
        if (!sortedSet || !(sortedSet instanceof Map)) {
            return [];
        }
        
        const results = [];
        for (const [member, score] of sortedSet.entries()) {
            if (score >= min && (max === '+inf' || score <= max)) {
                results.push(member);
            }
        }
        
        // Handle LIMIT
        const limitIndex = args.indexOf('LIMIT');
        if (limitIndex !== -1) {
            const offset = parseInt(args[limitIndex + 1]);
            const count = parseInt(args[limitIndex + 2]);
            return results.slice(offset, offset + count);
        }
        
        return results.sort((a, b) => sortedSet.get(a) - sortedSet.get(b));
    }

    async zcard(key) {
        const sortedSet = this.data.get(key);
        return sortedSet && sortedSet instanceof Map ? sortedSet.size : 0;
    }

    async rename(oldKey, newKey) {
        if (!this.data.has(oldKey)) {
            throw new Error('no such key');
        }
        const value = this.data.get(oldKey);
        this.data.delete(oldKey);
        this.data.set(newKey, value);
        return 'OK';
    }

    async lpush(key, ...values) {
        if (!this.data.has(key)) {
            this.data.set(key, []);
        }
        const list = this.data.get(key);
        list.unshift(...values);
        return list.length;
    }

    async lindex(key, index) {
        const list = this.data.get(key);
        if (!Array.isArray(list)) {
            return null;
        }
        return list[index] || null;
    }

    async smembers(key) {
        const set = this.data.get(key);
        if (!set || !(set instanceof Set)) {
            return [];
        }
        return Array.from(set);
    }

    async ping() {
        return 'PONG';
    }

    async eval(script, numKeys, ...args) {
        // Parse Lua script to check lock value and perform operation
        const key = args[0];
        const value = args[1];
        
        if (script.includes('del')) {
            // Release lock script
            const currentValue = this.data.get(key);
            if (currentValue === value) {
                this.data.delete(key);
                return 1;
            }
            return 0;
        } else if (script.includes('expire')) {
            // Extend lock script
            const currentValue = this.data.get(key);
            if (currentValue === value) {
                // In real Redis, expire would be set, but for mock we just return success
                return 1;
            }
            return 0;
        }
        
        return 1;
    }

    pipeline() {
        return {
            zadd: (key, score, member) => {
                this.pipelineCommands.push(['zadd', key, score, member]);
                return this;
            },
            exec: async () => {
                const results = [];
                for (const cmd of this.pipelineCommands) {
                    const [method, ...args] = cmd;
                    await this[method](...args);
                    results.push([null, 'OK']);
                }
                this.pipelineCommands = [];
                return results;
            }
        };
    }

    async quit() {
        return 'OK';
    }

    async disconnect() {
        return 'OK';
    }

    on() {
        // Mock event emitter
        return this;
    }
}

module.exports = {
    MockRedis
};

