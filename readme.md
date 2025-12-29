# IP DENY LIST LOOKUP

A high-performance IP denylist lookup service that downloads IP lists from [firehol](https://iplists.firehol.org/) and other sources, processes them into unique non-overlapping ranges while maintaining the list name each IP belongs to, uploads ranges to Redis, and serves HTTP/WebSocket endpoints to query IP addresses. The service periodically refreshes lists according to a configurable schedule.

## Overview

I wanted to be able to look up an IP address to know how risky it is. Firehol curates a list of suspicious IP addresses. There are two difficulties: a) keeping track of which list the IP address belongs to and b) making the lookup fast. A traditional database is not apt because the need is to search `where $ip is between start_ip_range and end_ip_range` which can't be optimized with a DB index. Some lookups were taking 7s when attempting the above with MySql. Sqlite is faster but still 100s of ms.

Digging into the Internet suggested that breaking the IP ranges into non-overlapping unique ranges and using a skip list was the way to go. This is what I have attempted to do (using Redis) and lookups now take 3ms, max. I think it works correctly. See bottom of page for more info on how this was accomplished.

## Features

- **High Performance**: Sub-3ms IP lookups using Redis sorted sets
- **WebSocket Support**: Real-time IP lookups via WebSocket protocol
- **Rate Limiting**: Configurable rate limiting for HTTP and WebSocket endpoints
- **Structured Logging**: Pino-based structured logging for better observability
- **Plugin Architecture**: Extensible plugin system for adding custom IP list sources
- **Health Checks**: Built-in health check endpoint for monitoring
- **Modern Node.js**: Built on Node.js 20 LTS with modern patterns
- **Robust Update Process**: 
  - Distributed locking prevents concurrent updates
  - Atomic file operations prevent data corruption
  - CSV validation before loading
  - Update status tracking and monitoring
  - Automatic error recovery and cleanup

## Install

1. Clone repo
2. `cd` into directory
3. `npm install`

## Testing

The project includes a comprehensive test suite with unit and integration tests.

### Running Tests

```bash
# Run all tests
npm test

# Run only unit tests
npm run test:unit

# Run only integration tests
npm run test:integration

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage
```

### Test Requirements

- **Unit Tests**: No external dependencies, run fast
- **Integration Tests**: Require Redis running (uses test database DB 15)

See [test/README.md](test/README.md) for detailed testing documentation.

## Configuration

The service uses environment variables for configuration. Create a `.env` file (see `.env.example` for reference) or set environment variables:

### Redis Configuration
- `REDIS_HOST` - Redis host (default: `localhost`)
- `REDIS_PORT` - Redis port (default: `6379`)
- `REDIS_IP_FAMILY` - IP family: `4` for IPv4 or `6` for IPv6 (default: `4`)
- `REDIS_PASS` - Redis password (optional)
- `REDIS_DB` - Redis database number (default: `0`)

### Application Configuration
- `IP_REDIS_PREFIX` - Redis key prefix (default: `ip_lists:`)
- `IP_DOWNLOAD_LOCATION` - Location for downloaded IP file (default: `./ipFile`)
- `IP_COLLECT_GARBAGE` - Enable garbage collection during load (default: `false`)
- `IP_HTTP_PORT` - HTTP server port (default: `3000`)
- `IP_PREFIX` - URL prefix for routes (default: `/`)
- `IP_CRON` - Cron schedule for refreshing lists (default: `5 2 * * *`)
- `IP_CRON_TIMEZONE` - Timezone for cron schedule (default: `UTC`). Use IANA timezone names like `Europe/Madrid`, `America/New_York`, etc.

