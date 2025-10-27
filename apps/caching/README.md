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

### Key Naming & Serialization

Before diving into patterns, consider these foundational best practices:

- **Key Naming Convention**: Adopt a consistent key schema to avoid collisions and improve debuggability. A common pattern is `object-type:id:field`.
  - **Good**: `user:123:profile`, `product:456:details`
  - **Bad**: `123`, `user_123`
- **Serialization**: Data must be stored as a string. Choose a format based on your needs.
  - **JSON**: Human-readable, widely supported. Good for complex objects.
  - **MessagePack/Protobuf**: Binary formats that are faster and more space-efficient than JSON.
  - **Plain String**: For simple values.

---

## Pattern Categories

This guide covers 10 caching patterns organized into four categories:

1. **[Read Patterns](#read-patterns)**: [Cache-Aside](#1-cache-aside-lazy-loading), [Read-Through](#2-read-through)
2. **[Write Patterns](#write-patterns)**: [Write-Through](#3-write-through), [Write-Behind](#4-write-behind-write-back), [Write-Around](#5-write-around)
3. **[Eviction & Expiration Strategies](#eviction--expiration-strategies)**: [TTL](#6-ttl-time-to-live), [LRU/LFU Eviction](#7-lrulfu-eviction)
4. **[Advanced Patterns](#advanced-patterns)**: [Cache Warming](#8-cache-warming-pre-loading), [Refresh-Ahead](#9-refresh-ahead), [Cache Stampede Prevention](#10-cache-stampede-prevention)

---

## Read Patterns

Read patterns define how your application retrieves data and populates the cache.

### 1. Cache-Aside (Lazy Loading)

**The Pattern:** The most common caching pattern where the application code explicitly manages the cache:

```
1. Application requests data by key
2. Check cache first (GET key)
3a. Cache HIT → Return cached data immediately
3b. Cache MISS → Load from source (database/API)
4. Store in cache (SET key value)
5. Return data to application
```

**Redis Commands:** `GET key`, `SET key value`, `DEL key`

---

### 2. Read-Through

**The Pattern:** A cache abstraction where the cache itself is responsible for loading data from the source. The application always interacts with the cache, which transparently handles cache misses.

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

**Redis Commands:** `GET key`, `SET key value`, `DEL key` (same as Cache-Aside, architectural difference)

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

**The Pattern:** Every write goes through the cache to the source. Both cache and source are updated synchronously before the write is considered complete.

```
1. Application writes data
2. Write to source (database UPDATE) - synchronous, ensures durability
3. Write to cache (SET key value) - for fast subsequent reads
4. Both writes must succeed
5. Return success to application
```

**Redis Commands:** `SET key value`, `DEL key`

---

### 4. Write-Behind (Write-Back)

**The Pattern:** Writes go to cache immediately and return. The write to the source happens asynchronously in the background. This provides fast write performance at the cost of eventual consistency.

```
1. Application writes data
2. Write to cache immediately (SET key value)
3. Add write to a reliable queue (XADD write-queue * key value)
4. Return success to application (fast!)
5. Background worker processes queue (XREADGROUP GROUP group1 consumer1 COUNT 1 STREAMS write-queue >)
6. Worker writes to source asynchronously
7. Acknowledge message (XACK write-queue group1 message-id)
```

**Redis Commands:** `SET key value`, `XADD`, `XREADGROUP`, `XACK` (using Streams for a reliable queue). The classic approach uses `LPUSH`/`RPOP`, but Streams are more robust against worker failures.

---

### 5. Write-Around

**The Pattern:** Writes bypass the cache entirely and go directly to the source. To prevent serving stale data, the corresponding cache key is invalidated. Data is only cached on the next read.

```
1. Application writes data
2. Write directly to source (bypass cache)
3. Invalidate cache entry (DEL key)
4. Return success
5. Next read will be a cache miss
6. Cache populated on read (using cache-aside)
```

**Redis Commands:** `DEL key` (to prevent stale reads)

---

## Eviction & Expiration Strategies

How do you remove data from cache? Two approaches: time-based (TTL) and space-based (eviction policies).

### 6. TTL (Time-To-Live)

**The Pattern:** Cache entries automatically expire after a specified duration. Redis handles deletion automatically.

```
1. Store data with TTL (SET key value EX seconds)
2. Redis automatically deletes key after TTL expires
3. Next read will be a cache miss
4. No manual cleanup required
```

**Redis Commands:** `SET key value EX seconds`, `SETEX key seconds value`, `EXPIRE key seconds`, `TTL key`, `PTTL key`

**TTL Strategies:**

| Strategy         | TTL Duration | Use Case                        |
| ---------------- | ------------ | ------------------------------- |
| Short (seconds)  | 1-60s        | Real-time data, rate limiting   |
| Medium (minutes) | 1-60m        | Session data, API responses     |
| Long (hours)     | 1-24h        | Product catalogs, user profiles |
| Very Long (days) | 1-7d         | Static content, configurations  |

---

### 7. LRU/LFU Eviction

**The Pattern:** When cache memory is full, Redis automatically evicts entries based on access patterns. This is configured at the Redis server level, not in application code.

```
1. Redis hits configured memory limit (maxmemory)
2. Redis needs to store new data
3. Redis evicts keys based on eviction policy
4. New data is stored
5. Application is unaware (transparent)
```

**Redis Configuration:** `CONFIG SET maxmemory 100mb`, `CONFIG SET maxmemory-policy allkeys-lru`

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

---

## Advanced Patterns

Advanced patterns combine multiple caching techniques to solve specific performance challenges.

---

### 8. Cache Warming (Pre-loading)

**The Pattern:** Proactively load data into cache before it's requested, typically during application startup or off-peak hours.

```
1. Application starts or scheduled job runs
2. Identify critical/popular keys
3. Load data from source
4. Store in cache (batch SET operations)
5. Cache is "warm" - no cold start
6. First user requests are cache hits
```

**Redis Commands:** `SET key value`, `MSET key1 value1 key2 value2 ...`, Pipeline

---

### 9. Refresh-Ahead

**The Pattern:** Proactively refresh cached data before it expires. When a cache hit occurs and TTL is low, trigger a background refresh while returning the current cached value.

```
1. Request arrives for key
2. Check cache (GET key)
3. Cache HIT - check TTL (TTL key)
4. If TTL < threshold (e.g., 20% of original TTL):
   a. Return current cached value immediately (fast)
   b. Try to acquire a lock (to prevent multiple refreshes)
   c. If lock acquired, trigger background refresh asynchronously
5. Background: Load new data, update cache, release lock
6. Next request gets fresh data
```

**Redis Commands:** `GET key`, `TTL key`, `SET key value EX seconds`, `SET lock:key ... NX EX ...`

**Refresh Threshold Strategies:**

| Threshold | When TTL = 60s     | Behavior                  |
| --------- | ------------------ | ------------------------- |
| 0.1 (10%) | Refresh when < 6s  | Aggressive - always fresh |
| 0.2 (20%) | Refresh when < 12s | Balanced - good default   |
| 0.5 (50%) | Refresh when < 30s | Conservative - less load  |

---

### 10. Cache Stampede Prevention

**The Pattern:** When a popular cache entry expires, multiple concurrent requests may try to recompute it simultaneously (thundering herd). Use distributed locking to ensure only one request recomputes while others wait.

**The Problem:**

```
Cache expires → 100 concurrent requests → All see cache miss
→ All 100 query database simultaneously → Database overload! 💥
```

**The Solution:** Combine three implementation aspects:

#### **1. Lock Acquisition Strategy**

Acquire an exclusive lock using `SET lock:key unique_token NX EX 10`:

- `NX` ensures only one request gets the lock (atomic test-and-set)
- `EX 10` auto-expires lock after 10s (prevents deadlock if holder crashes)
- `unique_token` enables safe lock release (only lock owner can delete)

#### **2. Lock Release Strategy**

Release lock atomically using Lua script to verify ownership:

```lua
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
```

This prevents releasing another request's lock if the first request times out.

#### **3. Waiting Strategy for Lock Holders**

When lock acquisition fails, requests need to wait. Two approaches:

---

##### **Approach A: Polling Pattern**

**Strategy:** Repeatedly check cache until data appears.

```
Request 1: Acquires lock → Computes (2000ms) → Writes cache → Releases lock
Request 2-100: Poll cache every 50ms → Eventually see data
```

**Implementation:**

```javascript
while (!cacheData && attempts < maxAttempts) {
  await sleep(50);
  cacheData = await redis.get(key);
  attempts++;
}
```

**Trade-offs:**

- ✅ Simple: No additional Redis features, predictable behavior
- ✅ Safe: No message loss or timing edge cases
- ❌ Network traffic: 100 requests × 40 polls = 4,000 operations
- ❌ Latency variance: 0-50ms depending on poll timing
- ❌ Resource waste: CPU cycles in busy-wait loops

**Best for:** Moderate concurrency (<50 requests), short compute times (<1s), simplicity priority

---

##### **Approach B: Pub/Sub Pattern** ⭐ _Implemented_

**Strategy:** Sleep until lock holder publishes "data ready" notification.

```
Request 1: Acquires lock → Computes (2000ms) → Writes cache → PUBLISH "ready:key"
Request 2-100: SUBSCRIBE "ready:key" → Sleep → Wake instantly on publish
```

**Implementation:**

```javascript
await new Promise(resolve => {
  const subscriber = redis.duplicate();
  subscriber.subscribe(`cache-ready:${key}`);
  subscriber.on('message', () => {
    subscriber.quit();
    resolve();
  });
  setTimeout(resolve, timeout); // Fallback
});
```

**Trade-offs:**

- ✅ Efficient: ~201 operations (1 lock + 100 subscribe + 100 wake)
- ✅ Instant wake-up: No latency variance (<5ms)
- ✅ Scalable: Constant overhead regardless of concurrency
- ❌ Complexity: Requires Pub/Sub, timing edge cases (subscribe before publish)
- ❌ Debugging: Harder to trace message flow

**Best for:** High concurrency (>100 requests), expensive operations (>2s), production systems

---

##### **Performance Comparison**

| Metric                                    | Polling           | Pub/Sub             |
| ----------------------------------------- | ----------------- | ------------------- |
| **Total Redis ops** (100 req, 2s compute) | ~4,000            | ~201                |
| **Wake-up latency**                       | 0-50ms (variable) | <5ms (instant)      |
| **CPU usage**                             | High (busy-wait)  | Low (true sleep)    |
| **Code complexity**                       | Simple (~50 LOC)  | Moderate (~100 LOC) |
| **Edge cases**                            | None              | Subscription timing |
| **Scalability**                           | O(n) per request  | O(1) constant       |

**Implementation Choice:** This project uses **Pub/Sub** because cache stampede prevention targets expensive operations where high concurrency is expected. For simpler scenarios (moderate load, short computes), polling may suffice.

**Redis Commands:** `SET lock:key token NX EX`, `GET lock:key`, Lua script for `DEL`, `PUBLISH channel`, `SUBSCRIBE channel`

---

## Pattern Comparison Table

### Complete Pattern Analysis

| Pattern                 | Pros                                                                                                                                                         | Cons                                                                                                                                                             | When to Use                                                                                                                                            | When NOT to Use                                                                                                             | Real-World Use Cases                                                                                         | Key Considerations                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| **Cache-Aside**         | • Simple to implement<br>• Only requested data cached<br>• Full application control<br>• Works with any data source<br>• Cache failure doesn't break app     | • Cache miss penalty (first request slow)<br>• Potential stale data<br>• Tight coupling to cache<br>• Each miss hits source<br>• Three round trips on miss       | • Read-heavy workloads<br>• Acceptable cache misses<br>• Need full control<br>• Different data requirements<br>• Default choice                        | • Need guaranteed consistency<br>• Cache misses unacceptable<br>• App should be cache-agnostic                              | • Product catalogs<br>• User profiles<br>• CMS articles<br>• API responses<br>• DNS lookups                  | • Invalidation strategy<br>• Cache key design<br>• Serialization format<br>• Error handling                  |
| **Read-Through**        | • Cleaner app code<br>• Consistent interface<br>• Easier testing<br>• Centralized logic<br>• Easy to add features                                            | • Cache must know data loading<br>• Less flexible than cache-aside<br>• Complex cache implementation<br>• Cache coupled to source<br>• Overkill for simple cases | • Simplify app code<br>• Consistent loading logic<br>• Reusable caching layer<br>• Swap implementations easily                                         | • Different loading strategies<br>• Cache can't access source<br>• Need fine-grained control                                | • Caching frameworks<br>• ORM caching<br>• GraphQL DataLoaders<br>• Hibernate cache                          | • Data loader config<br>• Error handling<br>• Monitoring hit ratio                                           |
| **Write-Through**       | • Cache & source always consistent<br>• No misses on recent writes<br>• Simple consistency model<br>• Immediate durability<br>• Easier to reason about       | • Slower writes (both systems)<br>• Write penalty if never read<br>• Increased write latency<br>• Source is bottleneck<br>• Both systems must be available       | • Consistency critical<br>• Reads >> writes<br>• Read-after-write pattern<br>• Can tolerate slow writes<br>• Compliance needs                          | • Write performance critical<br>• High write volume<br>• Rarely read back<br>• Expensive writes                             | • Account settings<br>• Shopping carts<br>• Configuration<br>• Transactions<br>• User preferences            | • Transaction management<br>• Rollback strategy<br>• Write amplification<br>• Network failures               |
| **Write-Behind**        | • Fastest write performance<br>• Reduced source load<br>• Can batch writes<br>• Improved throughput<br>• Better resource use                                 | • Data loss risk (cache crash)<br>• Temporary inconsistency<br>• Complex error handling<br>• Monitor queue depth<br>• Harder debugging                           | • Write performance critical<br>• Tolerate eventual consistency<br>• High write volume<br>• Expensive writes<br>• Batch writes possible                | • Need immediate consistency<br>• Cannot tolerate data loss<br>• Need persistence confirmation<br>• Compliance requirements | • Analytics/events<br>• Logging/metrics<br>• Social counters<br>• Dashboards<br>• Page views                 | • Queue management<br>• Failure handling<br>• Data loss risk<br>• Batching strategy<br>• Worker scaling      |
| **Write-Around**        | • Prevents cache pollution<br>• Faster writes<br>• Better for write-heavy<br>• Simpler write logic<br>• No write amplification                               | • Every post-write read is miss<br>• Higher first read latency<br>• Wasted space if not invalidated<br>• May serve stale data<br>• Not for read-after-write      | • Written once, rarely read<br>• Prevent cache pollution<br>• Write-heavy workloads<br>• Large uncacheable data<br>• Bulk imports                      | • Frequent read-after-write<br>• Balanced read/write<br>• Cache hit rate important                                          | • Logging systems<br>• Bulk imports<br>• Archival<br>• File uploads<br>• Time-series writes                  | • Always invalidate on write<br>• Cache warming for reads<br>• Monitor miss rate                             |
| **TTL**                 | • Automatic cleanup<br>• Simple implementation<br>• Predictable memory<br>• No stale data after TTL<br>• Works with cache-aside                              | • Stale until expiration<br>• Miss if TTL too short<br>• Wasted space if too long<br>• Cold start after expiry<br>• Hard to choose right TTL                     | • Natural expiration time<br>• Stale data acceptable<br>• Want automatic cleanup<br>• Predictable memory<br>• Sessions/tokens/OTPs                     | • Data never stale<br>• Need immediate invalidation<br>• Hard to determine TTL<br>• Unpredictable access                    | • Sessions (30min)<br>• Rate limits (1min)<br>• OTP codes (5min)<br>• OAuth tokens (1hr)<br>• Product prices | • TTL selection<br>• Sliding expiration<br>• TTL jitter<br>• Stale-while-revalidate                          |
| **LRU/LFU**             | • Automatic memory mgmt<br>• Keeps hot data<br>• No code changes<br>• Prevents OOM<br>• Adapts to patterns                                                   | • May evict needed data<br>• Calculation overhead<br>• Requires tuning maxmemory<br>• May cause misses<br>• Not for guaranteed caching                           | • Limited memory<br>• Prevent OOM errors<br>• Access favors hot data<br>• Automatic preferred<br>• Unpredictable data size                             | • All data equally important<br>• Need deterministic caching<br>• Very small cache<br>                                      | Uniformly random access                                                                                      | • Shared Redis instances<br>• Multi-tenant caching<br>• Hot data retention<br>• CDN<br>• Query caching       | • Memory sizing<br>• Policy selection<br>• Monitoring evictions<br>• Combine with TTL         |
| **Cache Warming**       | • Eliminates cold start<br>• Consistent performance<br>• Better UX<br>• Reduced post-deploy load<br>• Off-peak warming                                       | • Startup overhead<br>• May waste space<br>• Need access pattern knowledge<br>• May be stale immediately<br>• Identify what to warm                              | • Predictable access<br>• Avoid cold start<br>• After deployment<br>                                                                                   | Scheduled warming<br>• Critical always-fast data                                                                            | • Unpredictable patterns<br>• Very limited space<br>• Frequently changing data<br>• Warming cost > miss cost | • App deployment<br>• Popular products<br>• Trending content<br>• VIP users<br>• Nav menus                   | • What to warm<br>• When to warm<br>• How much<br>• TTL on warmed data<br>• Monitor warming   |
| **Refresh-Ahead**       | • Consistent fast performance<br>• No miss penalty<br>• Always fresh hot data<br>• Smooth UX<br>• Prevents herd on expiry                                    | • Increased load<br>• May refresh unused data<br>• Complex implementation<br>• Track refreshing keys<br>• Need background workers                                | • Expensive must be fast<br>• Hot data frequent access<br>• Cannot tolerate miss penalty<br>• Stale acceptable temporarily<br>• Read-heavy predictable | • Rarely accessed<br>• Real-time accuracy needed<br>• Very expensive refresh<br>                                            | Low traffic                                                                                                  | • Dashboard metrics<br>• Popular API endpoints<br>• Recommendations<br>• Activity feeds<br>• Common searches | • Refresh threshold<br>• Prevent multiple refreshes<br>• Monitoring<br>• Combine with warming |
| **Stampede Prevention** | • Prevents thundering herd<br>• Dramatically reduces load<br>• One computation<br>• Protects database<br>• Works across servers<br>• Pub/Sub instant wake-up | • Waiting requests lag<br>• Lock contention<br>• Complex error handling<br>• Lock failure delays all<br>• Tune lock timeout<br>• Pub/Sub subscription timing     | • Very expensive ops (>2 seconds)<br>• High concurrency (>100 req)<br>• Popular data<br>• Backend can't handle load<br>• Rare but catastrophic misses  | • Fast ops (<100ms)<br>• Low concurrency<br>• Latency unacceptable<br>• Idempotent cheap ops                                | • Analytics reports<br>• Search indexing<br>• ML inference<br>• Complex dashboards<br>• Trending APIs        | • Lock timeout tuning<br>• Pub/Sub message handling<br>• Monitoring<br>• Combine with refresh-ahead          |

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

```typescript
// Combination: Cache-Aside + TTL + Stampede Prevention
import { StampedePreventionCache } from './cache';
import { db } from './db';

class ProductCache {
  private cache = new StampedePreventionCache(redis);

  public async getProduct(productId: string): Promise<Product> {
    const key = `product:${productId}`;
    return this.cache.get(
      key,
      3600, // 1 hour TTL
      () => db.getProduct(productId)
    );
  }
}
```

**Example 2: Real-time Dashboard**

```typescript
// Combination: Refresh-Ahead + Cache Warming + Stampede Prevention
import { RefreshAheadCache } from './cache';
import { generateDashboard } from './dashboard';

class DashboardCache {
  private cache = new RefreshAheadCache(redis);

  constructor() {
    // Warm critical dashboards on startup
    this.warmDashboards(['main', 'sales', 'inventory']);
  }

  private warmDashboards(ids: string[]): void {
    ids.forEach(id => this.getDashboard(id));
  }

  public async getDashboard(dashboardId: string): Promise<Dashboard> {
    const key = `dashboard:${dashboardId}`;
    return this.cache.get(
      key,
      300, // 5 minute TTL
      () => generateDashboard(dashboardId)
    );
  }
}
```

**Example 3: Session Store**

```typescript
// Combination: Write-Through + TTL
class SessionStore {
  public async saveSession(sessionId: string, data: any): Promise<void> {
    const key = `session:${sessionId}`;
    const value = JSON.stringify(data);

    // Write-Through for consistency
    // Use a MULTI/EXEC transaction to ensure atomicity
    await redis
      .multi()
      .set(key, value, { EX: 1800 }) // Set in cache with 30 min TTL
      .exec();
    await db.saveSession(sessionId, data); // Then save to DB
  }

  public async getSession(sessionId: string): Promise<any | null> {
    const key = `session:${sessionId}`;
    const cached = await redis.get(key);
    return cached ? JSON.parse(cached) : null;
  }
}
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
│   │   ├── write-patterns.ts             # Write-through, write-behind, write-around
│   │   ├── eviction-expiration.ts        # TTL
│   │   └── advanced-patterns.ts          # Warming, refresh-ahead, stampede
│   ├── services/
│   │   ├── interfaces.ts                 # IReadPatternService, IWritePatternService
│   │   ├── read/
│   │   │   ├── cache-aside.service.ts
│   │   │   └── read-through.service.ts
│   │   ├── write/
│   │   │   ├── write-through.service.ts
│   │   │   ├── write-behind.service.ts
│   │   │   └── write-around.service.ts
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
GET /api/write-patterns/write-behind-queue/stats  # View queue statistics

# Write-Around
POST /api/write-patterns/write-around/:key
# Body: { "value": any, "delay"?: number }
```

**Examples:**

```bash
# Write-Through (slow but consistent)
curl -X POST http://localhost:3002/api/write-patterns/write-through/config \
  -H "Content-Type: application/json" \
  -d '{"value": {"theme": "dark"}}'
# Returns: {"success":true,"metadata":{"key":"config","timeTaken":1002,"writtenToCache":true,"writtenToSource":true}}

# Write-Behind (fast, queued for persistence)
curl -X POST http://localhost:3002/api/write-patterns/write-behind/event \
  -H "Content-Type: application/json" \
  -d '{"value": {"action": "click", "count": 1}}'
# Returns: {"success":true,"metadata":{"key":"event","timeTaken":2,"writtenToCache":true,"writtenToSource":false}}

# Read from cache (write-behind)
curl http://localhost:3002/api/write-patterns/write-behind/event
# Returns: {"data":{"action":"click","count":1},"metadata":{"key":"event","source":"cache","timeTaken":1}}

# Check queue statistics
curl http://localhost:3002/api/write-patterns/write-behind-queue/stats
# Returns: {"queue":"write-behind","stats":{"totalPendingMessages":0,"totalStreamLength":5,"activeConsumers":1},"description":{...}}
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
GET /api/advanced-patterns/refresh-ahead/:key
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

#### 2. Write-Behind Performance

```bash
# Test fast write performance
time curl -X POST http://localhost:3002/api/write-patterns/write-behind/event1 \
  -H "Content-Type: application/json" \
  -d '{"value": {"action": "click", "count": 1}}'
# Response: ~1-5ms (fast! write is queued)
# Returns: {"success":true,"metadata":{"key":"event1","timeTaken":2,"writtenToCache":true,"writtenToSource":false}}

# Read back from cache
curl http://localhost:3002/api/write-patterns/write-behind/event1
# Response: immediate cache hit
# Returns: {"data":{"action":"click","count":1},"metadata":{"key":"event1","source":"cache","timeTaken":1}}
```

#### 3. Write-Behind Queue Monitoring

```bash
# Generate 5 writes to queue
curl -s -X POST http://localhost:3002/api/write-patterns/write-behind/event1 -H "Content-Type: application/json" -d '{"value": {"count": 1}}'
curl -s -X POST http://localhost:3002/api/write-patterns/write-behind/event2 -H "Content-Type: application/json" -d '{"value": {"count": 2}}'
curl -s -X POST http://localhost:3002/api/write-patterns/write-behind/event3 -H "Content-Type: application/json" -d '{"value": {"count": 3}}'
curl -s -X POST http://localhost:3002/api/write-patterns/write-behind/event4 -H "Content-Type: application/json" -d '{"value": {"count": 4}}'
curl -s -X POST http://localhost:3002/api/write-patterns/write-behind/event5 -H "Content-Type: application/json" -d '{"value": {"count": 5}}'

# Check queue statistics immediately
curl http://localhost:3002/api/write-patterns/write-behind-queue/stats
# Returns queue statistics:
# {
#   "queue": "write-behind",
#   "stats": {
#     "totalPendingMessages": 0-5,        // Messages delivered but not yet acked
#     "totalStreamLength": 5+,            // All messages in stream (includes processed)
#     "activeConsumers": 1,               // Number of active workers
#     "oldestPendingMs": 100              // Age of oldest pending message (if any)
#   },
#   "description": { ... }
# }

# Wait for worker to process (5 seconds)
sleep 6

# Check queue again (should be processed)
curl http://localhost:3002/api/write-patterns/write-behind-queue/stats
# Returns: totalPendingMessages should be 0 (all processed and acknowledged)

# Check server logs to see:
# [Write-Behind] Processing write for key: event1
# [Write-Behind] Successfully wrote to database: event1
# ... (for each event)
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

| Operation              | Cache Hit | Cache Miss  | Speedup   | Notes                                      |
| ---------------------- | --------- | ----------- | --------- | ------------------------------------------ |
| Cache-Aside            | 1-5ms     | 1000-3000ms | 200-3000x | First read slow, subsequent reads fast     |
| Write-Through (read)   | 1-5ms     | N/A         | N/A       | Always fast reads after write              |
| Write-Through (write)  | N/A       | 1000-2000ms | N/A       | Slow writes (source + cache)               |
| Write-Behind (read)    | 1-5ms     | N/A         | N/A       | Always fast reads after write              |
| Write-Behind (write)   | 1-5ms     | N/A         | 200-2000x | Fast writes (queued), eventual consistency |
| Stampede (1st request) | N/A       | 2000-5000ms | N/A       | Only first request computes                |
| Stampede (2nd-Nth)     | 100-500ms | N/A         | 5-50x     | Other requests wait for cache              |

### Redis Commands Reference

| Pattern             | Redis Commands                                        |
| ------------------- | ----------------------------------------------------- |
| Cache-Aside         | `GET`, `SET`, `DEL`                                   |
| Read-Through        | `GET`, `SET`, `DEL`                                   |
| Write-Through       | `SET`, `GET`                                          |
| Write-Behind        | `SET`, `XADD`, `XREADGROUP`, `XACK`                   |
| TTL                 | `SET ... EX`, `TTL`, `PTTL`, `EXPIRE`                 |
| LRU/LFU             | `CONFIG SET maxmemory`, `CONFIG SET maxmemory-policy` |
| Cache Warming       | `SET`, `MSET`, Pipeline                               |
| Refresh-Ahead       | `GET`, `TTL`, `SET ... EX`                            |
| Stampede Prevention | `SET ... NX EX`, `GET`, `DEL` (often via Lua script)  |
