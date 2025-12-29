'use strict';

const axios = require('axios');
const fs = require('fs');
const readline = require('readline');
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
 * Cloudflare IP list URL
 */
const CLOUDFLARE_IPS_URL = 'https://www.cloudflare.com/ips-v4/';

/**
 * Cloudflare IP list plugin
 * Downloads and processes IP ranges from Cloudflare
 */
class CloudflarePlugin extends BasePlugin {
    /**
     * @param {Object} options - Plugin options
     * @param {string} options.outputFile - Output file path
     * @param {string} [options.url] - Cloudflare IPs URL (defaults to CLOUDFLARE_IPS_URL)
     */
    constructor(options = {}) {
        super({
            name: 'cloudflare',
            version: '1.0.0',
            description: 'Downloads and processes IP ranges from Cloudflare',
            abortOnFail: options.abortOnFail !== false
        });
        this.outputFile = options.outputFile;
        this.url = options.url || CLOUDFLARE_IPS_URL;
        this._interval = null;
    }

    /**
     * Download Cloudflare IP ranges
     * @param {fs.WriteStream} writer - Write stream for output
     * @returns {Promise<boolean>}
     */
    async downloadFile(writer) {
        this.logger.info({ url: this.url }, 'Starting download');
        const meta = {
            type: "list",
            name: "cloudflare",
            source: "cloudflare"
        };
        const metadata = JSON.stringify(meta);
        // Quote the JSON field with ~ if it contains the delimiter |
        const quotedMetadata = metadata.includes('|') ? `~${metadata}~` : metadata;

        return this.retryWithBackoff(async () => {
            const response = await axios({
                method: 'get',
                url: this.url,
                responseType: 'stream',
                timeout: 30000,
                headers: {
                    'User-Agent': 'IP-Denylist-Lookup/1.0'
                }
            });

            return new Promise((resolve, reject) => {
                let error = null;
                let lineCount = 0;
                readline.createInterface({
                    input: response.data
                }).on('line', data => {
                    // Skip empty lines
                    if (!data || data.trim().length === 0) return;
                    
                    // Skip comment lines
                    const trimmed = data.trim();
                    if (trimmed[0] === '#' || trimmed[0] === ';') return;
                    
                    // Extract IP/CIDR part (remove any trailing comments or whitespace)
                    const ipPart = trimmed.split(/[;\s#]/)[0].trim();
                    
                    // Skip if no valid IP/CIDR found
                    if (!ipPart || ipPart.length === 0) return;
                    
                    // Validate it looks like an IP or CIDR
                    if (!ipPart.match(/^[\d\.\/]+$/)) return;
                    
                    try {
                        let line;
                        const format = `%s|%s|%s\n`;
                        if (ipPart.includes('/')) {
                            const cidrInfo = ip.cidrInfo(ipPart);
                            line = util.format(format, 
                                Math.min(ip2int(cidrInfo.firstHostAddress), ip2int(cidrInfo.lastHostAddress)),
                                Math.max(ip2int(cidrInfo.firstHostAddress), ip2int(cidrInfo.lastHostAddress)), 
                                quotedMetadata);
                        } else {
                            // Single IP address
                            line = util.format(format, ip2int(ipPart), ip2int(ipPart), quotedMetadata);
                        }
                        writer.write(line);
                        lineCount++;
                    } catch (error) {
                        this.logger.warn({ ipPart, error: error.message }, 'Failed to process IP range');
                    }
                }).on('error', (e) => {
                    error = e;
                    writer.close();
                    reject(new Error(`cloudflare failure: ${e.message}`));
                }).on('close', () => {
                    if (!error) {
                        this.logger.info({ url: this.url, lineCount }, 'Finished download');
                        resolve(true);
                    }
                });
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
            this.logger.debug('Still working on cloudflare');
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

            return new Promise(async (resolve, reject) => {
                const writer = fs.createWriteStream(this.outputFile, { flags: 'a' });
                
                writer.on('close', () => {
                    this.logger.info('Cloudflare writer closed');
                    if (this._interval) {
                        clearInterval(this._interval);
                        this._interval = null;
                    }
                    resolve("cloudflare");
                });
                
                writer.on('error', (err) => {
                    if (this._interval) {
                        clearInterval(this._interval);
                        this._interval = null;
                    }
                    this.logger.error({ error: err.message }, 'Cloudflare writer error');
                    reject(new Error("cloudflare failed"));
                });

                try {
                    await this.downloadFile(writer);
                    writer.close();
                } catch (e) {
                    writer.close();
                    reject(new Error(`cloudflare failure: ${e.message}`));
                }
            });
        } finally {
            if (this._interval) {
                clearInterval(this._interval);
                this._interval = null;
            }
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

module.exports = CloudflarePlugin;

