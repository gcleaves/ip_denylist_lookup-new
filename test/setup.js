'use strict';

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // Suppress logs during tests
process.env.REDIS_HOST = process.env.TEST_REDIS_HOST || 'localhost';
process.env.REDIS_PORT = process.env.TEST_REDIS_PORT || '6379';
process.env.REDIS_DB = process.env.TEST_REDIS_DB || '15'; // Use DB 15 for tests
process.env.IP_REDIS_PREFIX = 'test_ip_lists:';
process.env.IP_HTTP_PORT = '3001'; // Different port for tests

// Increase timeout for integration tests
jest.setTimeout(30000);

