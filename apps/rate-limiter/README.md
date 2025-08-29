# Rate Limiter Use Case

Express.js application demonstrating **sliding window rate limiting** using ValKey (Redis-compatible) for precise request throttling.

## Design Considerations 🚀

### Rate Limit Algorithms

// TODO: explain different approaches and trade-offs for implementing rate limits

### HTTP API

- **HTTP 429 Status Code**: Response with "Too Many Requests" when rate limit applies.
- **Provide Further Rate Limit Details**: two approaches (not mutually exclusive) a service can take
  - **Rate Limit Headers Approach**: use `X-RateLimit-*` headers for client visibility
    - `X-RateLimit-Limit`: The maximum number of requests that the client is allowed to make in this window.
    - `X-RateLimit-Remaining`: The number of requests allowed in the current window.
    - `X-RateLimit-Reset`: The relative time in seconds when the rate limit window will be reset. Beware that this is different to Github and Twitter’s usage of a header with the same name which is using UTC epoch seconds instead.
  - **Retry-After Header Approach**: header indicating how long the client ought to wait before making a follow-up request. The Retry-After header can contain a HTTP date value to retry after or the number of seconds to delay. Either is acceptable but APIs should prefer to use a delay in seconds.
  - `X-RateLimit-*` headers are generally returned on every request and not just on a 429, like `Retry-After` header. Thus `X-RateLimit-*` enables client a more proactive approach in avoiding Rate Limit.

## 📋 Prerequisites

- Node.js 18+
- pnpm
- Docker (for ValKey)
- Vegeta (for load testing) - `brew install vegeta`

## 🛠️ Setup & Testing (Step-by-step)

### Step 1: Start Infrastructure

```bash
# From project root - start ValKey container
pnpm docker:up

# Verify ValKey is running
docker-compose ps
```

### Step 2: Build and Start Application

```bash
# Build the monorepo
pnpm build

# Start rate limiter in development mode
pnpm --filter @valkey-use-cases/rate-limiter dev
```

### Step 3: Manual Testing

```bash
# 1. Health check (not rate limited)
curl http://localhost:3003/health

# 2. Repeatedly fire a serie of requests
curl -i http://localhost:3003/api/protected
```

### Step 4: Testing

#### Automated Test Suite

```bash
# Run all unit and integration tests
pnpm --filter @valkey-use-cases/rate-limiter test

```

#### Load Testing with Vegeta

```bash
# Install Vegeta (if not already installed)
brew install vegeta

# Run load test (3 RPS for 30 seconds) - Press Ctrl+C to stop
pnpm --filter @valkey-use-cases/rate-limiter test:load

# Or run directly with custom settings
cd apps/rate-limiter && \
    TARGET_URL=http://localhost:3003/api/protected RATE=5/1s DURATION=15s ./load-test.sh
```

### Step 5: Cleanup

```bash
# Stop the application (Ctrl+C)
# Stop ValKey container
pnpm docker:down
```

## 🔧 How It Works

The rate limiter implements a **sliding window algorithm** using ValKey sorted sets:

### Algorithm Flow

```
1. Extract client IP address from request
2. Create unique ValKey key: `rate_limit:{key}`, key can be client_ip address
3. Remove expired timestamps (older than window)
4. Count current requests in the sliding window
5. If count < limit: Allow request + add timestamp
6. If count ≥ limit: Return HTTP 429 + retry info
7. Set TTL on key for automatic cleanup
```

### Data Structure

```
ValKey Key: rate_limit:192.168.1.100
ValKey Type: Sorted Set (ZSET)
Scores: Unix timestamps (milliseconds)
Values: Unique identifiers (timestamp + random)

Example:
ZADD rate_limit:192.168.1.100 1692834001250 "1692834001250-0.123"
ZADD rate_limit:192.168.1.100 1692834001750 "1692834001750-0.456"
```

### Rate Limiting Pipeline

```typescript
// ValKey commands executed atomically
1. ZREMRANGEBYSCORE key 0 (now - windowMs)  // Remove old entries
2. ZCARD key                                 // Count current entries
3. ZADD key now "<now>-<random>"                 // Add current request
4. EXPIRE key windowSeconds                  // Set TTL for cleanup
```

## ⚙️ Configuration

| Setting         | Value          | Description                |
| --------------- | -------------- | -------------------------- |
| **Port**        | 3003           | HTTP server port           |
| **Rate Limit**  | 2 RPS          | Requests per second per IP |
| **Window Size** | 1000ms         | Sliding window duration    |
| **ValKey Host** | localhost:6379 | Database connection        |
| **Key Prefix**  | `rate_limit:`  | ValKey key namespace       |
