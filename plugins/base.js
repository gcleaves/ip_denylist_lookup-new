'use strict';

const logger = require('../logger');

/**
 * Base class for IP denylist plugins
 * All plugins should extend this class and implement required methods
 */
class BasePlugin {
    /**
     * @param {Object} options - Plugin options
     * @param {string} options.name - Plugin name (required)
     * @param {string} [options.version] - Plugin version
     * @param {string} [options.description] - Plugin description
     * @param {boolean} [options.abortOnFail=false] - Whether to abort on plugin failure
     */
    constructor(options = {}) {
        if (!options.name) {
            throw new Error('Plugin name is required');
        }

        this.name = options.name;
        this.version = options.version || '1.0.0';
        this.description = options.description || '';
        this.abortOnFail = options.abortOnFail || false;
        this.logger = logger.child({ plugin: this.name });
        this._initialized = false;
    }

    /**
     * Initialize the plugin (optional)
     * Called before load() is executed
     * @returns {Promise<void>}
     */
    async init() {
        this.logger.debug('Plugin init called');
        this._initialized = true;
    }

    /**
     * Load plugin data (required)
     * Must be implemented by subclasses
     * @returns {Promise<any>} Plugin load result
     * @throws {Error} If not implemented
     */
    async load() {
        throw new Error(`Plugin ${this.name} must implement load() method`);
    }

    /**
     * Validate plugin data (required)
     * Called after load() to validate the loaded data
     * @param {any} data - Data to validate
     * @returns {Promise<boolean>} True if valid
     */
    async validate(data) {
        this.logger.debug('Plugin validate called');
        return true;
    }

    /**
     * Health check for the plugin (optional)
     * @returns {Promise<Object>} Health status object
     */
    async healthCheck() {
        return {
            name: this.name,
            status: 'healthy',
            initialized: this._initialized
        };
    }

    /**
     * Cleanup plugin resources (optional)
     * Called when plugin is being unloaded
     * @returns {Promise<void>}
     */
    async cleanup() {
        this.logger.debug('Plugin cleanup called');
    }

    /**
     * Retry logic with exponential backoff
     * @param {Function} fn - Function to retry
     * @param {Object} options - Retry options
     * @param {number} [options.maxRetries=3] - Maximum number of retries
     * @param {number} [options.initialDelay=1000] - Initial delay in ms
     * @param {number} [options.maxDelay=10000] - Maximum delay in ms
     * @returns {Promise<any>} Function result
     */
    async retryWithBackoff(fn, options = {}) {
        const {
            maxRetries = 3,
            initialDelay = 1000,
            maxDelay = 10000
        } = options;

        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                if (attempt < maxRetries) {
                    const delay = Math.min(
                        initialDelay * Math.pow(2, attempt),
                        maxDelay
                    );
                    this.logger.warn(
                        { attempt: attempt + 1, maxRetries, delay, error: error.message },
                        'Retrying after error'
                    );
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        throw lastError;
    }

    /**
     * Get plugin metadata
     * @returns {Object} Plugin metadata
     */
    getMetadata() {
        return {
            name: this.name,
            version: this.version,
            description: this.description,
            abortOnFail: this.abortOnFail
        };
    }
}

module.exports = BasePlugin;

