'use strict';

const axios = require('axios');
const fs = require('fs');
const ip = require('ip-utils');
const util = require('util');
const BasePlugin = require('../base');

/**
 * Convert IP address to integer
 * @param {string} ip - IP address string
 * @returns {number} IP as integer
 */
function ip2int(ip) {
    return ip.split('.').reduce(function(ipInt, octet) { return (ipInt<<8) + parseInt(octet, 10)}, 0) >>> 0;
}

/**
 * Fastly IP ranges URL
 */
const FASTLY_IPS_URL = 'https://api.fastly.com/public-ip-list';

/**
 * Fastly IP list plugin
 * Downloads and processes IP ranges from Fastly CDN
 */
class FastlyPlugin extends BasePlugin {
    /**
     * @param {Object} options - Plugin options
     * @param {string} options.outputFile - Output file path
     * @param {string} [options.url] - Fastly IP ranges URL (defaults to FASTLY_IPS_URL)
     */
    constructor(options = {}) {
        super({
            name: 'fastly',
            version: '1.0.0',
            description: 'Downloads and processes IP ranges from Fastly CDN',
            abortOnFail: options.abortOnFail !== false
        });
        this.outputFile = options.outputFile;
        this.url = options.url || FASTLY_IPS_URL;
        this._interval = null;
    }

    /**
     * Download and process Fastly IP ranges
     * @returns {Promise<boolean>}
     */
    async downloadAndProcess() {
        this.logger.info({ url: this.url }, 'Starting download');

        return this.retryWithBackoff(async () => {
            const response = await axios({
                method: 'get',
                url: this.url,
                responseType: 'json',
                timeout: 30000,
                headers: {
                    'User-Agent': 'IP-Denylist-Lookup/1.0',
                    'Accept': 'application/json'
                }
            });

            const data = response.data;
            if (!data) {
                throw new Error('Invalid Fastly IP ranges JSON structure');
            }

            // Fastly API returns addresses array (IPv4) and ipv6_addresses array (IPv6)
            const addresses = data.addresses || [];
            const ipv6Addresses = data.ipv6_addresses || [];

            this.logger.info({ 
                ipv4Count: addresses.length, 
                ipv6Count: ipv6Addresses.length 
            }, 'Downloaded Fastly IP ranges');

            const writer = fs.createWriteStream(this.outputFile, { flags: 'a' });
            let processedCount = 0;

            return new Promise((resolve, reject) => {
                writer.on('error', (err) => {
                    reject(new Error(`Fastly write error: ${err.message}`));
                });

                try {
                    // Process IPv4 addresses
                    for (const address of addresses) {
                        try {
                            // Fastly returns CIDR notation or single IPs
                            const cidrInfo = ip.cidrInfo(address);
                            const meta = {
                                type: 'cdn',
                                provider: 'fastly',
                                source: 'fastly'
                            };

                            const metadata = JSON.stringify(meta);
                            // Quote the JSON field with ~ if it contains the delimiter |
                            const quotedMetadata = metadata.includes('|') ? `~${metadata}~` : metadata;

                            const format = `%s|%s|%s\n`;
                            const line = util.format(format,
                                Math.min(ip2int(cidrInfo.firstHostAddress), ip2int(cidrInfo.lastHostAddress)),
                                Math.max(ip2int(cidrInfo.firstHostAddress), ip2int(cidrInfo.lastHostAddress)),
                                quotedMetadata);

                            writer.write(line);
                            processedCount++;
                        } catch (error) {
                            this.logger.warn({ address, error: error.message }, 'Failed to process IP range');
                        }
                    }

                    // Log IPv6 addresses but skip processing (IPv4 only)
                    if (ipv6Addresses.length > 0) {
                        this.logger.debug({ ipv6Count: ipv6Addresses.length }, 'Skipping IPv6 addresses (IPv4 only)');
                    }

                    writer.end();
                    writer.on('finish', () => {
                        this.logger.info({ processed: processedCount }, 'Finished processing Fastly IP ranges');
                        resolve(true);
                    });
                } catch (error) {
                    writer.end();
                    reject(new Error(`Fastly processing error: ${error.message}`));
                }
            });
        });
    }

    /**
     * Load plugin data
     * @returns {Promise<string>} Plugin name
     */
    async load() {
        if (!this.outputFile) {
            throw new Error('outputFile is required');
        }

        this._interval = setInterval(() => {
            this.logger.debug('Still working on fastly');
        }, 5000).unref();

        try {
            // Delete output file if it exists
            try {
                fs.unlinkSync(this.outputFile);
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    this.logger.warn({ error: err.message }, "Can't delete output file");
                }
            }

            await this.downloadAndProcess();

            if (this._interval) {
                clearInterval(this._interval);
                this._interval = null;
            }

            return 'fastly';
        } catch (error) {
            if (this._interval) {
                clearInterval(this._interval);
                this._interval = null;
            }
            throw error;
        }
    }

    /**
     * Validate loaded data
     * @param {any} data - Data to validate
     * @returns {Promise<boolean>}
     */
    async validate(data) {
        if (!fs.existsSync(this.outputFile)) {
            this.logger.error('Output file does not exist');
            return false;
        }
        const stats = fs.statSync(this.outputFile);
        if (stats.size === 0) {
            this.logger.warn('Output file is empty');
            return false;
        }
        return true;
    }

    /**
     * Cleanup plugin resources
     * @returns {Promise<void>}
     */
    async cleanup() {
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
        await super.cleanup();
    }
}

module.exports = FastlyPlugin;

