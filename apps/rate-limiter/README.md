# Rate Limiter Use Case

Express.js application demonstrating **sliding window rate limiting** using ValKey (Redis-compatible) for precise request throttling.

## Design Considerations 🚀

### Rate Limit Algorithms

Rate limiting can be implemented using several different algorithms, each with distinct trade-offs between accuracy, memory usage, implementation complexity, and burst handling. This section explores three popular approaches: **Fixed Window Counter**, **Token Bucket**, and **Sliding Window Log**.

This implementation uses the **Sliding Window Log** approach, which provides precise rate limiting by maintaining a log of request timestamps. This approach offers the most accurate rate limiting with no burst allowance beyond the specified limit.

#### Algorithm Comparison

| Algorithm                 | Accuracy   | Memory Usage | Complexity | Burst Handling | Use Cases                                               |
| ------------------------- | ---------- | ------------ | ---------- | -------------- | ------------------------------------------------------- |
| **Fixed Window Counter**  | Variable\* | Low          | Simple     | Poor           | High-volume APIs, basic throttling                      |
| **Token Bucket**          | High       | Low          | Medium     | Excellent      | APIs needing burst traffic, user-facing services        |
| **Sliding Window Log** ✅ | Highest    | Bounded\*\*  | High       | Precise        | Critical APIs, financial services, precise rate control |

\*Good within window, poor at boundaries  
\*\*Memory usage is proportional to the request limit per client, with automatic cleanup.

---

#### Fixed Window Counter

The fixed window counter divides time into fixed intervals and counts requests within each window. When a window expires, the counter resets to zero.

**Key Advantages:**

- **Minimal Memory**: Only stores a counter and timestamp per client
- **Simple Implementation**: Easy to implement and understand
- **High Performance**: Very fast operations with minimal overhead
- **Scalable**: Excellent performance under high load

**Trade-offs:**

- **Boundary Issues**: Allows up to 2x the rate limit at window boundaries
- **Uneven Distribution**: Requests can be concentrated at specific times
- **Less Precise**: Cannot provide accurate "requests remaining" information

<details>
<summary><strong>📋 Technical Implementation Details</strong></summary>

### Algorithm Flow

```
1. Extract client IP address from request
2. Calculate window timestamp: windowStart = Math.floor(now / windowMs) * windowMs
3. Create unique ValKey key: `rate_limit:fixed:{clientId}:{windowStart}`
4. Increment counter and get new value
5. If this is first request in window: Set TTL
6. If counter > limit: Return HTTP 429
7. If counter <= limit: Allow request
```

### Data Structure

```
ValKey Key: rate_limit:fixed:192.168.1.100:1692834000
ValKey Type: String (counter)
Value: Request count for current window

Example:
SET rate_limit:fixed:192.168.1.100:1692834000 3 EX 60
INCR rate_limit:fixed:192.168.1.100:1692834000
```

### Rate Limiting Pipeline

```lua
-- Lua script for atomic execution
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowSeconds = tonumber(ARGV[2])

local current = redis.call('INCR', key)

-- Set TTL only for the first request in the window
if current == 1 then
    redis.call('EXPIRE', key, windowSeconds)
end

-- Check if limit exceeded
if current > limit then
    return {0, current, limit}  -- rejected, current count, limit
else
    return {1, current, limit}  -- allowed, current count, limit
end
```

**Alternative Pipeline Approach** (less atomic but simpler):

```typescript
1. INCR key                              // Increment and get new count
2. TTL key                               // Check if key has TTL
3. IF ttl == -1 THEN EXPIRE key windowSeconds  // Set TTL for new windows
4. Compare incremented value with limit
```

</details>

#### Token Bucket

The token bucket algorithm maintains a bucket of tokens that are consumed by requests. Tokens are added to the bucket at a fixed rate, allowing controlled bursts while maintaining average rate limits.

**Key Advantages:**

- **Burst Handling**: Allows traffic bursts up to bucket capacity
- **Smooth Rate Control**: Tokens refill at consistent rate
- **Flexible**: Can be tuned for different burst patterns
- **Intuitive**: Easy to understand token consumption model

**Trade-offs:**

- **Complex State**: Must track both token count and last refill time
- **Burst Allowance**: May allow temporary rate limit violations
- **Configuration Complexity**: Requires tuning of bucket size and refill rate

<details>
<summary><strong>📋 Technical Implementation Details</strong></summary>

### Algorithm Flow

```
1. Extract client IP address from request
2. Create unique ValKey key: `rate_limit:bucket:{clientId}`
3. Get current bucket state (tokens, last_refill_time)
4. Calculate tokens to add: (now - last_refill) * (refill_rate / 1000)
5. Update token count: min(bucket_size, current_tokens + new_tokens)
6. If updated_tokens >= 1: Consume 1 token and allow request
7. If updated_tokens < 1: Return HTTP 429 with retry_after
8. Update bucket state atomically
```

### Data Structure

**Option 1: Hash (Recommended)**

