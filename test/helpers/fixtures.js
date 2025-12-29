'use strict';

/**
 * Test fixtures and sample data
 */
module.exports = {
    // Sample IP ranges for testing
    sampleRanges: [
        { start: 167772160, end: 167772415, list: 'test1' }, // 10.0.0.0 - 10.0.0.255
        { start: 167772416, end: 167772671, list: 'test2' }, // 10.0.1.0 - 10.0.1.255
    ],

    // Sample CSV data
    sampleCsv: `start_int|end_int|list
167772160|167772415|{"type":"list","name":"test1","source":"test"}
167772416|167772671|{"type":"list","name":"test2","source":"test"}`,

    // Sample IP addresses
    testIps: {
        valid: ['10.0.0.1', '192.168.1.1', '8.8.8.8'],
        invalid: ['256.1.1.1', 'not.an.ip', '10.0.0'],
        inRange: ['10.0.0.100', '10.0.1.50'],
        notInRange: ['192.168.1.1', '8.8.8.8']
    },

    // Sample plugin metadata
    pluginMetadata: {
        name: 'test-plugin',
        version: '1.0.0',
        description: 'Test plugin'
    }
};

