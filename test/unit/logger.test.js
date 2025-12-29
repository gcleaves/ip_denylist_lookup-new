'use strict';

const logger = require('../../logger');
const { createLogger } = require('../../logger');

describe('Logger', () => {
    test('should create a logger instance', () => {
        expect(logger).toBeDefined();
        expect(typeof logger.info).toBe('function');
        expect(typeof logger.error).toBe('function');
        expect(typeof logger.warn).toBe('function');
        expect(typeof logger.debug).toBe('function');
    });

    test('should create logger with custom options', () => {
        const customLogger = createLogger({ level: 'debug' });
        expect(customLogger).toBeDefined();
    });

    test('should log at different levels', () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation();
        
        logger.info('test info');
        logger.error('test error');
        logger.warn('test warn');
        logger.debug('test debug');
        
        logSpy.mockRestore();
    });

    test('should log structured data', () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation();
        
        logger.info({ key: 'value' }, 'test message');
        
        logSpy.mockRestore();
    });

    test('should create child logger', () => {
        const childLogger = logger.child({ module: 'test' });
        expect(childLogger).toBeDefined();
        expect(typeof childLogger.info).toBe('function');
    });
});

