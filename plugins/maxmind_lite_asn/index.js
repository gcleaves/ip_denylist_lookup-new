'use strict';

const axios = require('axios');
const path = require('path');
const fs = require('fs');
const csv = require('csv');
const ip = require('ip-utils');
const unzipper = require('unzipper');
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
 * MaxMind Lite ASN IP list plugin
 * Downloads and processes GeoLite2-ASN-CSV data from MaxMind
 */
class MaxmindLiteASNPlugin extends BasePlugin {
    /**
     * @param {Object} options - Plugin options
     * @param {string} options.outputFile - Output file path
     * @param {string} [options.apiKey] - MaxMind API key (defaults to reading from config.json)
     */
    constructor(options = {}) {
        super({
            name: 'maxmind_lite_asn',
            version: '1.0.0',
            description: 'Downloads and processes GeoLite2-ASN-CSV data from MaxMind',
            abortOnFail: options.abortOnFail !== false
        });
        this.outputFile = options.outputFile;
        this.apiKey = options.apiKey || this._loadApiKey();
        this.zipFile = path.join(__dirname, `${this.name}.zip`);
        this._interval = null;
    }

    /**
     * Load API key from config.json
     * @returns {string} API key
     * @private
     */
    _loadApiKey() {
        try {
            const config = require('./config.json');
            return config.apiKey;
        } catch (error) {
            throw new Error('MaxMind API key not found. Please provide apiKey option or create config.json with apiKey field.');
        }
    }

    /**
     * Download MaxMind GeoLite2-ASN-CSV zip file
     * @returns {Promise<void>}
     * @private
     */
    async _downloadMaxmind() {
        this.logger.info('Downloading MaxMind GeoLite2-ASN-CSV');
        const writer = fs.createWriteStream(this.zipFile);
        
        return this.retryWithBackoff(async () => {
            const response = await axios({
                method: 'get',
                url: `https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-ASN-CSV&license_key=${this.apiKey}&suffix=zip`,
                responseType: 'stream',
                timeout: 300000 // 5 minutes
            });
            
            response.data.pipe(writer);

            return new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
        });
    }

    /**
     * Extract required files from zip
     * @returns {Promise<void>}
     * @private
     */
    async _extract() {
        this.logger.info('Extracting MaxMind zip file');
        return new Promise((resolve, reject) => {
            fs.createReadStream(this.zipFile)
                .pipe(unzipper.Parse())
                .on('entry', (entry) => {
                    const fileName = entry.path;
                    if (/GeoLite2-ASN-Blocks-IPv4/.test(fileName)) {
                        const basename = path.basename(fileName);
                        this.logger.debug({ fileName }, 'Extracting file');
                        entry.pipe(fs.createWriteStream(path.join(__dirname, basename)));
                    } else {
                        entry.autodrain();
                    }
                })
                .on('close', () => resolve())
                .on('error', reject);
        });
    }

    /**
     * Process IP ranges and write to output file
     * @returns {Promise<string>} Plugin name
     * @private
     */
    async _processRanges() {
        this.logger.info('Processing ASN ranges');
        const fileName = path.join(__dirname, 'GeoLite2-ASN-Blocks-IPv4.csv');
        const readStream = fs.createReadStream(fileName);
        const writeStream = fs.createWriteStream(this.outputFile);
        const csvStream = csv.parse({ delimiter: ',', columns: true });

        return new Promise((resolve, reject) => {
            let processedCount = 0;
            
            csvStream.on('data', (r) => {
                processedCount++;
                if (!(processedCount % 100000)) {
                    this.logger.debug({ processed: processedCount }, 'Processing ranges');
                }
                
                try {
                    const cidrInfo = ip.cidrInfo(r.network);
                    const asn = r.autonomous_system_organization;
                    const meta = {
                        type: 'asn',
                        name: asn,
                        source: 'maxmind_lite'
                    };

                    const metadata = JSON.stringify(meta);
                    // Quote the JSON field with ~ if it contains the delimiter |
                    const quotedMetadata = metadata.includes('|') ? `~${metadata}~` : metadata;
                    const line = `${Math.min(ip2int(cidrInfo.firstHostAddress), ip2int(cidrInfo.lastHostAddress))}|${Math.max(ip2int(cidrInfo.firstHostAddress), ip2int(cidrInfo.lastHostAddress))}|${quotedMetadata}\n`;

                    writeStream.write(line);
                } catch (error) {
                    this.logger.warn({ network: r.network, error: error.message }, 'Failed to process range');
                }
            }).on('end', () => {
                this.logger.info({ processed: processedCount }, 'Range processing complete');
                writeStream.end();
                resolve(this.name);
            }).on('error', (error) => {
                this.logger.error({ error: error.message }, 'Error processing ranges');
                reject(new Error(`${this.name} failed: ${error.message}`));
            });
            
            readStream.pipe(csvStream);
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
        if (!this.apiKey) {
            throw new Error('MaxMind API key is required');
        }

        this._interval = setInterval(() => {
            this.logger.debug('Still working on maxmind_lite_asn');
        }, 5000).unref();

        try {
            await this._downloadMaxmind();
            await this._extract();
            return await this._processRanges();
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
        
        // Clean up extracted files
        const filesToClean = [
            'GeoLite2-ASN-Blocks-IPv4.csv',
            `${this.name}.zip`
        ];
        
        for (const file of filesToClean) {
            const filePath = path.join(__dirname, file);
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    this.logger.debug({ file }, 'Cleaned up temporary file');
                }
            } catch (error) {
                this.logger.warn({ file, error: error.message }, 'Failed to clean up file');
            }
        }
        
        await super.cleanup();
    }
}

module.exports = MaxmindLiteASNPlugin;
