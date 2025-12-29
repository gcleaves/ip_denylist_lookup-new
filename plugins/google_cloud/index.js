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
 * Google Cloud IP ranges URLs
 */
const GOOGLE_CLOUD_IPS_URL = 'https://www.gstatic.com/ipranges/cloud.json';
const GOOGLE_SERVICES_IPS_URL = 'https://www.gstatic.com/ipranges/goog.json';

/**
 * Google Cloud IP list plugin
 * Downloads and processes IP ranges from Google Cloud Platform
 */
class GoogleCloudPlugin extends BasePlugin {
    /**
     * @param {Object} options - Plugin options
     * @param {string} options.outputFile - Output file path
     * @param {string} [options.cloudUrl] - Google Cloud IP ranges URL (defaults to GOOGLE_CLOUD_IPS_URL)
     * @param {string} [options.servicesUrl] - Google Services IP ranges URL (defaults to GOOGLE_SERVICES_IPS_URL)
     * @param {boolean} [options.includeServices=true] - Whether to include Google Services IPs
     */
    constructor(options = {}) {
        super({
            name: 'google_cloud',
            version: '1.0.0',
            description: 'Downloads and processes IP ranges from Google Cloud Platform',
            abortOnFail: options.abortOnFail !== false
        });
        this.outputFile = options.outputFile;
        this.cloudUrl = options.cloudUrl || GOOGLE_CLOUD_IPS_URL;
        this.servicesUrl = options.servicesUrl || GOOGLE_SERVICES_IPS_URL;
        this.includeServices = options.includeServices !== false;
        this._interval = null;
    }

    /**
     * Process IP prefixes from Google JSON data
     * @param {Object} data - JSON data from Google
     * @param {fs.WriteStream} writer - Write stream for output
     * @param {string} sourceType - Source type ('gcp' or 'google_services')
     * @returns {number} Number of processed prefixes
     */
    processPrefixes(data, writer, sourceType) {
        let processedCount = 0;
        const prefixes = data.prefixes || [];

        for (const prefix of prefixes) {
            if (!prefix.ipv4Prefix && !prefix.ipv4Prefixes) {
                // Skip IPv6-only prefixes
                continue;
            }

            const ipPrefixes = prefix.ipv4Prefixes || (prefix.ipv4Prefix ? [prefix.ipv4Prefix] : []);

            for (const ipPrefix of ipPrefixes) {
                try {
                    const cidrInfo = ip.cidrInfo(ipPrefix);
                    const meta = {
                        type: 'cloud',
                        provider: 'google',
                        scope: prefix.scope || 'unknown',
                        service: sourceType === 'gcp' ? 'gcp' : (prefix.service || 'google_services'),
                        source: sourceType
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
                    this.logger.warn({ ipPrefix, error: error.message }, 'Failed to process IP range');
                }
            }
        }

        return processedCount;
    }

    /**
     * Download and process Google Cloud IP ranges
     * @returns {Promise<boolean>}
     */
    async downloadAndProcess() {
        this.logger.info({ cloudUrl: this.cloudUrl, servicesUrl: this.includeServices ? this.servicesUrl : 'skipped' }, 'Starting download');

        const writer = fs.createWriteStream(this.outputFile, { flags: 'a' });
        let totalProcessed = 0;

        return new Promise(async (resolve, reject) => {
            writer.on('error', (err) => {
                reject(new Error(`Google Cloud write error: ${err.message}`));
            });

            try {
                // Download Google Cloud IP ranges
                const cloudResponse = await this.retryWithBackoff(async () => {
                    return await axios({
                        method: 'get',
                        url: this.cloudUrl,
                        responseType: 'json',
                        timeout: 30000,
                        headers: {
                            'User-Agent': 'IP-Denylist-Lookup/1.0'
                        }
                    });
                });

                const cloudData = cloudResponse.data;
                if (!cloudData) {
                    throw new Error('Invalid Google Cloud IP ranges JSON structure');
                }

                this.logger.info({ prefixCount: (cloudData.prefixes || []).length }, 'Downloaded Google Cloud IP ranges');
                const cloudProcessed = this.processPrefixes(cloudData, writer, 'gcp');
                totalProcessed += cloudProcessed;
                this.logger.info({ processed: cloudProcessed }, 'Processed Google Cloud IP ranges');

                // Download Google Services IP ranges if enabled
                if (this.includeServices) {
                    const servicesResponse = await this.retryWithBackoff(async () => {
                        return await axios({
                            method: 'get',
                            url: this.servicesUrl,
                            responseType: 'json',
                            timeout: 30000,
                            headers: {
                                'User-Agent': 'IP-Denylist-Lookup/1.0'
                            }
                        });
                    });

                    const servicesData = servicesResponse.data;
                    if (servicesData) {
                        this.logger.info({ prefixCount: (servicesData.prefixes || []).length }, 'Downloaded Google Services IP ranges');
                        const servicesProcessed = this.processPrefixes(servicesData, writer, 'google_services');
                        totalProcessed += servicesProcessed;
                        this.logger.info({ processed: servicesProcessed }, 'Processed Google Services IP ranges');
                    }
                }

                writer.end();
                writer.on('finish', () => {
                    this.logger.info({ totalProcessed }, 'Finished processing Google IP ranges');
                    resolve(true);
                });
            } catch (error) {
                writer.end();
                reject(new Error(`Google Cloud processing error: ${error.message}`));
            }
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
            this.logger.debug('Still working on google_cloud');
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

            return 'google_cloud';
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

module.exports = GoogleCloudPlugin;

