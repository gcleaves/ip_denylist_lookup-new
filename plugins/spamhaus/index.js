'use strict';

const axios = require('axios');
const fs = require('fs');
const readline = require('readline');
const ip = require('ip-utils');
const path = require('path');
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
 * Default Spamhaus list URLs
 * Note: edrop.txt has been merged into drop.txt
 */
const DEFAULT_SPAMHAUS_LISTS = [
    'https://www.spamhaus.org/drop/drop.txt'
];

/**
 * Spamhaus IP list plugin
 * Downloads and processes IP lists from Spamhaus DROP
 */
class SpamhausPlugin extends BasePlugin {
    /**
     * @param {Object} options - Plugin options
     * @param {string} options.outputFile - Output file path
     * @param {string[]} [options.listArray] - Array of Spamhaus list URLs (defaults to DEFAULT_SPAMHAUS_LISTS)
     */
    constructor(options = {}) {
        super({
            name: 'spamhaus',
            version: '1.0.0',
            description: 'Downloads and processes IP lists from Spamhaus DROP',
            abortOnFail: options.abortOnFail !== false
        });
        this.outputFile = options.outputFile;
        this.listArray = options.listArray || DEFAULT_SPAMHAUS_LISTS;
        this._interval = null;
    }

    /**
     * Download a single file from Spamhaus
     * @param {string} fileUrl - URL to download
     * @param {fs.WriteStream} writer - Write stream for output
     * @param {string} tag - Tag name for the list (e.g., "drop" or "edrop")
     * @returns {Promise<boolean>}
     */
    async downloadFile(fileUrl, writer, tag) {
        this.logger.info({ url: fileUrl, tag }, 'Starting download');
        const meta = {
            type: "list",
            name: tag,
            source: "spamhaus"
        };
        const metadata = JSON.stringify(meta);

        return this.retryWithBackoff(async () => {
            const response = await axios({
                method: 'get',
                url: fileUrl,
                responseType: 'stream',
                timeout: 30000,
                headers: {
                    'User-Agent': 'IP-Denylist-Lookup/1.0'
                }
            });

            return new Promise((resolve, reject) => {
                let error = null;
                readline.createInterface({
                    input: response.data
                }).on('line', data => {
                    // Skip empty lines
                    if (!data || data.trim().length === 0) return;
                    
                    // Skip comment lines (Spamhaus uses ; or # for comments at start of line)
                    const trimmed = data.trim();
                    if (trimmed[0] === ';' || trimmed[0] === '#') return;
                    
                    // Extract IP/CIDR part (before semicolon or space, which may have comments after)
                    // Format: "1.10.16.0/20 ; SBL256894" or "1.19.0.0/16 ; SBL434604"
                    const ipPart = trimmed.split(/[;\s]/)[0].trim();
                    
                    // Skip if no valid IP/CIDR found
                    if (!ipPart || ipPart.length === 0) return;
                    
                    // Validate it looks like an IP or CIDR
                    if (!ipPart.match(/^[\d\.\/]+$/)) return;
                    
                    let line;
                    const format = `%s|%s|%s\n`;
                    
                    if (ipPart.includes('/')) {
                        // CIDR block
                        try {
                            const cidrInfo = ip.cidrInfo(ipPart);
                            line = util.format(format, 
                                Math.min(ip2int(cidrInfo.firstHostAddress), ip2int(cidrInfo.lastHostAddress)),
                                Math.max(ip2int(cidrInfo.firstHostAddress), ip2int(cidrInfo.lastHostAddress)), 
                                metadata);
                        } catch (e) {
                            this.logger.warn({ line: ipPart, error: e.message }, 'Failed to parse CIDR');
                            return; // Skip invalid CIDR
                        }
                    } else {
                        // Single IP address
                        try {
                            if (!ip.isValidIpv4(ipPart)) {
                                this.logger.warn({ ip: ipPart }, 'Invalid IP address, skipping');
                                return;
                            }
                            line = util.format(format, ip2int(ipPart), ip2int(ipPart), metadata);
                        } catch (e) {
                            this.logger.warn({ line: ipPart, error: e.message }, 'Failed to parse IP');
                            return; // Skip invalid IP
                        }
                    }
                    writer.write(line);
                }).on('error', (e) => {
                    error = e;
                    writer.close();
                    reject(new Error(`spamhaus failure: ${e.message}`));
                }).on('close', () => {
                    if (!error) {
                        this.logger.info({ url: fileUrl, tag }, 'Finished download');
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
        if (!this.listArray || this.listArray.length === 0) {
            throw new Error('listArray is required');
        }

        this._interval = setInterval(() => {
            this.logger.debug('Still working on spamhaus');
        }, 5000);

        try {
            fs.unlinkSync(this.outputFile);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                this.logger.warn({ error: err.message }, "Can't delete output file");
            }
        }

        return new Promise(async (resolve, reject) => {
            const writer = fs.createWriteStream(this.outputFile, {flags:'a'});
            
            writer.on('close', () => {
                this.logger.info('Spamhaus writer closed');
                if (this._interval) {
                    clearInterval(this._interval);
                    this._interval = null;
                }
                resolve("spamhaus");
            });
            
            writer.on('error', (err) => {
                if (this._interval) {
                    clearInterval(this._interval);
                    this._interval = null;
                }
                this.logger.error({ error: err.message }, 'Spamhaus writer error');
                reject(new Error("spamhaus failed"));
            });

            try {
                // Download all lists in parallel
                await Promise.all(
                    this.listArray.map(f => {
                        // Extract list name from URL (drop or edrop)
                        const urlParts = f.split('/');
                        const filename = urlParts[urlParts.length - 1];
                        const tag = filename.replace(/\.txt$/, '').toLowerCase();
                        return this.downloadFile(f, writer, tag);
                    })
                );
                writer.close();
            } catch (e) {
                writer.close();
                reject(new Error(`spamhaus failure: ${e.message}`));
            }
        });
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

// Export both class and legacy function for backward compatibility
module.exports = SpamhausPlugin;

// Legacy export for backward compatibility
module.exports.legacy = async (outputFile, listArray) => {
    const plugin = new SpamhausPlugin({ outputFile, listArray });
    await plugin.init();
    const result = await plugin.load();
    await plugin.validate(result);
    return result;
};