### Logging Configuration
- `LOG_LEVEL` - Log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace` (default: `info`)
- `LOG_PRETTY` - Enable pretty printing for development (default: `false`)
- `NODE_ENV` - Environment: `development`, `production`, `test` (default: `production`)

### Rate Limiting Configuration
- `RATE_LIMIT_WINDOW_MS` - Rate limit window in milliseconds (default: `60000` = 1 minute)
- `RATE_LIMIT_MAX_REQUESTS` - Max requests per window per IP (default: `1000`)
- `RATE_LIMIT_WS_MAX_MESSAGES` - Max WebSocket messages per window per connection (default: `5000`)

### WebSocket Configuration
- `WS_ENABLED` - Enable WebSocket server (default: `true`)

### Health Check Configuration
- `HEALTH_CHECK_ENABLED` - Enable health check endpoint (default: `true`)

## Run Standalone Script

1. Set any necessary environment variables (see Configuration section above)
2. Edit plugin configuration in `plugins.js` if needed
3. Place any additional lists into the `./staging` folder
4. Run: `NODE_OPTIONS=--max_old_space_size=4096 node --expose-gc launch.js`

### Command-Line Options

The `launch.js` script supports the following command-line flags to control which operations are performed:

- `--download` - Download IP lists from configured plugins and write to staging folder (default: `true`)
- `--process` - Process staged files from `./staging` folder into a single CSV file (default: `true`)
- `--load` - Load the CSV file into Redis (default: `true`)
- `--serve` - Start the HTTP/WebSocket server (default: `true`)

**Operation Flow:**
1. **Download**: Runs plugins to download IP lists and write them to the `./staging` folder
2. **Process**: Concatenates all files from `./staging` into a single CSV file
3. **Load**: Reads the CSV file and loads IP ranges into Redis
4. **Serve**: Starts the HTTP/WebSocket server for IP lookups

**Important Notes:**
- All flags default to `true`, so use `--no-<flag>` or `--<flag> false` to disable operations
- `--process false` only prevents creating/updating the CSV file; it does **not** prevent loading
- To skip loading, you must also pass `--load false` or `--no-load`
- If `--process false` but `--load true`, the load step will process whatever CSV file already exists

**Examples:**

```bash
# Run all operations (default behavior)
node launch.js

# Only download and process, don't load or serve
node launch.js --no-load --no-serve

# Only start the server (assumes data already loaded)
node launch.js --no-download --no-process --no-load

# Download and process only, skip loading and serving
node launch.js --no-load --no-serve

# Skip download and process, but still load existing CSV and serve
node launch.js --no-download --no-process

# Skip download, process, and load - only start server
node launch.js --no-download --no-process --no-load
```

**Note:** The script will run the update process once on startup, then continue running the server (if `--serve` is enabled) and execute scheduled updates according to the configured cron schedule.

## Run with Docker

1. Edit `docker-compose.yml` as needed
2. `docker-compose up`

## API Documentation

### HTTP Endpoints

#### GET `/health`
Health check endpoint. Returns service status, Redis connection status, and update process information.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "redis": "connected",
  "update": {
    "inProgress": false,
    "status": "completed",
    "lastUpdate": "2024-01-01 02:05:00",
    "dataSize": 1234567
  }
}
```

**Status Values:**
- `healthy` - Service is operating normally
- `degraded` - Service is running but last update failed
- `unhealthy` - Redis connection failed

**Update Status Values:**
- `in_progress` - Update is currently running
- `completed` - Last update completed successfully
- `failed` - Last update failed
- `skipped` - Update was skipped (e.g., lock already held)
- `unknown` - No update status available

#### GET `/myip`
Lookup the requesting client's IP address.

**Query Parameters:**
- `csv` - Return CSV format (set to `1`, `true`, or `'true'`)
- `header` - Include CSV header (default: `true`, set to `0` or `false` to disable)

**Response:**
```json
{
  "ip": "192.168.1.1",
  "result": {
    "list": [
      {
        "name": "firehol_level1",
        "source": "firehol"
      }
    ]
  }
}
```

#### GET `/:ip`
Lookup a specific IP address.

**Path Parameters:**
- `ip` - IPv4 address to lookup

**Query Parameters:**
- `csv` - Return CSV format (set to `1`, `true`, or `'true'`)
- `header` - Include CSV header (default: `true`)

**Response:**
```json
{
  "list": [
    {
      "name": "firehol_level1",
      "source": "firehol"
    }
  ]
}
```

**Status Codes:**
- `200` - IP found
- `404` - IP not found in any list
- `422` - Invalid IPv4 address

#### POST `/`
Batch lookup multiple IP addresses.