```
ValKey Key: rate_limit:bucket:192.168.1.100
ValKey Type: Hash
Fields:
  - tokens: current token count (float)
  - last_refill: last refill timestamp (milliseconds)
  - bucket_size: maximum tokens (for dynamic sizing)

Example:
HMSET rate_limit:bucket:192.168.1.100 tokens 4.5 last_refill 1692834001250 bucket_size 10
```

**Option 2: JSON String (Alternative)**

```
ValKey Key: rate_limit:bucket:192.168.1.100
ValKey Type: String (JSON)
Value: {"tokens": 4.5, "last_refill": 1692834001250, "bucket_size": 10}
```

### Rate Limiting Pipeline

```lua
-- Lua script for atomic token bucket implementation
local key = KEYS[1]
local bucket_size = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])  -- tokens per second
local current_time = tonumber(ARGV[3])
local ttl_seconds = tonumber(ARGV[4])

-- Get current state
local bucket_data = redis.call('HMGET', key, 'tokens', 'last_refill')
local current_tokens = tonumber(bucket_data[1]) or bucket_size
local last_refill = tonumber(bucket_data[2]) or current_time

-- Calculate tokens to add
local elapsed_seconds = (current_time - last_refill) / 1000
local tokens_to_add = elapsed_seconds * refill_rate
local new_tokens = math.min(bucket_size, current_tokens + tokens_to_add)

-- Check if request can be allowed
if new_tokens >= 1 then
    -- Allow request, consume 1 token
    new_tokens = new_tokens - 1
    redis.call('HMSET', key, 'tokens', new_tokens, 'last_refill', current_time)
    redis.call('EXPIRE', key, ttl_seconds)
    return {1, new_tokens, bucket_size}  -- allowed, remaining, limit
else
    -- Reject request, update state without consuming
    redis.call('HMSET', key, 'tokens', new_tokens, 'last_refill', current_time)
    redis.call('EXPIRE', key, ttl_seconds)
    local retry_after = math.ceil((1 - new_tokens) / refill_rate)
    return {0, new_tokens, bucket_size, retry_after}  -- rejected, remaining, limit, retry_after
end
```

</details>

#### Sliding Window Log ✅ _Currently Implemented_

The sliding window log algorithm tracks individual request timestamps within a rolling time window, providing the most accurate rate limiting behavior among all approaches.

**Key Advantages:**

- **Precise Limiting**: No burst allowance - exactly N requests per window
- **Fair Distribution**: Requests are spread evenly across the time window
- **Memory Efficient**: Automatic cleanup of expired entries
- **Atomic Operations**: ValKey pipelines ensure consistency under high concurrency

**Trade-offs:**

- Memory usage bounded by (request_limit × window_duration) per client
- More complex implementation requiring sorted data structures and Lua scripting
- Slight performance overhead from timestamp management
- Requires careful cleanup of expired entries

<details>
<summary><strong>📋 Technical Implementation Details</strong></summary>

### Algorithm Flow

```
1. Extract client IP address from request
2. Create unique ValKey key: `rate_limit:{clientId}`
3. Execute atomic script:
   a. Remove expired timestamps (older than current_time - window_ms)
   b. Count remaining requests in the sliding window
   c. If count < limit: Add current timestamp and allow request
   d. If count ≥ limit: Return HTTP 429 with retry information
4. Set/update TTL on key for automatic cleanup
5. Return result with rate limit headers
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

```lua
-- Lua script for atomic sliding window implementation
local key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local current_time = tonumber(ARGV[3])
local ttl_seconds = tonumber(ARGV[4])

-- Remove expired entries
local window_start = current_time - window_ms
redis.call('ZREMRANGEBYSCORE', key, 0, window_start)

-- Count current entries
local current_count = redis.call('ZCARD', key)

-- Check if request can be allowed
if current_count < limit then
    -- Allow request, add timestamp
    local unique_id = current_time .. '-' .. math.random(1000000)
    redis.call('ZADD', key, current_time, unique_id)
    redis.call('EXPIRE', key, ttl_seconds)

    local remaining = limit - current_count - 1
    return {1, remaining, limit}  -- allowed, remaining, limit
else
    -- Reject request
    redis.call('EXPIRE', key, ttl_seconds)  -- Update TTL anyway

    -- Calculate retry after (time until oldest entry expires)
    local oldest_entries = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local retry_after_ms = 0
    if #oldest_entries > 0 then
        local oldest_time = tonumber(oldest_entries[2])
        retry_after_ms = math.max(0, (oldest_time + window_ms) - current_time)
    end

    local retry_after_seconds = math.ceil(retry_after_ms / 1000)
    return {0, 0, limit, retry_after_seconds}  -- rejected, remaining=0, limit, retry_after
