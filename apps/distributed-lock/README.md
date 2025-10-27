# Distributed Locks with Valkey

A guide to distributed locking patterns using Valkey/Redis for coordinating access to shared resources across distributed systems.

## Table of Contents

- [Introduction](#introduction)
- [Pattern Categories](#pattern-categories)
- [Basic Patterns](#basic-patterns)
- [Advanced Patterns](#advanced-patterns)
- [High-Availability Patterns](#high-availability-patterns)
- [Pattern Comparison](#pattern-comparison)
- [Pattern Selection Guide](#pattern-selection-guide)
- [Safety Guarantees & Limitations](#safety-guarantees--limitations)
- [API Endpoints](#api-endpoints)
- [Running Examples](#running-examples)
- [Further Reading](#further-reading)

---

## Introduction

**Distributed locks** coordinate access to shared resources in distributed systems, preventing race conditions when multiple processes need exclusive access to:

- Shared database records
- File processing tasks
- Configuration updates
- Scheduled jobs (prevent duplicate execution)
- Resource provisioning
- Critical sections in distributed applications

### Why Distributed Locks?

| Problem                           | Solution with Distributed Locks                |
| --------------------------------- | ---------------------------------------------- |
| Multiple workers process same job | Only one worker acquires lock, others skip     |
| Race condition updating record    | Lock ensures sequential access                 |
| Duplicate scheduled tasks         | First instance locks, others see lock and exit |
| Resource exhaustion               | Limit concurrent operations via lock count     |

### The Core Challenge

Unlike single-process locks (mutexes), distributed locks must work across:

- Multiple servers
- Network partitions
- Process crashes
- Redis/Valkey failovers

Each pattern addresses different aspects of this challenge with varying tradeoffs between **safety**, **performance**, and **complexity**.

---

## Pattern Categories

This guide covers **7 distributed locking patterns** organized into three categories:

1. **[Basic Patterns](#basic-patterns)**: Simple Mutex, Retry Lock
2. **[Advanced Patterns](#advanced-patterns)**: Watchdog Lock, Reentrant Lock, Read-Write Lock
3. **[High-Availability Patterns](#high-availability-patterns)**: Fair Lock, Redlock

---

## Basic Patterns

### 1. Simple Mutex (Fail-Fast) ⭐ _Core Implementation_

**The Pattern:** Atomic lock acquisition with immediate failure if unavailable. No waiting, no retries.

```
1. Try to acquire lock: SET lock:resource lockId NX PX ttl
2a. Success (OK) → Execute operation → Release lock
2b. Failure (nil) → Return 409 Conflict with Retry-After
```

**Redis Commands:**

```bash
# Acquire
SET lock:resource "unique-lock-id" NX PX 30000  # Returns: OK or (nil)

# Release (Lua script for atomic check-and-delete)
EVAL "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end" 1 lock:resource "unique-lock-id"

# Check TTL
PTTL lock:resource  # Returns: remaining milliseconds
```

**Key Features:**

- `NX`: Only set if key doesn't exist (atomic test-and-set)
- `PX`: Auto-expire after milliseconds (prevents deadlocks)
- `lockId`: Unique cryptographic token (prevents releasing others' locks)

**When to Use:**

| ✅ Use When                     | ❌ Avoid When                   |
| ------------------------------- | ------------------------------- |
| Short operations (<30s)         | Must eventually succeed         |
| Acceptable to skip if locked    | Long unpredictable operations   |
| High throughput needed          | Operation critical, can't fail  |
| Client can handle 409 responses | Need guaranteed execution order |

**Real-World Use Cases:**

- Scheduled job deduplication: "Skip if already running"
- Cache regeneration: "Don't recompute if someone else is"
- Rate limiting workflows: "Only N concurrent operations"

**TTL Strategy:**

```
Operation duration: 20s
Lock TTL: 25s (5s safety buffer)
Reasoning: If process crashes, lock expires automatically
```

**Pros:**

- ✅ Simple implementation (~50 LOC)
- ✅ Fast fail-fast behavior
- ✅ Low Redis load (1 SET, 1 EVAL)
- ✅ Predictable performance

**Cons:**

- ❌ No retries (clients must implement)
- ❌ Operation must complete within TTL
- ❌ Vulnerable to failover (see [Safety](#safety-guarantees--limitations))

---

### 2. Retry Lock (Spin Lock)

**The Pattern:** Automatically retry lock acquisition with exponential backoff until timeout or success.

```
1. Try to acquire lock
2. If failed:
   a. Check if total time < maxWaitTime
   b. Sleep with exponential backoff (50ms, 100ms, 200ms...)
   c. Retry from step 1
3. If timeout exceeded → Return failure
4. If acquired → Execute operation → Release lock
```

**Redis Commands:** Same as Simple Mutex, but called repeatedly.

**When to Use:**

| ✅ Use When                   | ❌ Avoid When                      |
| ----------------------------- | ---------------------------------- |
| Operation must eventually run | Fail-fast preferred                |
| Lock contention is brief      | High contention (wastes resources) |
| Clients can tolerate latency  | Millisecond-level latency required |
| Acceptable retry overhead     | Large number of concurrent clients |

**Real-World Use Cases:**

- Singleton background job: "Wait for current job to finish"
- Sequential processing: "Wait my turn to process file"
- Graceful degradation: "Try for 5s, then fallback"

**Pros:**

- ✅ Handles transient contention
- ✅ Eventually succeeds if lock becomes available
- ✅ Configurable backoff strategy

**Cons:**

- ❌ Higher Redis load (multiple SET attempts)
- ❌ Wastes CPU/network during wait
- ❌ Thundering herd risk if many clients retry
- ❌ Latency variance (0ms to maxWaitMs)

---

## Advanced Patterns

### 3. Watchdog Lock (Auto-Renewal)

**The Pattern:** Automatically extends lock TTL while operation is running, preventing premature expiration for long/unpredictable operations.

```
1. Acquire lock with initial TTL (e.g., 10s)
2. Start background watchdog thread/interval
3. Watchdog extends TTL every renewInterval (e.g., 5s)
4. Execute operation (can take arbitrarily long)
5. Stop watchdog and release lock
```

**Architecture:**

```
Main Thread                 Watchdog Thread
-----------                 ---------------
Acquire lock (TTL=10s) ───→ Start interval timer
Execute operation...        ├─ Sleep 5s
  still running...          ├─ Extend TTL: PEXPIRE lock:resource 10000
  still running...          ├─ Sleep 5s
  still running...          ├─ Extend TTL: PEXPIRE lock:resource 10000
  completed! ──────────────→ Stop interval
Release lock
```

**Redis Commands:**

```bash
# Initial acquisition
SET lock:resource "lock-id" NX PX 10000

# Watchdog renewal (every 5s)
PEXPIRE lock:resource 10000  # Reset TTL to 10s

# Release
EVAL "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end" 1 lock:resource "lock-id"
```

**TTL Strategy:**

```
Initial TTL: 10s
Renewal interval: 5s (50% of TTL)
Reasoning:
  - Short TTL minimizes lock holding if process crashes
  - Frequent renewal ensures never expires during operation
  - 50% interval provides safety margin for network delays
```

**When to Use:**

| ✅ Use When                             | ❌ Avoid When                              |
| --------------------------------------- | ------------------------------------------ |
| Operation duration unpredictable        | Operation duration known and short (<30s)  |
| Operations can take minutes/hours       | Need simplest possible implementation      |
| Process crash must release lock quickly | Acceptable for operation to have fixed TTL |
| Want short TTL for safety               | Redis load is critical concern             |

**Real-World Use Cases:**

- Video transcoding: Unknown duration, minutes to hours
- Large file processing: Size varies dramatically
- External API calls: Response time unpredictable
- Database migrations: Can take seconds to hours

**Pros:**

- ✅ Supports arbitrarily long operations
- ✅ Short TTL (fast crash recovery)
- ✅ No manual TTL calculation needed

**Cons:**

- ❌ Higher Redis load (periodic PEXPIRE)
- ❌ Requires background thread management
- ❌ Risk of infinite lock if watchdog bug
- ❌ Complexity (~150 LOC vs ~50 LOC)

**Implementation Considerations:**

```typescript
class WatchdogLock {
  private renewalInterval?: NodeJS.Timeout;

  async acquire(resource: string, lockId: string) {
    await redis.set(`lock:${resource}`, lockId, 'PX', 10000, 'NX');
    this.startWatchdog(resource, lockId);
  }

  private startWatchdog(resource: string, lockId: string) {
    this.renewalInterval = setInterval(async () => {
      // Extend TTL only if we still own the lock
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("pexpire", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;
      await redis.eval(script, 1, `lock:${resource}`, lockId, 10000);
    }, 5000); // Renew every 5s
  }

  async release(resource: string, lockId: string) {
    clearInterval(this.renewalInterval); // Stop watchdog first
    // Then release lock...
  }
}
```

---

### 4. Reentrant Lock (Recursive Lock)

**The Pattern:** Same client can acquire the same lock multiple times. Tracks acquisition count and only releases when count reaches zero.

```
1. Client tries to acquire lock with clientId
2. Check if lock exists:
   a. Not exists → Create lock with count=1
   b. Exists, same clientId → Increment count
   c. Exists, different clientId → Fail
3. On release:
   a. Decrement count
   b. If count=0 → Delete lock
```

**Data Structure:**

```json
lock:resource = {
  "clientId": "unique-client-id",
  "count": 2,
  "ttl": 30000
}
```

**Redis Commands (using Hash):**

```bash
# Acquire (Lua script)
EVAL "
  local key = KEYS[1]
  local clientId = ARGV[1]
  local ttl = tonumber(ARGV[2])

  if redis.call('exists', key) == 0 then
    redis.call('hset', key, 'clientId', clientId, 'count', 1)
    redis.call('pexpire', key, ttl)
    return 1
  else
    local owner = redis.call('hget', key, 'clientId')
    if owner == clientId then
      redis.call('hincrby', key, 'count', 1)
      redis.call('pexpire', key, ttl)
      return redis.call('hget', key, 'count')
    else
      return 0
    end
  end
" 1 lock:resource "client-123" 30000

# Release (Lua script)
EVAL "
  local key = KEYS[1]
  local clientId = ARGV[1]

  local owner = redis.call('hget', key, 'clientId')
  if owner == clientId then
    local count = redis.call('hincrby', key, 'count', -1)
    if count <= 0 then
      redis.call('del', key)
    end
    return 1
  else
    return 0
  end
" 1 lock:resource "client-123"
```

**When to Use:**

| ✅ Use When                          | ❌ Avoid When                       |
| ------------------------------------ | ----------------------------------- |
| Nested function calls need same lock | Single-level locking sufficient     |
| Recursive algorithms                 | Deadlock risk from complexity       |
| Framework-level locking              | Simple fail-fast preferred          |
| Unknown call stack depth             | Performance critical (extra checks) |

**Real-World Use Cases:**

- Recursive directory processing: Lock root, process subdirectories
- ORM frameworks: Multiple methods acquire same lock
- Transaction managers: Nested transaction blocks
- Graph traversal: Lock node, recursively lock neighbors

**Example Scenario:**

```typescript
async function processOrder(orderId: string) {
  await lock.acquire(orderId); // Count = 1
  try {
    await updateInventory(orderId); // Calls acquire again → Count = 2
    await sendEmail(orderId);
  } finally {
    await lock.release(orderId); // Count = 1 (still locked)
  }
}

async function updateInventory(orderId: string) {
  await lock.acquire(orderId); // Count = 2 (reentrant!)
  try {
    // Update database...
  } finally {
    await lock.release(orderId); // Count = 1
  }
}
```

**Pros:**

- ✅ Prevents self-deadlock
- ✅ Simplifies nested logic
- ✅ Transparent to callers

**Cons:**

- ❌ More complex implementation (Lua scripts)
- ❌ Harder to debug (hidden lock count)
- ❌ Risk of count mismatch bugs
- ❌ TTL management more complex

---

### 5. Read-Write Lock (Shared-Exclusive)

**The Pattern:** Multiple readers can hold lock simultaneously, but writers need exclusive access. Prioritizes read concurrency while ensuring write safety.

```
Reader acquisition:
1. Check if writer lock exists → Fail if exists
2. Increment reader count: INCR lock:resource:readers
3. Set TTL on reader count key
4. Execute read operation
5. Decrement reader count: DECR lock:resource:readers

Writer acquisition:
1. Check if ANY readers exist (count > 0) → Fail if exists
2. Check if writer lock exists → Fail if exists
3. Set writer lock: SET lock:resource:writer writerId NX PX ttl
4. Execute write operation
5. Delete writer lock
```

**Data Structure:**

```
lock:resource:readers     (integer)  # Reader count
lock:resource:writer      (string)   # Writer ID or doesn't exist
```

**Redis Commands:**

```bash
# Acquire read lock (Lua script)
EVAL "
  if redis.call('exists', KEYS[2]) == 1 then
    return 0  -- Writer exists, fail
  end
  redis.call('incr', KEYS[1])
  redis.call('pexpire', KEYS[1], ARGV[1])
  return 1
" 2 lock:resource:readers lock:resource:writer 30000

# Release read lock
DECR lock:resource:readers

# Acquire write lock (Lua script)
EVAL "
  if redis.call('exists', KEYS[2]) == 1 then
    return 0  -- Writer exists, fail
  end
  local readers = redis.call('get', KEYS[1])
  if readers and tonumber(readers) > 0 then
    return 0  -- Readers exist, fail
  end
  return redis.call('set', KEYS[2], ARGV[1], 'NX', 'PX', ARGV[2])
" 2 lock:resource:readers lock:resource:writer "writer-id" 30000

# Release write lock
DEL lock:resource:writer
```

**When to Use:**

| ✅ Use When                             | ❌ Avoid When              |
| --------------------------------------- | -------------------------- |
| High read, low write workload           | Equal read/write frequency |
| Reads are expensive                     | Writes are time-sensitive  |
| Many concurrent readers needed          | Writes must have priority  |
| Read operations are safe to parallelize | Simple mutex sufficient    |

**Real-World Use Cases:**

- Configuration cache: Many readers, rare updates
- Analytics queries: Multiple dashboards reading, occasional data refresh
- Content delivery: Many reads, rare publishes
- Document editing: Multiple viewers, single editor

**Concurrency Example:**

```
Time 0s:  Reader A acquires  (count=1) ✅
Time 1s:  Reader B acquires  (count=2) ✅
Time 2s:  Reader C acquires  (count=3) ✅
Time 3s:  Writer X tries     → FAIL (count=3)
Time 4s:  Reader A releases  (count=2)
Time 5s:  Reader B releases  (count=1)
Time 6s:  Writer X tries     → FAIL (count=1)
Time 7s:  Reader C releases  (count=0)
Time 8s:  Writer X acquires  → SUCCESS ✅
Time 9s:  Reader D tries     → FAIL (writer exists)
```

**Pros:**

- ✅ High read concurrency
- ✅ Write safety guaranteed
- ✅ Efficient for read-heavy workloads

**Cons:**

- ❌ Writer starvation risk (readers keep coming)
- ❌ More complex implementation (two keys)
- ❌ Race condition window (check readers → set writer)
- ❌ TTL management for both keys

**Writer Starvation Prevention:**
Add writer queue or reader admission control:

```bash
# If writer waiting, block new readers
SET lock:resource:writer-waiting 1 EX 60
```

---

## High-Availability Patterns

### 6. Fair Lock (Queue-Based)

**The Pattern:** FIFO queue for lock acquisition using Redis Streams. Prevents starvation by guaranteeing order.

```
1. Client adds request to queue: XADD lock-queue:resource * clientId timestamp
2. Start consumer loop: XREADGROUP GROUP lockgroup CONSUMER clientId
3. When client's turn arrives (receives message):
   a. Acquire simple mutex lock
   b. Execute operation
   c. Acknowledge message: XACK lock-queue:resource lockgroup messageId
   d. Release mutex lock
4. Next client in queue gets notified automatically
```

**Architecture:**

```
Redis Stream: lock-queue:resource
Entry 1: {clientId: "A", timestamp: 1000}
Entry 2: {clientId: "B", timestamp: 1001}
Entry 3: {clientId: "C", timestamp: 1002}

Processing:
Client A: Consumes entry 1 → Executes → ACKs → Client B gets entry 2
Client B: Consumes entry 2 → Executes → ACKs → Client C gets entry 3
Client C: Consumes entry 3 → Executes → ACKs → Done
```

**Redis Commands:**

```bash
# Setup consumer group (once)
XGROUP CREATE lock-queue:resource lockgroup 0 MKSTREAM

# Client joins queue
XADD lock-queue:resource * clientId client-A timestamp 1000

# Client waits for turn (blocking read)
XREADGROUP GROUP lockgroup client-A COUNT 1 BLOCK 5000 STREAMS lock-queue:resource >

# Client acknowledges completion
XACK lock-queue:resource lockgroup 1234567890-0

# Monitor queue length
XLEN lock-queue:resource
```

**When to Use:**

| ✅ Use When              | ❌ Avoid When                           |
| ------------------------ | --------------------------------------- |
| Fairness critical        | Fail-fast preferred                     |
| Prevent starvation       | Order doesn't matter                    |
| Process in arrival order | High throughput needed (queue overhead) |
| Audit trail needed       | Simple mutex sufficient                 |

**Real-World Use Cases:**

- Ticket booking systems: First-come-first-served
- Support queues: Process requests in order
- Job scheduling: Fair resource allocation
- Rate-limited APIs: Queue requests during burst

**Pros:**

- ✅ Guaranteed FIFO order
- ✅ No starvation
- ✅ Built-in persistence (stream survives crashes)
- ✅ Audit trail (stream history)

**Cons:**

- ❌ Higher latency (queue overhead)
- ❌ More Redis operations (XADD, XREADGROUP, XACK)
- ❌ Complex cleanup (old stream entries)
- ❌ Consumer group management

**Queue Cleanup Strategy:**

```bash
# Trim old entries (keep last 1000)
XTRIM lock-queue:resource MAXLEN 1000

# Or trim by time (keep last 24 hours)
XTRIM lock-queue:resource MINID <timestamp-24h-ago>
```

---

### 7. Redlock (Multi-Instance)

**The Pattern:** Acquire locks on majority of N independent Redis instances. Provides strongest safety guarantees against single-node failures.

```
Setup: N Redis instances (N=5 recommended, must be odd)

Acquire:
1. Generate unique lock ID and expiry time
2. Try to acquire lock on ALL N instances sequentially:
   SET lock:resource lockId NX PX ttl
3. Measure total time taken for all attempts
4. Success if:
   a. Acquired on majority (≥3 out of 5)
   b. Total time < lock TTL (validity time remains)
5. If failed, release locks on all instances

Release:
1. Release lock on ALL N instances (even if acquisition failed on some)
2. Use Lua script to verify ownership before delete
```

**Architecture:**

```
Client                   Redis 1    Redis 2    Redis 3    Redis 4    Redis 5
------                   -------    -------    -------    -------    -------
Acquire lock    ──────→    OK         OK         OK        FAIL       FAIL
                          (3/5 = majority ✅)

Execute operation...

Release lock    ──────→   DELETE    DELETE    DELETE    (skip)     (skip)
```

**Algorithm Details:**

```typescript
async function acquireRedlock(
  resource: string,
  ttl: number,
  instances: Redis[]
): Promise<{ success: boolean; lockId?: string }> {
  const lockId = generateUniqueLockId();
  const startTime = Date.now();
  let acquiredCount = 0;

  // Step 1: Try to acquire on all instances
  for (const redis of instances) {
    try {
      const result = await redis.set(
        `lock:${resource}`,
        lockId,
        'PX',
        ttl,
        'NX'
      );
      if (result === 'OK') acquiredCount++;
    } catch (error) {
      // Instance unreachable, continue to next
    }
  }

  const elapsedTime = Date.now() - startTime;
  const validityTime = ttl - elapsedTime - CLOCK_DRIFT_FACTOR;

  // Step 2: Check if majority acquired and time remaining
  const quorum = Math.floor(instances.length / 2) + 1;
  if (acquiredCount >= quorum && validityTime > 0) {
    return { success: true, lockId };
  } else {
    // Failed to acquire majority - release all
    await releaseRedlock(resource, lockId, instances);
    return { success: false };
  }
}
```

**Configuration:**

```typescript
{
  instances: [
    { host: 'redis1.example.com', port: 6379 },
    { host: 'redis2.example.com', port: 6379 },
    { host: 'redis3.example.com', port: 6379 },
    { host: 'redis4.example.com', port: 6379 },
    { host: 'redis5.example.com', port: 6379 }
  ],
  ttl: 10000,              // 10 second lock
  retryCount: 3,           // Retry 3 times if fail
  retryDelay: 200,         // Wait 200ms between retries
  clockDriftFactor: 0.01   // 1% clock drift tolerance
}
```

**When to Use:**

| ✅ Use When                       | ❌ Avoid When                     |
| --------------------------------- | --------------------------------- |
| Critical operations (financial)   | Single Redis instance acceptable  |
| Cannot tolerate failover race     | Millisecond latency required      |
| Data corruption risk unacceptable | Simple use case                   |
| Compliance/audit requirements     | Cost/complexity outweighs benefit |

**Real-World Use Cases:**

- Financial transactions: Transfer funds, process payments
- Data consistency: Critical database operations
- Resource provisioning: Allocate unique resources (IPs, IDs)
- Leader election: Distributed consensus

**Safety Guarantees:**

```
Scenario: Redis 1 crashes after acquiring lock
- Client A has lock on Redis 1, 2, 3 (3/5 majority)
- Redis 1 crashes and restarts (loses lock)
- Client B tries to acquire:
  - Redis 1: ✅ OK (restarted, empty)
  - Redis 2: ❌ FAIL (Client A still holds)
  - Redis 3: ❌ FAIL (Client A still holds)
  - Redis 4: ✅ OK
  - Redis 5: ✅ OK
  - Total: 3/5 majority ❌ FAIL (Redis 2,3 still locked)
- Client A maintains exclusive access ✅
```

**Pros:**

- ✅ Strongest safety guarantees
- ✅ Survives single-instance failures
- ✅ No single point of failure
- ✅ Well-researched algorithm

**Cons:**

- ❌ High latency (N sequential network calls)
- ❌ Complex setup (N independent instances)
- ❌ Higher infrastructure cost
- ❌ Clock drift sensitivity
- ❌ Network partition edge cases

**Clock Drift Handling:**

```
Lock TTL: 10,000ms
Clock drift factor: 1% (0.01)
Drift allowance: 10,000 × 0.01 = 100ms
Effective validity: TTL - elapsed - 100ms
```

**Important Note:** Redlock remains controversial. See [Further Reading](#further-reading) for Martin Kleppmann's critique and antirez's response.

---

## Pattern Comparison

### Complete Pattern Analysis

| Pattern      | Safety Level | Performance | Complexity | Failover Safe? | Use Case               |
| ------------ | ------------ | ----------- | ---------- | -------------- | ---------------------- |
| Simple Mutex | Basic        | Very High   | Low        | ❌ No          | Most common scenarios  |
| Retry Lock   | Basic        | Medium      | Low        | ❌ No          | Tolerate brief waits   |
| Watchdog     | Basic        | High        | Medium     | ❌ No          | Long unpredictable ops |
| Reentrant    | Basic        | High        | Medium     | ❌ No          | Nested calls           |
| Read-Write   | Basic        | Very High   | Medium     | ❌ No          | Read-heavy workloads   |
| Fair Lock    | Medium       | Medium      | High       | ❌ No          | Order-critical         |
| Redlock      | High         | Low         | Very High  | ✅ Yes         | Mission-critical       |

### Detailed Tradeoffs

| Pattern      | Pros                                                                          | Cons                                                                       |
| ------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Simple Mutex | • Fast (1 SET, 1 EVAL)<br>• Simple (~50 LOC)<br>• Predictable                 | • No retries<br>• Fixed TTL<br>• Failover unsafe                           |
| Retry Lock   | • Handles transient contention<br>• Eventually succeeds                       | • Wastes resources polling<br>• Thundering herd risk<br>• Variable latency |
| Watchdog     | • Unlimited operation time<br>• Fast crash recovery<br>• Automatic TTL mgmt   | • Background thread overhead<br>• Higher Redis load<br>• More complex      |
| Reentrant    | • Prevents self-deadlock<br>• Simplifies nested logic                         | • Complex implementation<br>• Count mismatch bugs<br>• Debugging harder    |
| Read-Write   | • High read concurrency<br>• Write safety<br>• Optimal for read-heavy         | • Writer starvation<br>• Complex (two keys)<br>• Race condition window     |
| Fair Lock    | • FIFO guarantee<br>• No starvation<br>• Audit trail                          | • Queue overhead<br>• Higher latency<br>• Cleanup complexity               |
| Redlock      | • Survives failures<br>• Strongest guarantees<br>• No single point of failure | • High latency<br>• Complex setup<br>• Expensive<br>• Clock sensitivity    |

### By Operation Characteristics

| Operation Type               | Recommended Pattern | Rationale                        |
| ---------------------------- | ------------------- | -------------------------------- |
| Short, skippable (<30s)      | Simple Mutex        | Fast, simple, fail-fast          |
| Short, must succeed          | Retry Lock          | Handles brief contention         |
| Long, unpredictable duration | Watchdog Lock       | Auto-renewal prevents expiration |
| Nested function calls        | Reentrant Lock      | Prevents self-deadlock           |
| Many readers, few writers    | Read-Write Lock     | Maximizes read concurrency       |
| Order matters                | Fair Lock           | FIFO guarantees fairness         |
| Mission-critical, can't fail | Redlock             | Survives failures                |

---

## Pattern Selection Guide

### Decision Tree

```
START: Need distributed lock?
│
├─ Can operation fail if locked?
│  └─ YES → Simple Mutex (fail-fast)
│
├─ Must eventually succeed?
│  ├─ Brief contention expected?
│  │  └─ YES → Retry Lock (backoff)
│  └─ Long contention possible?
│     └─ YES → Fair Lock (queue)
│
├─ Operation duration known?
│  ├─ YES, short (<30s) → Simple Mutex
│  └─ NO, unpredictable → Watchdog Lock
│
├─ Nested calls need same lock?
│  └─ YES → Reentrant Lock
│
├─ Read-heavy workload?
│  └─ YES → Read-Write Lock
│
├─ Order matters (FIFO)?
│  └─ YES → Fair Lock
│
└─ Mission-critical operation?
   └─ YES → Redlock (multi-instance)
```

### By Industry Scenario

| Scenario                  | Pattern              | Why                                 |
| ------------------------- | -------------------- | ----------------------------------- |
| **E-commerce**            |                      |                                     |
| Inventory deduction       | Simple Mutex         | Fast, brief, fail-fast              |
| Order processing          | Watchdog Lock        | Duration varies (payment, shipping) |
| Payment processing        | Redlock              | Critical, cannot duplicate          |
| **Content Management**    |                      |                                     |
| Article editing           | Read-Write Lock      | Many readers, single editor         |
| Cache regeneration        | Simple Mutex         | Skip if already regenerating        |
| Image processing          | Watchdog Lock        | Variable duration                   |
| **DevOps/Infrastructure** |                      |                                     |
| Deployment lock           | Simple Mutex + Retry | Must deploy, can wait briefly       |
| Database migration        | Watchdog Lock        | Duration unpredictable              |
| Leader election           | Redlock              | Critical coordination               |
| **Analytics**             |                      |                                     |
| Report generation         | Simple Mutex         | Skip if already generating          |
| Data ingestion            | Fair Lock            | Process in order                    |
| Real-time dashboard       | Read-Write Lock      | Many viewers, one updater           |
| **Scheduling**            |                      |                                     |
| Cron job deduplication    | Simple Mutex         | Skip if already running             |
| Task queue processing     | Fair Lock            | FIFO task processing                |
| Background worker         | Retry Lock           | Wait for current job, then run      |

---

## Safety Guarantees & Limitations

### ⚠️ Single-Instance Patterns (1-6)

**Patterns:** Simple Mutex, Retry, Watchdog, Reentrant, Read-Write, Fair Lock

**Critical Limitation:** These patterns do NOT guarantee mutual exclusion during Redis/Valkey cluster failover:

```
Failure Scenario:
1. Client A acquires lock on primary P1
2. P1 crashes before replicating lock to replica R1
3. R1 promoted to primary P2 (lock data lost)
4. Client B acquires same lock on P2
5. ❌ Both clients hold lock simultaneously
```

**When This Happens:**

- Redis/Valkey replication is asynchronous by default
- Failover takes seconds (promotion + detection)
- Lock data on primary not yet replicated to replica

**Risk Assessment:**

| Risk Level | Scenario                                  | Impact if Violated                      |
| ---------- | ----------------------------------------- | --------------------------------------- |
| 🟢 Low     | Cache regeneration, analytics             | Duplicate work, wasted resources        |
| 🟡 Medium  | File processing, scheduled jobs           | Duplicate execution, inconsistent state |
| 🔴 High    | Financial transactions, inventory updates | Data corruption, financial loss         |

### ✅ Redlock Pattern (Multi-Instance)

**Guarantees:** Survives single-instance failures with majority consensus.

**Limitations:**

- Clock drift can violate safety (ensure NTP sync)
- Network partitions may cause false failures
- Not 100% safe under all conditions (see [Kleppmann's analysis](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html))

### When to Use Each Safety Level

| Safety Requirement                   | Pattern Choice            |
| ------------------------------------ | ------------------------- |
| ✅ Acceptable duplicate work         | Simple Mutex              |
| ✅ Rare failovers, non-critical      | Simple Mutex + Monitoring |
| ⚠️ Important but not critical        | Watchdog/Retry Lock       |
| ❌ Data corruption risk unacceptable | Redlock                   |
| ❌ Financial/compliance requirements | Redlock + Fencing Tokens  |

### Improving Safety (Single-Instance)

Even without Redlock, you can improve safety:

1. **Use Redis AOF with `fsync always`** (performance cost)
2. **Enable wait command** (synchronous replication):
   ```bash
   SET lock:resource lockId NX PX 30000
   WAIT 1 1000  # Wait for 1 replica to confirm, timeout 1s
   ```
3. **Monitor failover events** and invalidate in-flight operations
4. **Use fencing tokens** (monotonic counter):
   ```bash
   # Acquire lock with fencing token
   INCR lock:resource:token  # Returns: 42
   # Send token to resource, resource rejects if seen higher token
   ```

### Fencing Tokens (Advanced)

**Prevents:** Delayed operations from violating safety after lock expiry/failover.

```
Time  Client A                        Client B                       Resource
---   ---------------------------     ---------------------------     ---------
0s    Acquire lock (token=1) ✅
1s    Start operation...
2s    --- Network delay ---
3s                                    Acquire lock (token=2) ✅
4s                                    Update resource (token=2) ✅
5s    Update resource (token=1) ❌    Resource rejects (token 2 > 1)
```

**Implementation:**

```bash
# Lock server (Redis)
SET lock:resource lockId NX PX 30000
INCR lock:resource:token  # Returns: 42

# Resource server (application DB)
UPDATE resource SET data=?, fence_token=?
WHERE id=? AND fence_token < ?  # Only if new token is higher
```

---

## API Endpoints

### Simple Mutex

```bash
# Execute operation with lock
POST /api/locks/simple/:resourceId
# Response 200: {"success": true, "resourceId": "user123", "durationMs": 15000}
# Response 409: {"error": "Resource locked", "retryAfterMs": 12000}
```

### Redlock

```bash
# Execute operation with multi-instance consensus lock
POST /api/locks/redlock/:resourceId
# Response 200: {"success": true, "resourceId": "critical-resource", "durationMs": 15000}
# Response 409: {"error": "Resource locked", "retryAfterMs": 12000}
# Response 503: {"error": "Quorum not reached", "message": "Unable to acquire lock on majority of instances"}
```

### Health Check

```bash
GET /health
# Response: {"status": "ok", "service": "distributed-lock"}
```

---

## Running Examples

### Prerequisites

```bash
pnpm docker:up      # Start Valkey container
pnpm install        # Install dependencies
pnpm --filter @valkey-use-cases/distributed-lock dev  # Start server (port 3009)
```

### Test Simple Mutex

```bash
# Terminal 1: Acquire lock and hold for 20s
curl -X POST http://localhost:3009/api/locks/simple/resource1

# Terminal 2: Immediate conflict (within 20s)
curl -i -X POST http://localhost:3009/api/locks/simple/resource1
# HTTP/1.1 409 Conflict
# Retry-After: 18
# {"error": "Resource locked", "retryAfterMs": 18000}

# Different resource succeeds immediately
curl -X POST http://localhost:3009/api/locks/simple/resource2
```

### Test Redlock (Multi-Instance)

```bash
# Terminal 1: Acquire lock and hold for operation duration
curl -X POST http://localhost:3009/api/locks/redlock/critical-resource
# {"success": true, "resourceId": "critical-resource", "durationMs": 15000}

# Terminal 2: Concurrent request fails (within operation duration)
curl -i -X POST http://localhost:3009/api/locks/redlock/critical-resource
# HTTP/1.1 409 Conflict
# Retry-After: 18
# {"error": "Resource locked", "retryAfterMs": 18000}

# Different resource succeeds immediately
curl -X POST http://localhost:3009/api/locks/redlock/another-resource
# {"success": true, "resourceId": "another-resource", "durationMs": 12000}
```

### Redis Command Reference

| Pattern      | Acquire Commands                                       | Release Commands                               |
| ------------ | ------------------------------------------------------ | ---------------------------------------------- |
| Simple Mutex | `SET lock:r id NX PX 30000`                            | `EVAL "if get==id then del" 1 lock:r id`       |
| Retry Lock   | `SET lock:r id NX PX 30000` (retry loop)               | `EVAL "if get==id then del" 1 lock:r id`       |
| Watchdog     | `SET lock:r id NX PX 10000` + interval `PEXPIRE 10000` | Stop interval + `EVAL del`                     |
| Reentrant    | `EVAL "hset/hincrby count" 1 lock:r id`                | `EVAL "hincrby -1; if 0 then del" 1 lock:r id` |
| Read-Write   | `EVAL "if !writer then incr readers" 2 lock:r:...`     | `DECR lock:r:readers` or `DEL lock:r:writer`   |
| Fair Lock    | `XADD lock-queue:r * id ts` + `XREADGROUP ...`         | `XACK lock-queue:r group msgid`                |
| Redlock      | `SET lock:r id NX PX 30000` × 5 instances              | `EVAL del` × 5 instances                       |

---

## Further Reading

### Official Documentation

- [Valkey Distributed Locks](https://valkey.io/topics/distlock/) - Official pattern guide
- [Redis SET Command](https://redis.io/commands/set/) - SET with NX/PX options
- [Redis Streams](https://redis.io/docs/data-types/streams/) - For fair lock implementation

### Academic & Industry Analysis

- [How to do distributed locking (Martin Kleppmann)](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) - Critical analysis of Redlock
- [Is Redlock safe? (antirez response)](http://antirez.com/news/101) - Author's defense
- [Distributed Locks are Dead (Hazelcast)](https://hazelcast.com/blog/long-live-distributed-locks/) - Alternative perspectives

### Implementation Libraries

- [Redlock-js](https://github.com/mike-marcacci/node-redlock) - Node.js Redlock implementation
- [Redsync (Go)](https://github.com/go-redsync/redsync) - Go Redlock implementation
