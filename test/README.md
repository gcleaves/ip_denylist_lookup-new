# Test Suite

This directory contains comprehensive tests for the IP Denylist Lookup service.

## Test Structure

```
test/
├── setup.js                 # Jest setup and configuration
├── helpers/                 # Test utilities and helpers
│   ├── redis.js            # Redis test helpers
│   ├── fixtures.js         # Test data fixtures
│   └── mocks.js            # Mock implementations
├── unit/                    # Unit tests
│   ├── logger.test.js
│   ├── config.test.js
│   ├── updateLock.test.js
│   ├── plugins/
│   │   └── base.test.js
│   └── utils.test.js
└── integration/             # Integration tests
    ├── redis.test.js
    ├── api.test.js
    ├── websocket.test.js
    └── updateProcess.test.js
```

## Running Tests

### All Tests
```bash
npm test
```

### Unit Tests Only
```bash
npm run test:unit
```

### Integration Tests Only
```bash
npm run test:integration
```

### Watch Mode
```bash
npm run test:watch
```

### Coverage Report
```bash
npm run test:coverage
```

### CI Mode
```bash
npm run test:ci
```

## Test Requirements

### Unit Tests
- No external dependencies required
- Run fast and in isolation
- Use mocks for external services

### Integration Tests
- Require Redis to be running
- Use test database (DB 15 by default)
- Can be skipped if Redis is unavailable

### Environment Variables for Testing

```bash
# Redis configuration for tests
TEST_REDIS_HOST=localhost
TEST_REDIS_PORT=6379
TEST_REDIS_DB=15
TEST_REDIS_PASS=

# Test port (default: 3001)
TEST_HTTP_PORT=3001
```

## Test Coverage

The test suite covers:

### Unit Tests
- ✅ Logger module
- ✅ Config module with validation
- ✅ Update lock mechanism
- ✅ Plugin base class
- ✅ Utility functions

### Integration Tests
- ✅ Redis operations (CRUD, pipelines, atomic operations)
- ✅ HTTP API endpoints (GET, POST, health check)
- ✅ WebSocket server (lookup, batch, ping)
- ✅ Update process (locking, status tracking, file operations)

## Writing New Tests

### Unit Test Example
```javascript
describe('MyModule', () => {
    test('should do something', () => {
        expect(true).toBe(true);
    });
});
```

### Integration Test Example
```javascript
describe('MyIntegration', () => {
    let redis;
    
    beforeAll(async () => {
        redis = createTestRedis();
        await redis.ping();
    });
    
    afterAll(async () => {
        await cleanupTestRedis();
        await redis.quit();
    });
    
    test('should integrate with Redis', async () => {
        // Test code
    });
});
```

## Notes

- Integration tests are skipped automatically if Redis is not available
- Tests use a separate Redis database (DB 15) to avoid conflicts
- Test data is cleaned up after each test run
- WebSocket tests require a running server instance