**Request Body:**
- JSON array: `["192.168.1.1", "10.0.0.1"]` (with `Content-Type: application/json`)
- Text: Comma or newline-separated IPs (with any other `Content-Type` or no `Content-Type`)

**Query Parameters:**
- `json` - Return JSON format (set to `1`, `true`, or `'true'`). When set, response will be JSON regardless of request `Content-Type`
- `header` - Include CSV header when returning CSV format (default: `true`, set to `0` or `false` to disable)

**Response Format:**
- **JSON** (default when `Content-Type: application/json` or `?json=true`):
```json
{
  "192.168.1.1": {
    "list": [...]
  },
  "10.0.0.1": {}
}
```

- **CSV** (default when posting plain text without `?json=true`):
```csv
ip,list,country
192.168.1.1,firehol_level1|spamhaus_drop,
10.0.0.1,,
```

**Examples:**
- POST plain text with `?json=true` → JSON response
- POST JSON array → JSON response (default)
- POST plain text without `?json=true` → CSV response (default)

#### POST `/upload`
Upload a file containing IP addresses for batch lookup.

**Request:**
- Multipart form data with field `ipList`
- File can be `.json` (JSON array) or text (comma/newline-separated)

**Response:**
- Returns results in same format as uploaded file (JSON or CSV)

### WebSocket API

Connect to `ws://localhost:3000/ws` (or your configured prefix + `/ws`).

#### Message Protocol

**Client → Server:**

1. **Lookup single IP:**
```json
{
  "type": "lookup",
  "ip": "192.168.1.1",
  "requestId": "optional-request-id"
}
```

2. **Batch lookup:**
```json
{
  "type": "batch",
  "ips": ["192.168.1.1", "10.0.0.1"],
  "requestId": "optional-request-id"
}
```

3. **Ping:**
```json
{
  "type": "ping",
  "requestId": "optional-request-id"
}
```

**Server → Client:**

1. **Lookup result:**
```json
{
  "type": "result",
  "ip": "192.168.1.1",
  "data": {
    "list": [...]
  },
  "requestId": "optional-request-id"
}
```

2. **Batch result:**
```json
{
  "type": "batch_result",
  "results": {
    "192.168.1.1": {...},
    "10.0.0.1": {}
  },
  "requestId": "optional-request-id"
}
```

3. **Error:**
```json
{
  "type": "error",
  "message": "Error description",
  "requestId": "optional-request-id"
}
```

4. **Pong:**
```json
{
  "type": "pong",
  "timestamp": 1234567890,
  "requestId": "optional-request-id"
}
```

5. **Connected:**
```json
{
  "type": "connected",
  "message": "WebSocket connection established",
  "protocols": ["lookup", "batch", "ping"]
}
```

#### WebSocket Rate Limiting

- Default: 5000 messages per minute per connection
- Configurable via `RATE_LIMIT_WS_MAX_MESSAGES` environment variable
- Exceeding limit results in connection closure with code 1008

### Rate Limiting

All HTTP endpoints (except `/health`) are rate limited:
- Default: 1000 requests per minute per IP address
- Configurable via `RATE_LIMIT_MAX_REQUESTS` and `RATE_LIMIT_WINDOW_MS`
- Rate limit headers included in responses:
  - `X-RateLimit-Limit`: Maximum requests per window
  - `X-RateLimit-Remaining`: Remaining requests in current window
  - `X-RateLimit-Reset`: Unix timestamp when window resets
- Exceeding limit returns `429 Too Many Requests`

## Usage Notes

### Memory Usage

Node.js can use a lot of memory while loading IPs into Redis. Memory usage is lower once loading is complete. On reference machine:
- Loading takes 2.7GB, 32s without `--collectGarbage` option
- Loading takes 1.1GB, 43s with `--collectGarbage`
- `NODE_OPTIONS=--max_old_space_size=4096` or similar env variable required

### Data Storage

- The data in Redis takes about 420M once loaded
- The node script uses about 1GB of memory at rest

### Startup

- Wait for download and processing; system is ready when you see `ready to serve!` in logs
- Visit `http://localhost:3000/192.168.0.1` to test
- Updated lists will be pulled according to given cron schedule

### Creating Plugins

