'use strict';

const path = require('path');
const FireholPlugin = require('./plugins/firehol');
const SpamhausPlugin = require('./plugins/spamhaus');
const CloudflarePlugin = require('./plugins/cloudflare');
const AWSPlugin = require('./plugins/aws');
const GoogleCloudPlugin = require('./plugins/google_cloud');
const FastlyPlugin = require('./plugins/fastly');
// const example = require('ip_denylist_plugin_example');
// const udger = require('ip_denylist_plugin_udger');
// const udgerStale = require('ip_denylist_plugin_udger_stale');
const MaxmindLiteCityPlugin = require('./plugins/maxmind_lite_city');
const MaxmindLiteASNPlugin = require('./plugins/maxmind_lite_asn');

/**
 * Create plugin wrapper for backward compatibility
 * @param {BasePlugin} pluginInstance - Plugin instance
 * @returns {Object} Plugin wrapper object
 */
function createPluginWrapper(pluginInstance) {
    return {
        name: pluginInstance.name,
        abortOnFail: pluginInstance.abortOnFail,
        async load() {
            await pluginInstance.init();
            const result = await pluginInstance.load();
            await pluginInstance.validate(result);
            return result;
        },
        getMetadata: () => pluginInstance.getMetadata(),
        healthCheck: () => pluginInstance.healthCheck(),
        cleanup: () => pluginInstance.cleanup()
    };
}

module.exports = [
    // {
    //     name: 'example',
    //     load() {
    //         return example(path.join(__dirname,'staging','example.data.txt'))
    //     },
    //     abortOnFail: false
    // },
    // {
    //     name: 'udger',
    //     load() {
    //         return udger(path.join(__dirname,'staging','udger.data.txt'))
    //     },
    //     abortOnFail: false
    // },
    // {
    //     name: 'udgerStale',
    //     load() {
    //         return udgerStale(path.join(__dirname,'staging','udger_stale.data.txt'))
    //     },
    //     abortOnFail: true
    // },
    // {
    //     name: 'maxmindLiteCity',
    //     load() {
    //         return maxmindLiteCity(path.join(__dirname,'staging','maxmind_lite_city.data.txt'))
    //     },
    //     abortOnFail: false
    // },
    // {
    //    name: 'maxmindLiteASN',
    //    load() {
    //        return maxmindLiteASN(path.join(__dirname,'staging','maxmind_lite_asn.data.txt'))
    //     },
    //     abortOnFail: false
    // },
    createPluginWrapper(new FireholPlugin({
        outputFile: path.join(__dirname,'staging','firehol.data.txt'),
        // listArray omitted - uses default lists from plugin
        // Can override with: listArray: ['custom', 'urls']
        abortOnFail: true
    })),
    createPluginWrapper(new SpamhausPlugin({
        outputFile: path.join(__dirname,'staging','spamhaus.data.txt'),
        // listArray omitted - uses default lists from plugin
        // Can override with: listArray: ['custom', 'urls']
        abortOnFail: false
    })),
    createPluginWrapper(new CloudflarePlugin({
        outputFile: path.join(__dirname,'staging','cloudflare.data.txt'),
        abortOnFail: false
    })),
    createPluginWrapper(new AWSPlugin({
        outputFile: path.join(__dirname,'staging','aws.data.txt'),
        abortOnFail: false
    })),
    createPluginWrapper(new GoogleCloudPlugin({
        outputFile: path.join(__dirname,'staging','google_cloud.data.txt'),
        abortOnFail: false
    })),
    createPluginWrapper(new FastlyPlugin({
        outputFile: path.join(__dirname,'staging','fastly.data.txt'),
        abortOnFail: false
    })),
    createPluginWrapper(new MaxmindLiteCityPlugin({
        outputFile: path.join(__dirname,'staging','maxmind_lite_city.data.txt'),
        abortOnFail: false
    })),
    createPluginWrapper(new MaxmindLiteASNPlugin({
        outputFile: path.join(__dirname,'staging','maxmind_lite_asn.data.txt'),
        abortOnFail: false
    }))
];