end
```

</details>

### HTTP API

- **HTTP 429 Status Code**: Response with "Too Many Requests" when rate limit applies.
- **Provide Further Rate Limit Details**: two approaches (not mutually exclusive) a service can take
  - **Rate Limit Headers Approach**: use `X-RateLimit-*` headers for client visibility
    - `X-RateLimit-Limit`: The maximum number of requests that the client is allowed to make in this window.
    - `X-RateLimit-Remaining`: The number of requests allowed in the current window.
    - `X-RateLimit-Reset`: The relative time in seconds when the rate limit window will be reset. Note: This differs from other implementations (like GitHub's) that use a UTC epoch timestamp.
  - **Retry-After Header Approach**: header indicating how long the client ought to wait before making a follow-up request. The Retry-After header can contain a HTTP date value to retry after or the number of seconds to delay. Either is acceptable but APIs should prefer to use a delay in seconds.
  - `X-RateLimit-*` headers are generally returned on every request and not just on a 429, unlike `Retry-After` header. Thus `X-RateLimit-*` enables client a more proactive approach in avoiding Rate Limit. Both approaches can be combined.

### Implementation Considerations

#### Error Handling & Resilience

**ValKey Connection Failures**

- **Fail Open Strategy**: When ValKey is unavailable, allow requests through rather than blocking all traffic
- **Circuit Breaker Pattern**: Temporarily bypass rate limiting after consecutive ValKey failures
- **Graceful Degradation**: Log errors but maintain service availability

**Script Execution Errors**

```lua
-- Add error handling to Lua scripts
local success, result = pcall(function()
    -- Main rate limiting logic here
    return {1, remaining, limit}
end)

if not success then
    -- Log error and fail open
    return {1, -1, -1}  -- Allow request, unknown remaining
end

return result
```

**Concurrent Request Handling**

- All algorithms use Lua scripts for atomic operations
- Race conditions eliminated through single-threaded script execution
- Pipeline operations ensure consistency under high load

#### Performance Optimization

**Memory Management**

- **Automatic Cleanup**: TTL-based expiration prevents memory leaks
- **Bounded Growth**: Sliding window memory = `requests × window_duration` per client
- **Key Expiration**: Set appropriate TTL values (recommended: 2× window duration)

**Network Optimization**

```lua
-- Minimize round trips with combined operations
-- Single script call instead of multiple commands
local result = redis.call('EVAL', script, 1, key, arg1, arg2, arg3)
```

**Monitoring & Observability**

- Track rate limiter performance metrics
- Monitor ValKey memory usage and key counts
- Alert on high rejection rates or connection failures
- Log rate limit violations for security analysis

**Scaling Considerations**

- **Horizontal Scaling**: Use consistent hashing for client-to-shard mapping
- **Redis Clustering**: Ensure keys are properly distributed across cluster nodes
- **Memory Limits**: Set appropriate `maxmemory` policies in ValKey configuration

#### Production Deployment Tips

1. **Test Under Load**: Validate behavior under concurrent request patterns
2. **Monitor Key Expiration**: Ensure TTL settings prevent memory bloat
3. **Backup Strategy**: Rate limit data is ephemeral but configuration should be backed up
4. **Security**: Rate limiting helps prevent abuse but isn't a complete DDoS solution

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

# Run load test (5 RPS for 15 seconds) - Press Ctrl+C to stop
pnpm --filter @valkey-use-cases/rate-limiter test:load

# Or run directly with custom settings
cd apps/rate-limiter && \
    TARGET_URL=http://localhost:3003/api/protected RATE=5/s DURATION=15s ./load-test.sh
```

### Step 5: Cleanup

```bash
# Stop the application (Ctrl+C)
# Stop ValKey container
pnpm docker:down
```

## 🔧 How It Works

The rate limiter implements a **sliding window log algorithm** using ValKey sorted sets for precise request throttling. For detailed technical information about the algorithm, data structures, and pipeline operations, see the [Rate Limit Algorithms](#rate-limit-algorithms) section above.

### Request Processing Flow

When a request hits the rate-limited endpoint, the application:

1. **Identifies the client** using IP address extraction
2. **Checks rate limit status** by querying the ValKey sorted set
3. **Updates request log** by adding the current timestamp (if allowed)
4. **Returns appropriate response**:
   - HTTP 200 with rate limit headers if request is allowed
   - HTTP 429 with retry information if rate limit exceeded

### Key Features

- **Atomic Operations**: All ValKey commands are executed in a pipeline for consistency
- **Automatic Cleanup**: TTL ensures old keys are automatically removed
- **Precise Timing**: Uses millisecond timestamps for accurate window calculations
- **Client Identification**: Rate limits are applied per client IP address

## ⚙️ Configuration

| Setting         | Value          | Description                |
| --------------- | -------------- | -------------------------- |
| **Port**        | 3003           | HTTP server port           |
| **Rate Limit**  | 2 RPS          | Requests per second per IP |
| **Window Size** | 1000ms         | Sliding window duration    |
| **ValKey Host** | localhost:6379 | Database connection        |
| **Key Prefix**  | `rate_limit:`  | ValKey key namespace       |
