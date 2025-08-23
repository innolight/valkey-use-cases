# Rate Limiter Use Case

Express.js application demonstrating **sliding window rate limiting** using ValKey (Redis-compatible) for precise request throttling.

## 🚀 Features

- **1 RPS Rate Limit**: Each client IP limited to 1 request per second
- **Sliding Window Algorithm**: Precise time-based rate limiting using ValKey sorted sets
- **HTTP 429 Responses**: Proper "Too Many Requests" error responses
- **Rate Limit Headers**: `X-RateLimit-*` headers for client visibility
- **Automatic Cleanup**: Expired request timestamps are automatically removed

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

# 2. First request to protected endpoint (should succeed)
curl -i http://localhost:3003/api/protected

# 3. Immediate second request (should be rate limited)
curl -i http://localhost:3003/api/protected

# 4. Wait 1+ seconds, then retry (should succeed again)
sleep 1
curl -w "\nHTTP: %{http_code}\n" http://localhost:3003/api/protected
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
TARGET_URL=http://localhost:3003/api/protected RATE=5/1s DURATION=1s ./load-test.sh
```

**What to Expect:**
- **Unit Tests**: Core rate limiter logic validation
- **Integration Tests**: API endpoint behavior verification  
- **Load Test Verification**: Automated 33.3% success rate validation
- **Vegeta Load Test**: Real-time progress showing ~33% success rate

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
2. Create unique ValKey key: `rate_limit:{client_ip}`
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
3. ZADD key now "now-random"                 // Add current request
4. EXPIRE key windowSeconds                  // Set TTL for cleanup
```

## 📊 Implementation Details

### Files Structure
```
src/
├── index.ts         # Express server setup and routes
└── rate-limiter.ts  # Sliding window rate limiter class
```

### Key Components

**RateLimiter Class** (`src/rate-limiter.ts`)
- Configurable window size and request limits
- Client IP extraction and key generation
- ValKey pipeline operations for atomicity
- HTTP headers for client rate limit visibility

**Express Server** (`src/index.ts`)
- Health endpoint (not rate limited)
- Protected endpoints with rate limiting
- Graceful shutdown handling
- ValKey connection management

## ⚙️ Configuration

| Setting | Value | Description |
|---------|-------|-------------|
| **Port** | 3003 | HTTP server port |
| **Rate Limit** | 1 RPS | Requests per second per IP |
| **Window Size** | 1000ms | Sliding window duration |
| **ValKey Host** | localhost:6379 | Database connection |
| **Key Prefix** | `rate_limit:` | ValKey key namespace |

## 🏗️ Architecture Benefits

- **Precise**: Sliding window vs fixed window accuracy  
- **Scalable**: Horizontal scaling with shared ValKey instance
- **Memory Efficient**: Automatic cleanup with TTL
- **Observable**: Rate limit headers for debugging
- **Resilient**: Graceful fallback on ValKey errors