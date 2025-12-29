'use strict';

describe('Utility Functions', () => {
    test('should convert IP to integer', () => {
        const ipTools = require('ip-utils');
        
        const ip = '10.0.0.1';
        const long = ipTools.toLong(ip);
        
        expect(long).toBe(167772161);
    });

    test('should validate IPv4 address', () => {
        const ipTools = require('ip-utils');
        
        expect(ipTools.isValidIpv4('10.0.0.1')).toBe(true);
        expect(ipTools.isValidIpv4('192.168.1.1')).toBe(true);
        expect(ipTools.isValidIpv4('256.1.1.1')).toBe(false);
        expect(ipTools.isValidIpv4('not.an.ip')).toBe(false);
    });

    test('should handle CIDR info', () => {
        const ipTools = require('ip-utils');
        
        const cidr = '10.0.0.0/24';
        const info = ipTools.cidrInfo(cidr);
        
        expect(info).toBeDefined();
        expect(info.firstHostAddress).toBeDefined();
        expect(info.lastHostAddress).toBeDefined();
    });

    test('should format dates correctly', () => {
        const { format } = require('date-fns');
        
        const date = new Date('2024-01-01T00:00:00Z');
        const formatted = format(date, 'yyyy-MM-dd HH:mm:ss');
        
        expect(formatted).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    });
});

