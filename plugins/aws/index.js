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
 * AWS IP ranges URL
 */
const AWS_IP_RANGES_URL = 'https://ip-ranges.amazonaws.com/ip-ranges.json';

/**
 * AWS IP list plugin
 * Downloads and processes IP ranges from AWS
 */
class AWSPlugin extends BasePlugin {
    /**
     * @param {Object} options - Plugin options
     * @param {string} options.outputFile - Output file path
     * @param {string} [options.url] - AWS IP ranges URL (defaults to AWS_IP_RANGES_URL)
     */
    constructor(options = {}) {
        super({
            name: 'aws',
            version: '1.0.0',
            description: 'Downloads and processes IP ranges from AWS',
            abortOnFail: options.abortOnFail !== false
        });
        this.outputFile = options.outputFile;
        this.url = options.url || AWS_IP_RANGES_URL;
        this._interval = null;
    }

    /**
     * Download and process AWS IP ranges
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
                    'User-Agent': 'IP-Denylist-Lookup/1.0'
                }
            });

            const data = response.data;
            if (!data || !data.prefixes || !Array.isArray(data.prefixes)) {
                throw new Error('Invalid AWS IP ranges JSON structure');
            }

            this.logger.info({ prefixCount: data.prefixes.length }, 'Downloaded AWS IP ranges');

            const writer = fs.createWriteStream(this.outputFile, { flags: 'a' });
            let processedCount = 0;

            return new Promise((resolve, reject) => {
                writer.on('error', (err) => {
                    reject(new Error(`AWS write error: ${err.message}`));
                });

                try {
                    for (const prefix of data.prefixes) {
                        if (!prefix.ip_prefix) {
                            continue;
                        }

                        try {
                            const cidrInfo = ip.cidrInfo(prefix.ip_prefix);
                            const meta = {
                                type: 'cloud',
                                provider: 'aws',
                                service: prefix.service || 'unknown',
                                region: prefix.region || 'unknown',
                                networkBorderGroup: prefix.network_border_group || null,
                                source: 'aws'
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
                            this.logger.warn({ ip_prefix: prefix.ip_prefix, error: error.message }, 'Failed to process IP range');
                        }
                    }

                    // Handle IPv6 prefixes if present
                    if (data.ipv6_prefixes && Array.isArray(data.ipv6_prefixes)) {
                        this.logger.debug({ ipv6Count: data.ipv6_prefixes.length }, 'Skipping IPv6 prefixes (IPv4 only)');
                    }

                    writer.end();
                    writer.on('finish', () => {
                        this.logger.info({ processed: processedCount }, 'Finished processing AWS IP ranges');
                        resolve(true);
                    });
                } catch (error) {
                    writer.end();
                    reject(new Error(`AWS processing error: ${error.message}`));
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
            this.logger.debug('Still working on aws');
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

            return 'aws';
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

module.exports = AWSPlugin;

