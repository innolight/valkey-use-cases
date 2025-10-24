# Caching Patterns with Valkey/Redis

A comprehensive guide to caching patterns using Valkey/Redis. This document focuses on building fundamental understanding of caching strategies, their trade-offs, and how to implement them with Redis commands.

## Table of Contents

- [Introduction to Caching](#introduction-to-caching)
- [Pattern Categories](#pattern-categories)
- [Read Patterns](#read-patterns)
- [Write Patterns](#write-patterns)
- [Eviction & Expiration Strategies](#eviction--expiration-strategies)
- [Advanced Patterns](#advanced-patterns)
- [Pattern Selection Guide](#pattern-selection-guide)
- [Implementation Details](#implementation-details)

---

## Introduction to Caching

Caching is a performance optimization technique that stores copies of frequently accessed data in a fast storage layer (cache) to reduce the cost of retrieving that data from slower sources like databases, APIs, or computations.

### Why Cache?

- **Performance**: Reduce response time from seconds to milliseconds
- **Scalability**: Decrease load on backend systems (databases, APIs)
- **Cost**: Reduce compute and database resources needed
- **Availability**: Serve stale data when backend is unavailable

### The Fundamental Trade-off

All caching involves a core trade-off between **performance** and **consistency**:

- Faster reads = potential for stale data
- Guaranteed consistency = slower operations

Different patterns position themselves along this spectrum based on your needs.

---

## Pattern Categories

This guide covers 10 caching patterns organized into four categories:

1. **Read Patterns** (2) - How to retrieve and populate cache
   - Cache-Aside (Lazy Loading)
   - Read-Through

2. **Write Patterns** (3) - How to handle data modifications
   - Write-Through
   - Write-Behind (Write-Back)
   - Write-Around

3. **Eviction & Expiration** (2) - How to manage cache lifetime
   - TTL (Time-To-Live)
   - LRU/LFU Eviction

4. **Advanced Patterns** (3) - Specialized optimization techniques
   - Cache Warming (Pre-loading)
   - Refresh-Ahead
   - Cache Stampede Prevention

---

## Read Patterns

Read patterns define how your application retrieves data and populates the cache.

### 1. Cache-Aside (Lazy Loading)

**The Pattern:**

The most common caching pattern where the application code explicitly manages the cache:

```
1. Application requests data by key
2. Check cache first (GET key)
3a. Cache HIT → Return cached data immediately
3b. Cache MISS → Load from source (database/API)
4. Store in cache (SET key value)
5. Return data to application
```

**Redis Implementation:**

```python
def get_user(user_id):
    # Try cache first
    cached = redis.get(f"user:{user_id}")
    if cached:
        return json.loads(cached)

    # Cache miss - load from database
    user = database.query("SELECT * FROM users WHERE id = ?", user_id)

    # Store in cache for future requests
    redis.set(f"user:{user_id}", json.dumps(user))

    return user
```

**Redis Commands:**

- `GET key` - Check cache
- `SET key value` - Store in cache
- `DEL key` - Invalidate cache entry

**When to Use:**

✅ **Use when:**

- Data is read more frequently than written
- Cache misses are acceptable (occasional slow requests)
- You need full control over caching logic
- Different data has different caching requirements
- This is your default choice for most use cases

❌ **Avoid when:**

- You need guaranteed data consistency
- Cache misses are unacceptable
- Your application code should be cache-agnostic

**Pros & Cons:**

| Pros                                               | Cons                                               |
| -------------------------------------------------- | -------------------------------------------------- |
| Simple to understand and implement                 | Cache miss penalty - first request is slow         |
| Only requested data gets cached (efficient memory) | Potential for stale data if not invalidated        |
| Application has full control                       | Application code tightly coupled to cache          |
| Works with any data source                         | Each cache miss hits the source                    |
| Failure in cache doesn't break application         | Three round trips on cache miss (check→load→store) |

**Real-World Use Cases:**

- Product catalogs in e-commerce
- User profiles
- Article content in CMS
- API response caching
- DNS lookups

**Considerations:**

- **Invalidation strategy**: When do you delete/update cache? (on write, on TTL, manual)
- **Cache key design**: Use consistent, hierarchical keys (`user:123`, `product:456`)
- **Serialization**: JSON, MessagePack, or protocol buffers for complex objects
- **Error handling**: What happens if cache is down? (Fall back to source)

---

### 2. Read-Through

**The Pattern:**

A cache abstraction where the cache itself is responsible for loading data from the source. The application always interacts with the cache, which transparently handles cache misses.

```
1. Application requests data from cache
2. Cache checks if key exists
3a. Cache HIT → Cache returns data
3b. Cache MISS → Cache loads from source, stores, then returns
4. Application receives data (unaware of hit/miss)
```

**Conceptual Difference from Cache-Aside:**

| Aspect                          | Cache-Aside                               | Read-Through                      |
| ------------------------------- | ----------------------------------------- | --------------------------------- |
| Who loads data?                 | Application code                          | Cache layer                       |
| Application knows about source? | Yes                                       | No                                |
| Code complexity                 | Application manages both cache and source | Application only talks to cache   |
| Flexibility                     | High - different logic per data type      | Low - cache needs generic loading |

**Redis Implementation:**

This pattern typically requires a caching library or custom abstraction:

```python
# With a read-through cache library
class ReadThroughCache:
    def __init__(self, redis_client, data_loader):
        self.redis = redis_client
        self.loader = data_loader  # Function to load from source

    def get(self, key):
        # Check cache
        cached = self.redis.get(key)
        if cached:
            return json.loads(cached)

        # Cache miss - use loader
        data = self.loader(key)
        self.redis.set(key, json.dumps(data))
        return data

# Application code is simple
cache = ReadThroughCache(redis, load_user_from_db)
user = cache.get(f"user:{user_id}")  # Don't know if hit or miss
```

**Redis Commands:**

- Same as Cache-Aside: `GET`, `SET`, `DEL`
- The difference is architectural (who executes them)

**When to Use:**

✅ **Use when:**

- You want to simplify application code
- Cache loading logic is consistent across data types
- Building a reusable caching layer
- Want to swap cache implementations without changing application code

❌ **Avoid when:**

- Different data types need different loading strategies
- Cache layer can't access the data source
- You need fine-grained control over caching behavior

**Pros & Cons:**

| Pros                                      | Cons                                   |
| ----------------------------------------- | -------------------------------------- |
| Cleaner application code                  | Cache layer must know how to load data |
| Consistent interface                      | Less flexible than cache-aside         |
| Easier to test (mock cache layer)         | More complex cache implementation      |
| Centralized caching logic                 | Cache is coupled to data source        |
| Easier to add features (monitoring, etc.) | May be overkill for simple cases       |

**Real-World Use Cases:**

- Caching frameworks (Spring Cache, Django Cache)
- ORMs with caching support
- GraphQL DataLoaders
- Hibernate second-level cache

**Considerations:**

- **Data loader configuration**: How does cache know how to load each key type?
- **Error handling**: What if loader fails? Cache the error? Propagate?
- **Monitoring**: Cache hit ratio, miss latency tracking

---

## Write Patterns

Write patterns define how your application handles data modifications and keeps cache synchronized with the source of truth.

### The Write Problem

Unlike reads, writes introduce a consistency challenge:

- **Cache** (fast, volatile)
- **Source of Truth** (slow, persistent - database)

How do you keep them synchronized?

---

### 3. Write-Through

**The Pattern:**

Every write goes through the cache to the source. Both cache and source are updated synchronously before the write is considered complete.

```
1. Application writes data
2. Write to cache (SET key value)
3. Write to source (database UPDATE) - synchronous
4. Both writes must succeed
5. Return success to application
```

**Redis Implementation:**

```python
def update_user(user_id, user_data):
    # Start transaction
    try:
        # 1. Write to cache first
        redis.set(f"user:{user_id}", json.dumps(user_data))

        # 2. Write to database (synchronous)
        database.execute(
            "UPDATE users SET name = ?, email = ? WHERE id = ?",
            user_data['name'], user_data['email'], user_id
        )

        return {"success": True}
    except Exception as e:
        # Rollback cache if database fails
        redis.delete(f"user:{user_id}")
        raise e
```

**Redis Commands:**

- `SET key value` - Write to cache
- `DEL key` - Rollback on failure

**When to Use:**

✅ **Use when:**

- Data consistency is critical
- Reads are much more frequent than writes
- Recently written data is likely to be read soon (read-after-write)
- You can tolerate slower writes for guaranteed consistency
- Compliance/audit requirements need cache-source consistency

❌ **Avoid when:**

- Write performance is critical
- High volume of writes
- Written data is rarely read back
- Write operations are expensive

**Pros & Cons:**

| Pros                                     | Cons                                   |
| ---------------------------------------- | -------------------------------------- |
| Cache and source always consistent       | Slower writes (wait for both)          |
| No cache misses on recently written data | Write penalty even if data never read  |
| Simple consistency model                 | Increased latency for write operations |
| Data durability (persisted immediately)  | Source becomes bottleneck              |
| Easier to reason about                   | Both systems must be available         |

**Real-World Use Cases:**

- User account settings
- Shopping cart contents
- Configuration data
- Financial transactions (with proper ACID)
- User preferences

**Considerations:**

- **Transaction management**: Use transactions if source supports it
- **Rollback strategy**: What if cache succeeds but source fails?
- **Write amplification**: Every write hits both systems
- **Network failures**: Handle partial failures gracefully
- **Performance impact**: Profile write latency before committing

---

### 4. Write-Behind (Write-Back)

**The Pattern:**

Writes go to cache immediately and return. The write to the source happens asynchronously in the background. This provides fast write performance at the cost of eventual consistency.

```
1. Application writes data
2. Write to cache immediately (SET key value)
3. Add write to queue (LPUSH write-queue)
4. Return success to application (fast!)
5. Background worker processes queue (RPOP)
6. Worker writes to source asynchronously
```

**Redis Implementation:**

```python
# Write operation (fast)
def update_user(user_id, user_data):
    # 1. Write to cache immediately
    redis.set(f"user:{user_id}", json.dumps(user_data))

    # 2. Queue the write for background processing
    write_op = {
        "type": "user_update",
        "user_id": user_id,
        "data": user_data,
        "timestamp": time.time()
    }
    redis.lpush("write-behind:queue", json.dumps(write_op))

    # 3. Return immediately
    return {"success": True}

# Background worker (separate process)
def write_behind_worker():
    while True:
        # Get write from queue
        write_op = redis.rpop("write-behind:queue")
        if not write_op:
            time.sleep(1)
            continue

        op = json.loads(write_op)
        try:
            # Write to database
            database.execute(
                "UPDATE users SET name = ?, email = ? WHERE id = ?",
                op['data']['name'], op['data']['email'], op['user_id']
            )
        except Exception as e:
            # Handle failure - retry, dead letter queue, etc.
            logging.error(f"Write-behind failed: {e}")
```

**Redis Commands:**

- `SET key value` - Write to cache
- `LPUSH queue item` - Add to write queue (left push)
- `RPOP queue` - Get from queue (right pop) - FIFO
- `LLEN queue` - Check queue length
- `LRANGE queue 0 -1` - View pending writes (debugging)

**When to Use:**

✅ **Use when:**

- Write performance is critical (high throughput)
- You can tolerate eventual consistency (seconds/minutes delay)
- High volume of writes (analytics, logging, metrics)
- Write operations are expensive/slow
- Database/source can handle batched writes

❌ **Avoid when:**

- You need immediate consistency
- Cannot tolerate any data loss
- Need confirmation of persistent storage
- Compliance requires synchronous persistence

**Pros & Cons:**

| Pros                            | Cons                               |
| ------------------------------- | ---------------------------------- |
| Fastest write performance       | Risk of data loss if cache crashes |
| Reduced load on source database | Temporary inconsistency            |
| Can batch multiple writes       | Complex error handling             |
| Improved write throughput       | Need to monitor queue depth        |
| Better resource utilization     | Debugging harder (async)           |

**Real-World Use Cases:**

- Analytics and event tracking
- Logging and metrics collection
- Social media likes/views counters
- Real-time dashboards
- Session data updates
- Page view tracking

**Considerations:**

- **Queue management**: Monitor queue depth, prevent unbounded growth
- **Failure handling**: Dead letter queue for failed writes
- **Data loss risk**: What happens if Redis crashes before write to source?
- **Batching**: Group multiple writes for efficiency
- **Worker scaling**: Multiple workers for high throughput
- **Ordering**: FIFO with LPUSH/RPOP, use timestamps for auditing

**Advanced: Batched Writes**

```python
def batched_worker():
    while True:
        # Get up to 100 writes
        batch = []
        for _ in range(100):
            item = redis.rpop("write-behind:queue")
            if not item:
                break
            batch.append(json.loads(item))

        if batch:
            # Batch write to database
            database.execute_batch(batch)
        else:
            time.sleep(1)
```

---

### 5. Write-Around

**The Pattern:**

Writes bypass the cache entirely and go directly to the source. The cache is not updated on writes. Data is only cached when it's read.

```
1. Application writes data
2. Write directly to source (bypass cache)
3. Cache is NOT updated
4. Return success
5. Next read will be a cache miss
6. Cache populated on read (using cache-aside)
```

**Conceptual Implementation:**

```python
def update_user(user_id, user_data):
    # 1. Write to database only
    database.execute(
        "UPDATE users SET name = ?, email = ? WHERE id = ?",
        user_data['name'], user_data['email'], user_id
    )

    # 2. Optional: Invalidate cache to prevent stale reads
    redis.delete(f"user:{user_id}")

    return {"success": True}

def get_user(user_id):
    # Use cache-aside for reads
    cached = redis.get(f"user:{user_id}")
    if cached:
        return json.loads(cached)

    # Cache miss after write - this is expected
    user = database.query("SELECT * FROM users WHERE id = ?", user_id)
    redis.set(f"user:{user_id}", json.dumps(user))
    return user
```

**Redis Commands:**

- `DEL key` - Invalidate cache (optional)
- Read uses cache-aside pattern

**When to Use:**

✅ **Use when:**

- Data is written once and rarely (or never) read
- Preventing cache pollution is important
- Write-heavy workloads with infrequent reads
- Large data that doesn't benefit from caching (images, videos)
- Bulk imports or data migrations

❌ **Avoid when:**

- Data is frequently read after writes (read-after-write pattern)
- Write and read are equally common
- Cache hit rate is important

**Pros & Cons:**

| Pros                             | Cons                                    |
| -------------------------------- | --------------------------------------- |
| Prevents cache pollution         | Every read after write is a cache miss  |
| Faster writes (no cache update)  | Higher latency for first read           |
| Better for write-heavy workloads | Wasted cache space if not invalidated   |
| Simpler write logic              | May serve stale data if not invalidated |
| No write amplification           | Not suitable for read-after-write       |

**Real-World Use Cases:**

- Logging systems (write logs, rarely read)
- Bulk data imports
- Archival systems
- File uploads (metadata cached, file content not cached)
- Append-only data (time-series writes)

**Considerations:**

- **Invalidation**: Always invalidate cache on write to prevent stale reads
- **Cache warming**: Combine with cache warming for predictable reads
- **Monitoring**: Track cache miss rate to ensure pattern is appropriate

**Note:** This pattern is primarily conceptual - it's often just "don't cache writes" combined with cache-aside for reads. Not typically implemented as a separate service.

---

## Eviction & Expiration Strategies

How do you remove data from cache? Two approaches: time-based (TTL) and space-based (eviction policies).

### 6. TTL (Time-To-Live)

**The Pattern:**

Cache entries automatically expire after a specified duration. Redis handles deletion automatically.

```
1. Store data with TTL (SET key value EX seconds)
2. Redis automatically deletes key after TTL expires
3. Next read will be a cache miss
4. No manual cleanup required
```

**Redis Implementation:**

```python
def cache_with_ttl(key, data, ttl_seconds):
    # Store with expiration
    redis.set(key, json.dumps(data), ex=ttl_seconds)

def get_with_ttl(key):
    cached = redis.get(key)
    if cached:
        # Check remaining TTL
        ttl_remaining = redis.ttl(key)
        return json.loads(cached), ttl_remaining
    return None, -2  # -2 means key doesn't exist

# Example: Cache for 5 minutes
cache_with_ttl("session:abc123", session_data, ttl_seconds=300)

# Later: Check remaining time
data, ttl = get_with_ttl("session:abc123")
print(f"Data expires in {ttl} seconds")
```

**Redis Commands:**

- `SET key value EX seconds` - Store with TTL
- `SETEX key seconds value` - Alternative syntax
- `EXPIRE key seconds` - Set TTL on existing key
- `TTL key` - Get remaining seconds (-1 = no expiry, -2 = doesn't exist)
- `PTTL key` - Get remaining milliseconds

**TTL Strategies:**

| Strategy         | TTL Duration | Use Case                        |
| ---------------- | ------------ | ------------------------------- |
| Short (seconds)  | 1-60s        | Real-time data, rate limiting   |
| Medium (minutes) | 1-60m        | Session data, API responses     |
| Long (hours)     | 1-24h        | Product catalogs, user profiles |
| Very Long (days) | 1-7d         | Static content, configurations  |

**When to Use:**

✅ **Use when:**

- Data has a natural expiration time
- Stale data is acceptable for a defined period
- You want automatic cache cleanup
- Memory usage needs to be predictable
- Session management, tokens, OTPs

❌ **Avoid when:**

- Data never goes stale
- Need immediate invalidation on changes
- TTL is hard to determine
- Data access patterns are unpredictable

**Pros & Cons:**

| Pros                                       | Cons                               |
| ------------------------------------------ | ---------------------------------- |
| Automatic cleanup (no manual invalidation) | Data may be stale until expiration |
| Simple to implement                        | Cache miss if TTL too short        |
| Predictable memory usage                   | Wasted space if TTL too long       |
| No stale data after TTL                    | Cold start after expiration        |
| Works well with cache-aside                | Choosing correct TTL is hard       |

**Real-World Use Cases:**

- Session storage (30 min timeout)
- API rate limiting (1 minute windows)
- OTP/verification codes (5 minutes)
- OAuth tokens (1 hour)
- DNS caching (based on DNS TTL)
- Product prices (updated hourly)

**Choosing the Right TTL:**

```
TTL = Function of:
1. How often data changes
2. Cost of stale data (business impact)
3. Cost of cache miss (performance impact)
4. Acceptable staleness window

Example:
- Stock prices: 1-5 seconds (changes frequently, staleness critical)
- User profile: 5-15 minutes (changes rarely, staleness acceptable)
- Product catalog: 1 hour (changes infrequently)
- Static content: 24 hours or more
```

**Considerations:**

- **Sliding expiration**: Reset TTL on access (requires manual EXPIRE)
- **Stale-while-revalidate**: Serve stale data while refreshing in background
- **TTL jitter**: Add randomness to prevent thundering herd (many keys expiring simultaneously)

```python
# TTL with jitter to prevent synchronized expiration
import random

def cache_with_jitter(key, data, base_ttl):
    jitter = random.randint(-30, 30)  # ±30 seconds
    ttl = base_ttl + jitter
    redis.set(key, json.dumps(data), ex=ttl)
```

---

### 7. LRU/LFU Eviction

**The Pattern:**

When cache memory is full, Redis automatically evicts entries based on access patterns. This is configured at the Redis server level, not in application code.

**How It Works:**

```
1. Redis hits configured memory limit (maxmemory)
2. Redis needs to store new data
3. Redis evicts keys based on eviction policy
4. New data is stored
5. Application is unaware (transparent)
```

**Redis Configuration:**

```bash
# Connect to Redis/Valkey
redis-cli

# Set memory limit
CONFIG SET maxmemory 100mb

# Set eviction policy
CONFIG SET maxmemory-policy allkeys-lru
```

**Eviction Policies:**

| Policy            | What Gets Evicted               | When to Use                                   |
| ----------------- | ------------------------------- | --------------------------------------------- |
| `noeviction`      | Nothing (return error)          | Never want to lose data, handle errors in app |
| `allkeys-lru`     | Least Recently Used (any key)   | General purpose, good default                 |
| `allkeys-lfu`     | Least Frequently Used (any key) | Access frequency matters more than recency    |
| `volatile-lru`    | LRU among keys with TTL         | Mix of permanent and temporary data           |
| `volatile-lfu`    | LFU among keys with TTL         | Frequency matters for temporary data          |
| `allkeys-random`  | Random key                      | Eviction policy doesn't matter                |
| `volatile-random` | Random key with TTL             | Simple eviction for temporary data            |
| `volatile-ttl`    | Key with shortest TTL           | Prefer evicting soon-to-expire data           |

**LRU vs LFU:**

| LRU (Least Recently Used)           | LFU (Least Frequently Used)             |
| ----------------------------------- | --------------------------------------- |
| Evicts keys not accessed recently   | Evicts keys accessed infrequently       |
| Good for time-sensitive data        | Good for popularity-based caching       |
| Simpler, less overhead              | More sophisticated, tracks access count |
| Adapts quickly to changing patterns | Better for stable access patterns       |
| Example: Recent news articles       | Example: Popular products               |

**LRU Example:**

```
Keys: A(5min ago), B(2min ago), C(30sec ago)
Memory full → Evict A (least recently used)
```

**LFU Example:**

```
Keys: A(accessed 100x), B(accessed 10x), C(accessed 1x)
Memory full → Evict C (least frequently used)
```

**Conceptual Implementation (Redis handles this):**

You don't write code for this - it's automatic. But conceptually:

```python
# This is what Redis does internally (simplified)
class LRUCache:
    def __init__(self, max_memory):
        self.cache = {}
        self.access_order = OrderedDict()  # Track access time
        self.max_memory = max_memory

    def get(self, key):
        if key in self.cache:
            # Update access time (move to end)
            self.access_order.move_to_end(key)
            return self.cache[key]
        return None

    def set(self, key, value):
        # Evict if needed
        while self.current_memory() > self.max_memory:
            # Evict least recently used (first item)
            lru_key = next(iter(self.access_order))
            del self.cache[lru_key]
            del self.access_order[lru_key]

        self.cache[key] = value
        self.access_order[key] = time.time()
```

**When to Use:**

✅ **Use when:**

- Cache memory is limited
- Want to prevent out-of-memory errors
- Access patterns favor hot data
- Automatic management preferred over manual
- Unknown or unpredictable data size

❌ **Avoid when:**

- All cached data is equally important
- Need deterministic caching (specific data must stay)
- Very small cache (everything gets evicted)
- Access patterns are uniformly random

**Pros & Cons:**

| Pros                           | Cons                                |
| ------------------------------ | ----------------------------------- |
| Automatic memory management    | May evict data you need             |
| Keeps frequently accessed data | LRU/LFU calculation overhead        |
| No application code changes    | Requires tuning maxmemory           |
| Prevents OOM errors            | Eviction may cause cache misses     |
| Adapts to access patterns      | Not suitable for guaranteed caching |

**Real-World Use Cases:**

- Shared Redis instance with memory limits
- Multi-tenant caching (fair resource sharing)
- Automatic hot data retention
- Content delivery networks (CDN)
- Database query result caching

**Considerations:**

**1. Memory Limit Sizing:**

```
maxmemory = (available RAM) × 0.7  # Leave headroom
            - (Redis overhead ~10%)
            - (OS overhead)
```

**2. Monitoring:**

```bash
# Check current memory usage
INFO memory

# Check eviction stats
INFO stats
# Look for: evicted_keys counter
```

**3. Eviction Policy Selection:**

```
Use allkeys-lru if:
- General purpose caching
- All keys are cacheable data
- Simple access patterns

Use allkeys-lfu if:
- Some data is accessed much more than others
- Popularity-based caching
- Long-term access patterns

Use volatile-* if:
- Mix of permanent and temporary data
- Only want to evict TTL keys
- Some keys must never be evicted
```

**4. Combining TTL + Eviction:**

```python
# Best practice: Use both
redis.set(key, value, ex=3600)  # 1 hour TTL
# + configure LRU eviction policy

# Rationale:
# - TTL ensures data doesn't get too stale
# - LRU ensures memory doesn't fill up
# - Frequently accessed data stays beyond TTL if memory available
```

---

## Advanced Patterns

Advanced patterns combine multiple caching techniques to solve specific performance challenges.

---

### 8. Cache Warming (Pre-loading)

**The Pattern:**

Proactively load data into cache before it's requested, typically during application startup or off-peak hours.

```
1. Application starts or scheduled job runs
2. Identify critical/popular keys
3. Load data from source
4. Store in cache (batch SET operations)
5. Cache is "warm" - no cold start
6. First user requests are cache hits
```

**Redis Implementation:**

```python
def warm_cache(keys_to_warm):
    """
    Pre-load cache with critical data
    """
    for key in keys_to_warm:
        # Load from database
        data = database.query(f"SELECT * FROM table WHERE id = '{key}'")

        # Store in cache
        redis.set(f"cache:{key}", json.dumps(data))

    print(f"Warmed {len(keys_to_warm)} cache entries")

# At application startup
critical_user_ids = [1, 2, 3, 100, 101]  # VIP users
warm_cache([f"user:{id}" for id in critical_user_ids])

# Or load popular products
popular_products = database.query("SELECT id FROM products ORDER BY views DESC LIMIT 100")
warm_cache([f"product:{p['id']}" for p in popular_products])
```

**Batch Warming with Pipeline:**

```python
def warm_cache_batch(key_data_pairs):
    """
    Efficient batch warming using Redis pipeline
    """
    pipe = redis.pipeline()

    for key, data in key_data_pairs:
        pipe.set(key, json.dumps(data), ex=3600)

    # Execute all SETs in one round trip
    pipe.execute()

# Load 1000 products efficiently
products = database.query("SELECT * FROM products LIMIT 1000")
pairs = [(f"product:{p['id']}", p) for p in products]
warm_cache_batch(pairs)
```

**Redis Commands:**

- `SET key value` (many times)
- `MSET key1 value1 key2 value2 ...` - Multi-set (atomic)
- Pipeline for efficiency

**When to Use:**

✅ **Use when:**

- Predictable data access patterns
- Application startup (avoid cold start)
- After cache invalidation or deployment
- Scheduled off-peak warming (nightly)
- Critical data must always be fast
- After cache failures (recovery)

❌ **Avoid when:**

- Access patterns are unpredictable
- Cache space is very limited
- Data changes frequently
- Warming cost > cache miss cost

**Pros & Cons:**

| Pros                                   | Cons                                  |
| -------------------------------------- | ------------------------------------- |
| Eliminates cold start cache misses     | Startup time overhead                 |
| Consistent performance from start      | May waste cache space                 |
| Better user experience                 | Requires knowledge of access patterns |
| Reduced database load after deployment | Data may be stale immediately         |
| Can warm during off-peak hours         | Need to identify what to warm         |

**Real-World Use Cases:**

- Application deployment (warm new instances)
- Popular products in e-commerce (top 100)
- Trending content (news, social media)
- Frequently searched queries
- VIP user data
- Navigation menus, categories
- Configuration data

**Strategies:**

**1. Static Warming (Startup):**

```python
def on_application_start():
    # Warm with known critical data
    warm_cache([
        "config:app_settings",
        "config:feature_flags",
        "nav:main_menu",
    ])
```

**2. Data-Driven Warming (Analytics):**

```python
def warm_from_analytics():
    # Get most accessed keys from last hour
    popular_keys = analytics.query("""
        SELECT cache_key, COUNT(*) as hits
        FROM access_logs
        WHERE timestamp > NOW() - INTERVAL 1 HOUR
        GROUP BY cache_key
        ORDER BY hits DESC
        LIMIT 100
    """)
    warm_cache(popular_keys)
```

**3. Scheduled Warming (Periodic):**

```python
# Cron job: Warm cache every morning at 2 AM
# 0 2 * * * /usr/bin/python /app/warm_cache.py

def scheduled_warming():
    # Warm daily deals
    deals = get_daily_deals()
    warm_cache([f"deal:{d['id']}" for d in deals])

    # Warm trending products
    trending = get_trending_products(hours=24, limit=50)
    warm_cache([f"product:{p['id']}" for p in trending])
```

**Considerations:**

- **What to warm**: Use access logs, analytics, business knowledge
- **When to warm**: Startup, off-peak hours, after deployments
- **How much to warm**: Balance memory usage vs cold-start reduction
- **TTL**: Warmed data should have TTL (eventually refresh)
- **Monitoring**: Track warming time, memory usage, hit rate improvement

---

### 9. Refresh-Ahead

**The Pattern:**

Proactively refresh cached data before it expires. When a cache hit occurs and TTL is low, trigger a background refresh while returning the current cached value.

```
1. Request arrives for key
2. Check cache (GET key)
3. Cache HIT - check TTL (TTL key)
4. If TTL < threshold (e.g., 20% of original TTL):
   a. Return current cached value immediately (fast)
   b. Trigger background refresh asynchronously
5. Background: Load new data, update cache
6. Next request gets fresh data
```

**Redis Implementation:**

```python
import threading

class RefreshAheadCache:
    def __init__(self, redis_client, refresh_threshold=0.2):
        self.redis = redis_client
        self.threshold = refresh_threshold  # Refresh when 20% TTL remaining
        self.refreshing = set()  # Track keys being refreshed

    def get(self, key, ttl_seconds, loader_func):
        # Check cache
        cached = self.redis.get(key)

        if cached:
            # Cache hit - check if refresh needed
            current_ttl = self.redis.ttl(key)

            if current_ttl > 0:
                refresh_point = ttl_seconds * self.threshold

                if current_ttl < refresh_point and key not in self.refreshing:
                    # TTL is low - refresh in background
                    self._refresh_background(key, ttl_seconds, loader_func)

            return json.loads(cached)

        # Cache miss - load synchronously
        data = loader_func(key)
        self.redis.set(key, json.dumps(data), ex=ttl_seconds)
        return data

    def _refresh_background(self, key, ttl_seconds, loader_func):
        """Refresh cache in background thread"""
        self.refreshing.add(key)

        def refresh():
            try:
                # Load fresh data
                data = loader_func(key)
                # Update cache
                self.redis.set(key, json.dumps(data), ex=ttl_seconds)
            finally:
                self.refreshing.discard(key)

        thread = threading.Thread(target=refresh)
        thread.daemon = True
        thread.start()

# Usage
cache = RefreshAheadCache(redis, refresh_threshold=0.2)

def load_user(user_id):
    return database.query(f"SELECT * FROM users WHERE id = {user_id}")

# This will refresh in background when TTL < 12 seconds (20% of 60s)
user = cache.get("user:123", ttl_seconds=60, loader_func=lambda k: load_user(123))
```

**Redis Commands:**

- `GET key` - Retrieve value
- `TTL key` - Check remaining TTL
- `SET key value EX seconds` - Update with new TTL

**When to Use:**

✅ **Use when:**

- Expensive operations must always be fast
- Frequently accessed data (hot data)
- Cannot tolerate cache miss penalty
- Data changes but stale data is acceptable temporarily
- Read-heavy workloads with predictable access

❌ **Avoid when:**

- Data is rarely accessed (wasted refreshes)
- Real-time accuracy required (no stale data tolerance)
- Refresh operation is very expensive
- Low traffic (few cache hits to trigger refresh)

**Pros & Cons:**

| Pros                                      | Cons                                    |
| ----------------------------------------- | --------------------------------------- |
| Consistent fast performance (no misses)   | Increased cache/database load           |
| Users never experience cache miss penalty | May refresh data that won't be accessed |
| Hot data always fresh                     | More complex implementation             |
| Smooth user experience                    | Need to track refreshing keys           |
| Prevents thundering herd on expiration    | Background threads/workers needed       |

**Real-World Use Cases:**

- Dashboard metrics (expensive queries)
- API responses for popular endpoints
- Product recommendations
- User activity feeds
- Search results for common queries
- Leaderboards

**Refresh Threshold Strategies:**

| Threshold | When TTL = 60s     | Behavior                  |
| --------- | ------------------ | ------------------------- |
| 0.1 (10%) | Refresh when < 6s  | Aggressive - always fresh |
| 0.2 (20%) | Refresh when < 12s | Balanced - good default   |
| 0.5 (50%) | Refresh when < 30s | Conservative - less load  |

**Considerations:**

**1. Preventing Multiple Refreshes:**

```python
# Use a lock to ensure only one refresh per key
def _refresh_background(self, key, ttl_seconds, loader_func):
    lock_key = f"lock:refresh:{key}"

    # Try to acquire lock
    if self.redis.set(lock_key, "1", nx=True, ex=10):
        try:
            data = loader_func(key)
            self.redis.set(key, json.dumps(data), ex=ttl_seconds)
        finally:
            self.redis.delete(lock_key)
```

**2. Monitoring:**

```python
# Track refresh metrics
def _refresh_background(self, key, ttl_seconds, loader_func):
    start_time = time.time()
    try:
        data = loader_func(key)
        self.redis.set(key, json.dumps(data), ex=ttl_seconds)

        # Log metrics
        metrics.increment("cache.refresh_ahead.success")
        metrics.timing("cache.refresh_ahead.duration", time.time() - start_time)
    except Exception as e:
        metrics.increment("cache.refresh_ahead.failure")
        raise
```

**3. Combining with Cache Warming:**

```python
# Warm cache with refresh-ahead for critical data
critical_keys = ["dashboard:metrics", "home:feed"]
for key in critical_keys:
    data = load_data(key)
    # Store with refresh-ahead TTL
    redis.set(key, json.dumps(data), ex=300)  # 5 min

# Refresh-ahead will keep it fresh automatically
```

---

### 10. Cache Stampede Prevention

**The Pattern:**

When a popular cache entry expires, multiple concurrent requests may try to recompute it simultaneously (thundering herd). Use distributed locking to ensure only one request recomputes while others wait.

**The Problem:**

```
Cache key expires
↓
100 concurrent requests arrive
↓
All 100 see cache miss
↓
All 100 query database simultaneously
↓
Database overload! 💥
```

**The Solution:**

```
Cache key expires
↓
100 concurrent requests arrive
↓
Request 1: Acquires lock, computes value
Requests 2-100: See lock exists, wait and retry cache
↓
Request 1: Stores result, releases lock
Requests 2-100: Cache hit! ✅
```

**Redis Implementation:**

```python
import time
import random

class StampedePreventionCache:
    def __init__(self, redis_client):
        self.redis = redis_client

    def get(self, key, ttl_seconds, loader_func, lock_ttl=10):
        # Try cache first
        cached = self.redis.get(key)
        if cached:
            return json.loads(cached)

        # Cache miss - try to acquire lock
        lock_key = f"lock:{key}"

        # SET lock NX (only if not exists) EX (with expiration)
        lock_acquired = self.redis.set(
            lock_key,
            "1",
            nx=True,  # Only set if not exists
            ex=lock_ttl  # Lock expires after 10 seconds
        )

        if lock_acquired:
            # We got the lock - compute the value
            try:
                data = loader_func(key)
                self.redis.set(key, json.dumps(data), ex=ttl_seconds)
                return data
            finally:
                # Release lock
                self.redis.delete(lock_key)
        else:
            # Someone else is computing - wait and retry
            return self._wait_for_cache(key, max_retries=10)

    def _wait_for_cache(self, key, max_retries):
        for attempt in range(max_retries):
            # Wait a bit
            time.sleep(0.1 + random.uniform(0, 0.1))  # 100-200ms with jitter

            # Try cache again
            cached = self.redis.get(key)
            if cached:
                return json.loads(cached)

        # Timeout - return None or raise exception
        raise TimeoutError(f"Waited too long for {key} to be cached")

# Usage
cache = StampedePreventionCache(redis)

def expensive_query(key):
    # Simulates slow database query
    time.sleep(2)
    return {"data": f"Result for {key}"}

# Even with 100 concurrent requests, only one computes
result = cache.get("expensive:report", ttl_seconds=60, loader_func=expensive_query)
```

**Redis Commands:**

- `SET lock:key value NX EX seconds` - Acquire distributed lock
- `DEL lock:key` - Release lock
- `GET key` - Check cache

**Atomic Lock Acquisition:**

```python
# The key Redis command for stampede prevention:
SET lock:mykey "1" NX EX 10

# Breakdown:
# SET - Set key
# lock:mykey - Lock key name
# "1" - Lock value (doesn't matter)
# NX - Only set if Not eXists (atomic check-and-set)
# EX 10 - Expire in 10 seconds (auto-release if holder crashes)
```

**When to Use:**

✅ **Use when:**

- Very expensive operations (seconds to compute)
- High concurrency (many simultaneous requests)
- Popular data requested by many clients
- Database/API can't handle concurrent load
- Cache misses are rare but catastrophic

❌ **Avoid when:**

- Operations are fast (< 100ms)
- Low concurrency (< 10 concurrent requests)
- Added latency is unacceptable
- Operations are idempotent and cheap to repeat

**Pros & Cons:**

| Pros                              | Cons                                 |
| --------------------------------- | ------------------------------------ |
| Prevents thundering herd          | Waiting requests have higher latency |
| Reduces backend load dramatically | Lock contention possible             |
| Only one expensive computation    | Complexity in error handling         |
| Protects database from overload   | Lock holder failure delays all       |
| Works across multiple servers     | Need to tune lock timeout            |

**Real-World Use Cases:**

- Analytics reports (expensive aggregations)
- Search index building
- Machine learning model inference
- Complex dashboard queries
- Popular API endpoints (trending posts)
- Report generation

**Advanced: Probabilistic Early Expiration**

Prevent stampede by randomly refreshing before TTL expires:

```python
def get_with_beta_expiration(key, ttl_seconds, loader_func, beta=1.0):
    """
    XFetch algorithm - probabilistically refresh before expiration
    beta: controls refresh probability (1.0 = balanced)
    """
    cached = self.redis.get(key)

    if cached:
        current_ttl = self.redis.ttl(key)

        # Calculate refresh probability
        # Higher as TTL decreases, higher for expensive operations
        delta = time.time() - cache_timestamp(cached)
        refresh_probability = delta * beta * math.log(random.random()) / current_ttl

        if refresh_probability > 1:
            # Refresh now (probabilistic)
            data = loader_func(key)
            self.redis.set(key, json.dumps(data), ex=ttl_seconds)
            return data

        return json.loads(cached)

    # Cache miss - use locking
    return self.get_with_lock(key, ttl_seconds, loader_func)
```

**Considerations:**

**1. Lock Timeout:**

```python
# Lock timeout should be:
# - Longer than expected operation time
# - Short enough to prevent long waits if holder crashes

# Example:
# Operation takes 2-3 seconds normally
lock_ttl = 10  # 10 seconds - enough buffer
```

**2. Retry Strategy:**

```python
def _wait_for_cache(self, key, max_retries=10):
    for attempt in range(max_retries):
        # Exponential backoff with jitter
        backoff = min(0.1 * (2 ** attempt), 1.0)  # Max 1 second
        jitter = random.uniform(0, 0.1)
        time.sleep(backoff + jitter)

        cached = self.redis.get(key)
        if cached:
            return json.loads(cached)

    raise TimeoutError(f"Cache stampede timeout for {key}")
```

**3. Monitoring:**

```python
# Track stampede prevention metrics
if lock_acquired:
    metrics.increment("cache.stampede.lock_acquired")
    start = time.time()
    try:
        data = loader_func(key)
        metrics.timing("cache.stampede.compute_time", time.time() - start)
    finally:
        self.redis.delete(lock_key)
else:
    metrics.increment("cache.stampede.lock_wait")
```

**4. Combining with Refresh-Ahead:**

```python
# Best practice: Use both patterns
# - Refresh-ahead prevents most stampedes
# - Stampede prevention handles edge cases

class HybridCache:
    def get(self, key, ttl_seconds, loader_func):
        cached = self.redis.get(key)

        if cached:
            current_ttl = self.redis.ttl(key)

            # Refresh-ahead for frequently accessed data
            if current_ttl < ttl_seconds * 0.2:
                self._refresh_background(key, ttl_seconds, loader_func)

            return json.loads(cached)

        # Cache miss - use stampede prevention
        return self._get_with_lock(key, ttl_seconds, loader_func)
```

---

## Pattern Selection Guide

Choosing the right caching pattern depends on your requirements. Use this decision tree:

### Decision Tree

```
START: Need to cache data?
│
├─ Mainly READ operations?
│  │
│  ├─ Application should manage cache?
│  │  └─ ✅ Cache-Aside (default choice)
│  │
│  └─ Want cache abstraction layer?
│     └─ ✅ Read-Through
│
├─ Mainly WRITE operations?
│  │
│  ├─ Need strong consistency?
│  │  └─ ✅ Write-Through
│  │
│  ├─ Need high write performance?
│  │  │
│  │  ├─ Can tolerate data loss?
│  │  │  └─ ✅ Write-Behind
│  │  │
│  │  └─ Data rarely read after write?
│  │     └─ ✅ Write-Around
│
├─ Need automatic expiration?
│  │
│  ├─ Data has natural lifetime?
│  │  └─ ✅ TTL
│  │
│  └─ Limited cache memory?
│     └─ ✅ LRU/LFU Eviction
│
└─ Special requirements?
   │
   ├─ Prevent cold start?
   │  └─ ✅ Cache Warming
   │
   ├─ Expensive operation must always be fast?
   │  └─ ✅ Refresh-Ahead
   │
   └─ High concurrency on same key?
      └─ ✅ Stampede Prevention
```

### Pattern Comparison Matrix

| Pattern                 | Consistency | Performance                    | Complexity | Memory Efficiency | Use Case                |
| ----------------------- | ----------- | ------------------------------ | ---------- | ----------------- | ----------------------- |
| **Cache-Aside**         | Eventual    | Read: High, Write: N/A         | Low        | High              | General purpose         |
| **Read-Through**        | Eventual    | Read: High                     | Medium     | High              | Abstraction layer       |
| **Write-Through**       | Strong      | Read: High, Write: Low         | Medium     | High              | Critical consistency    |
| **Write-Behind**        | Eventual    | Read: High, Write: Very High   | High       | High              | High write volume       |
| **Write-Around**        | Strong      | Read: Low (first), Write: High | Low        | Very High         | Rarely read data        |
| **TTL**                 | Time-bound  | High                           | Low        | High              | Time-sensitive data     |
| **LRU/LFU**             | N/A         | High                           | Low        | Very High         | Limited memory          |
| **Cache Warming**       | N/A         | Very High                      | Medium     | Medium            | Predictable access      |
| **Refresh-Ahead**       | Eventual    | Very High                      | High       | Medium            | Hot data, expensive ops |
| **Stampede Prevention** | Eventual    | High                           | High       | High              | High concurrency        |

### By Use Case

| Use Case                       | Recommended Pattern(s)                            |
| ------------------------------ | ------------------------------------------------- |
| **E-commerce product catalog** | Cache-Aside + TTL (1 hour) + LRU                  |
| **User session storage**       | Cache-Aside + TTL (30 min)                        |
| **Real-time leaderboard**      | Write-Through + Refresh-Ahead                     |
| **Analytics events**           | Write-Behind                                      |
| **API rate limiting**          | TTL (1 minute windows)                            |
| **User profiles**              | Cache-Aside + TTL (15 min)                        |
| **Popular content**            | Cache-Aside + Refresh-Ahead + Stampede Prevention |
| **Configuration data**         | Cache Warming + Read-Through                      |
| **Search results**             | Cache-Aside + TTL + Stampede Prevention           |
| **Social media feed**          | Write-Through + Refresh-Ahead                     |
| **File uploads (metadata)**    | Write-Around                                      |
| **Dashboard metrics**          | Refresh-Ahead + Stampede Prevention               |

### By Workload Characteristics

| Workload                      | Pattern Choice                      |
| ----------------------------- | ----------------------------------- |
| **Read-heavy (90%+ reads)**   | Cache-Aside + TTL                   |
| **Write-heavy (90%+ writes)** | Write-Behind or Write-Around        |
| **Balanced read/write**       | Write-Through + Cache-Aside         |
| **High concurrency**          | Stampede Prevention + Refresh-Ahead |
| **Predictable access**        | Cache Warming + Refresh-Ahead       |
| **Unpredictable access**      | Cache-Aside + LRU                   |
| **Large dataset**             | LRU/LFU + TTL                       |
| **Critical data**             | Write-Through + Cache Warming       |

### Combining Patterns

Patterns can be combined for optimal results:

**Example 1: E-commerce Product Page**

```python
# Combination: Cache-Aside + TTL + Stampede Prevention
class ProductCache:
    def get_product(self, product_id):
        cache = StampedePreventionCache(redis)
        return cache.get(
            f"product:{product_id}",
            ttl_seconds=3600,  # 1 hour TTL
            loader_func=lambda k: db.get_product(product_id)
        )
```

**Example 2: Real-time Dashboard**

```python
# Combination: Refresh-Ahead + Cache Warming + Stampede Prevention
class DashboardCache:
    def __init__(self):
        # Warm critical dashboards on startup
        self.warm_dashboards(["main", "sales", "inventory"])

    def get_dashboard(self, dashboard_id):
        # Refresh-ahead keeps it fresh
        # Stampede prevention handles concurrent access
        return refresh_ahead_cache.get(
            f"dashboard:{dashboard_id}",
            ttl_seconds=300,  # 5 minutes
            loader_func=lambda k: generate_dashboard(dashboard_id)
        )
```

**Example 3: Session Store**

```python
# Combination: Write-Through + TTL
class SessionStore:
    def save_session(self, session_id, data):
        # Write-Through for consistency
        redis.set(f"session:{session_id}", json.dumps(data), ex=1800)
        db.save_session(session_id, data)

    def get_session(self, session_id):
        # Read from cache (TTL handles expiration)
        cached = redis.get(f"session:{session_id}")
        return json.loads(cached) if cached else None
```

---

## Implementation Details

This section covers the REST API implementation provided in this project for testing and learning.

### Quick Start

```bash
# Install dependencies
pnpm install

# Start Valkey container
pnpm docker:up

# Build the application
pnpm build

# Start the server (port 3002)
pnpm --filter caching dev
```

### Project Structure

```
apps/caching/
├── src/
│   ├── index.ts                          # Express app & server
│   ├── routes/
│   │   ├── read-patterns.ts              # Cache-aside, read-through
│   │   ├── write-patterns.ts             # Write-through, write-behind
│   │   ├── eviction-expiration.ts        # TTL
│   │   └── advanced-patterns.ts          # Warming, refresh-ahead, stampede
│   ├── services/
│   │   ├── interfaces.ts                 # IReadPatternService, IWritePatternService
│   │   ├── read/
│   │   │   ├── cache-aside.service.ts
│   │   │   └── read-through.service.ts
│   │   ├── write/
│   │   │   ├── write-through.service.ts
│   │   │   └── write-behind.service.ts
│   │   ├── eviction-expiration/
│   │   │   └── ttl-cache.service.ts
│   │   └── advanced/
│   │       ├── cache-warming.service.ts
│   │       ├── refresh-ahead.service.ts
│   │       └── stampede-prevention.service.ts
│   └── utils/
│       └── expensive-operation.ts        # Simulation helper
├── package.json
└── tsconfig.json
```

**API Response Format:**

All endpoints return performance metrics:

```typescript
{
  "data": any,
  "metadata": {
    "key": string,
    "source": "cache" | "computed",
    "timeTaken": number,  // milliseconds
    "ttl"?: number        // seconds remaining
  }
}
```

### API Endpoints

#### Read Patterns

```bash
# Cache-Aside
GET /api/read-patterns/cache-aside/:key?delay=1000
DELETE /api/read-patterns/cache-aside/:key

# Read-Through
GET /api/read-patterns/read-through/:key?delay=1000
DELETE /api/read-patterns/read-through/:key
```

**Example:**

```bash
# First request - cache miss (slow)
curl http://localhost:3002/api/read-patterns/cache-aside/user123?delay=2000

# Second request - cache hit (fast)
curl http://localhost:3002/api/read-patterns/cache-aside/user123

# Invalidate
curl -X DELETE http://localhost:3002/api/read-patterns/cache-aside/user123
```

#### Write Patterns

```bash
# Write-Through
POST /api/write-patterns/write-through/:key
# Body: { "value": any, "delay"?: number }
GET /api/write-patterns/write-through/:key

# Write-Behind
POST /api/write-patterns/write-behind/:key
# Body: { "value": any }
GET /api/write-patterns/write-behind/:key
GET /api/write-patterns/write-behind/queue  # View pending writes
```

**Example:**

```bash
# Write-Through
curl -X POST http://localhost:3002/api/write-patterns/write-through/config \
  -H "Content-Type: application/json" \
  -d '{"value": {"theme": "dark"}}'

# Write-Behind (fast response)
curl -X POST http://localhost:3002/api/write-patterns/write-behind/event \
  -H "Content-Type: application/json" \
  -d '{"value": {"action": "click", "count": 1}}'

# Check queue
curl http://localhost:3002/api/write-patterns/write-behind/queue
```

#### Eviction & Expiration

```bash
# TTL
GET /api/eviction-expiration/ttl/:key?delay=1000&ttl=60
DELETE /api/eviction-expiration/ttl/:key
```

**Example:**

```bash
# Store with 30 second TTL
curl http://localhost:3002/api/eviction-expiration/ttl/session123?ttl=30

# Check remaining TTL
curl http://localhost:3002/api/eviction-expiration/ttl/session123

# Wait and retry (will be expired)
sleep 35 && curl http://localhost:3002/api/eviction-expiration/ttl/session123
```

#### Advanced Patterns

```bash
# Cache Warming
POST /api/advanced-patterns/cache-warming
# Body: { "keys": ["key1", "key2"], "delay"?: number }
GET /api/advanced-patterns/cache-warming/:key

# Refresh-Ahead
GET /api/advanced-patterns/refresh-ahead/:key?delay=1000&ttl=60&refreshThreshold=0.8
GET /api/advanced-patterns/refresh-ahead/:key/status

# Stampede Prevention
GET /api/advanced-patterns/stampede-prevention/:key?delay=2000&ttl=60
```

**Examples:**

```bash
# Cache Warming
curl -X POST http://localhost:3002/api/advanced-patterns/cache-warming \
  -H "Content-Type: application/json" \
  -d '{"keys": ["product1", "product2", "product3"]}'

# Refresh-Ahead
curl http://localhost:3002/api/advanced-patterns/refresh-ahead/dashboard?ttl=60&refreshThreshold=0.8

# Stampede Prevention (concurrent requests)
for i in {1..10}; do
  curl http://localhost:3002/api/advanced-patterns/stampede-prevention/expensive?delay=3000 &
done
```

### Testing Scenarios

#### 1. Cache-Aside Performance

```bash
# Measure cache miss
time curl http://localhost:3002/api/read-patterns/cache-aside/test1?delay=2000
# ~2000ms

# Measure cache hit
time curl http://localhost:3002/api/read-patterns/cache-aside/test1
# ~5ms (400x faster!)
```

#### 2. Write-Behind Queue

```bash
# Generate 5 writes
for i in {1..5}; do
  curl -X POST http://localhost:3002/api/write-patterns/write-behind/event$i \
    -H "Content-Type: application/json" \
    -d "{\"value\": {\"count\": $i}}"
done

# Check queue
curl http://localhost:3002/api/write-patterns/write-behind/queue
# Returns: 5 pending writes

# Wait for worker (5 seconds)
sleep 6

# Queue empty
curl http://localhost:3002/api/write-patterns/write-behind/queue
# Returns: 0 pending writes
```

#### 3. Stampede Prevention

```bash
# Terminal 1: Monitor
watch -n 1 'curl -s http://localhost:3002/api/advanced-patterns/stampede-prevention/expensive'

# Terminal 2: Generate stampede (20 concurrent requests)
for i in {1..20}; do
  curl http://localhost:3002/api/advanced-patterns/stampede-prevention/expensive?delay=5000 &
done

# Observe:
# - First request: ~5000ms (computes)
# - Other 19 requests: ~100-500ms (wait for cache)
# - Only 1 database query instead of 20!
```

### Performance Metrics

Expected timings from the demo API:

| Operation              | Cache Hit   | Cache Miss  | Speedup   |
| ---------------------- | ----------- | ----------- | --------- |
| Cache-Aside            | 1-5ms       | 1000-3000ms | 200-3000x |
| Write-Through (read)   | 1-5ms       | N/A         | N/A       |
| Write-Through (write)  | 1000-2000ms | N/A         | N/A       |
| Write-Behind (write)   | 1-5ms       | N/A         | 200-2000x |
| Stampede (1st request) | N/A         | 2000-5000ms | N/A       |
| Stampede (2nd-Nth)     | 100-500ms   | N/A         | 5-50x     |

### Redis Commands Reference

| Pattern             | Redis Commands                                        |
| ------------------- | ----------------------------------------------------- |
| Cache-Aside         | `GET`, `SET`, `DEL`                                   |
| Read-Through        | `GET`, `SET`, `DEL`                                   |
| Write-Through       | `SET`, `GET`                                          |
| Write-Behind        | `SET`, `LPUSH`, `RPOP`, `LLEN`, `LRANGE`              |
| TTL                 | `SET ... EX`, `TTL`, `PTTL`, `EXPIRE`                 |
| LRU/LFU             | `CONFIG SET maxmemory`, `CONFIG SET maxmemory-policy` |
| Cache Warming       | `SET`, `MSET`, Pipeline                               |
| Refresh-Ahead       | `GET`, `TTL`, `SET ... EX`                            |
| Stampede Prevention | `SET ... NX EX`, `GET`, `DEL`                         |