Create your own "plugins" to add more IP lists:
- See `plugins` folder and `plugins.js` for examples
- Plugins should extend `BasePlugin` from `plugins/base.js`
- A plugin must add a file to the staging folder
- Plugin must implement `load()` method that returns a Promise
- If the plugin has dependencies, create a `package.json` file and reference the plugin in the project's main `package.json` file

**Example Plugin:**

```javascript
const BasePlugin = require('../base');

class MyPlugin extends BasePlugin {
    constructor(options) {
        super({
            name: 'myplugin',
            version: '1.0.0',
            description: 'My custom IP list plugin',
            abortOnFail: false
        });
        this.outputFile = options.outputFile;
    }

    async load() {
        // Download/process IP lists
        // Write to this.outputFile
        return 'success';
    }
}

module.exports = MyPlugin;
```

## Migration Guide

### From Previous Version

The service maintains backward compatibility with existing HTTP API endpoints. Key changes:

1. **Environment Variables**: Now uses `config.js` with Joi validation. Most environment variables remain the same, but validation is stricter.

2. **Logging**: All `console.log` statements replaced with structured logging via Pino. Set `LOG_LEVEL` and `LOG_PRETTY` environment variables to control logging.

3. **Dependencies**: Updated to modern versions. Run `npm install` to update.

4. **WebSocket**: New feature, opt-in. Set `WS_ENABLED=false` to disable.

5. **Rate Limiting**: Now enabled by default. Configure via environment variables.

6. **Health Checks**: New `/health` endpoint added. Can be disabled via `HEALTH_CHECK_ENABLED=false`.

7. **Redis Connection**: Now uses connection pooling and better error handling. No changes required to Redis data structure.

8. **Plugins**: Enhanced plugin architecture with `BasePlugin` class. Legacy plugins still work, but consider migrating to new architecture.

### Breaking Changes

- None! All existing HTTP endpoints work as before.

## Gotchas

### Memory Limits
- Check your Docker VM settings in Windows or Mac; 2GB RAM won't cut it
- Use `NODE_OPTIONS=--max_old_space_size=4096` or higher

### Redis Connection
- Ensure Redis is running and accessible before starting the service
- Check Redis connection settings in environment variables

### Rate Limiting
- Rate limits apply per IP address for HTTP endpoints
- WebSocket rate limits apply per connection
- Health check endpoint is excluded from rate limiting

### Update Process
- **Concurrent Updates**: The system uses distributed locking to prevent concurrent updates. If an update is already in progress, subsequent cron triggers will be skipped.
- **Atomic Operations**: CSV files are written to temporary files first, then atomically renamed to prevent corruption.
- **Validation**: CSV files are validated before loading into Redis to ensure data integrity.
- **Error Recovery**: On failure, the system automatically cleans up temporary files and releases locks.
- **Status Tracking**: Update status is tracked in Redis and exposed via the `/health` endpoint.
- **Lock Timeout**: Update locks expire after 1 hour (TTL) to prevent deadlocks if a process crashes.
- **Stale Lock Detection**: The system automatically detects and cleans up locks held by dead processes. The health check (`/health`) will show `lockStale: true` if a stale lock is detected. Stale locks are automatically cleaned up when the next update attempt runs, or can be manually cleaned up via `POST /admin/cleanup-stale-lock`.

## Performance Characteristics

- **Lookup Speed**: < 3ms per IP lookup (typical)
- **Throughput**: Handles 1000+ requests/second per instance
- **Memory**: ~1GB at rest, ~2.7GB during loading
- **Redis Storage**: ~420MB for full Firehol dataset

## Troubleshooting

### Service won't start
- Check Redis connection settings
- Verify environment variables are set correctly
- Check logs for error messages

### Slow lookups
- Verify Redis is running and accessible
- Check Redis connection pool settings
- Monitor Redis performance

### Rate limit errors
- Adjust `RATE_LIMIT_MAX_REQUESTS` if needed
- Consider using WebSocket for high-volume scenarios
- Health checks are not rate limited

## References

Based on prior work:
- user285148: https://softwareengineering.stackexchange.com/questions/363091/split-overlapping-ranges-into-all-unique-ranges
- Dvir Volk: https://groups.google.com/g/redis-db/c/lrYbkbxfQiQ
