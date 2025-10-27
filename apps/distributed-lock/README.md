# Distributed Lock with Valkey

A practical implementation of distributed locking using Valkey/Redis for mutually exclusive access to shared resources across multiple servers or processes.

## Table of Contents

- [Introduction](#introduction)
- [How It Works](#how-it-works)
- [Safety Guarantees & Limitations](#safety-guarantees--limitations)
- [API Endpoints](#api-endpoints)
- [Running the Example](#running-the-example)
- [Implementation Details](#implementation-details)
- [Further Reading](#further-reading)

## Introduction

**Distributed locks** coordinate access to shared resources in distributed systems, preventing race conditions when multiple processes need exclusive access to:

- Shared database records
- File processing tasks
- Configuration updates
- Scheduled jobs
- Resource provisioning

**Key Features:**

- Atomic lock acquisition with `SET NX PX`
- Atomic lock release with Lua scripts
- Auto-expiring locks (TTL) to prevent deadlocks
- Fail-fast with `409 Conflict` responses

**Example Use Case:** A long-running operation (30s) where only one process can work on a specific resource at a time. Concurrent requests receive `409 Conflict` with `Retry-After` headers.

## How It Works

**Lock Acquisition:**

```typescript
const result = await redis.set(lockKey, lockId, 'PX', 35000, 'NX');
```

- `NX`: Only set if key doesn't exist (atomic test-and-set)
- `PX 35000`: Auto-expire after 35 seconds (prevents deadlocks)
- `lockId`: Unique cryptographic token for ownership verification
- Returns `'OK'` on success, `null` if already locked

**Lock Release (Lua Script):**

```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
```

- Verifies ownership before deletion (prevents releasing another process's lock)
- Atomic operation prevents race conditions

**TTL Strategy:**

- Operation: 30s | Lock TTL: 35s (5s buffer)
- If process crashes, lock auto-expires to prevent permanent deadlock

## Safety Guarantees & Limitations

### ⚠️ Cluster Failover Risk

**This implementation does NOT guarantee mutual exclusion during Redis/Valkey cluster failover:**

1. Client A acquires lock on primary P1
2. P1 crashes before replicating to replica R1
3. R1 promoted to primary P2
4. Client B acquires same lock on P2
5. **Both clients hold lock simultaneously**

### When to Use

| ✅ Suitable For            | ❌ Not Suitable For            |
| -------------------------- | ------------------------------ |
| Non-critical workloads     | Financial transactions         |
| Low failover frequency     | Data corruption risk scenarios |
| Short lock durations       | Critical infrastructure        |
| Performance-sensitive apps | Strict mutual exclusion needs  |

**For stricter guarantees:** Use **[Redlock](https://redis.io/docs/manual/patterns/distributed-locks/)** (multiple Redis instances, majority consensus, higher latency/complexity)

## API Endpoints

### POST /api/operations/:resourceId

Execute long-running operation with lock protection.

```bash
curl -X POST http://localhost:3009/api/operations/user123
```

**Success (200):**

```json
{
  "message": "Operation completed successfully",
  "resourceId": "user123",
  "durationMs": 30000
}
```

**Conflict (409):**

```json
{
  "error": "Resource is currently locked",
  "message": "Resource \"user123\" is being processed by another request",
  "retryAfterMs": 28450
}
```

_Includes `Retry-After` header (seconds)_

### GET /health

Health check: `{"status": "ok", "service": "distributed-lock"}`

## Running the Example

**Start Valkey & Server:**

```bash
pnpm docker:up                                          # Start Valkey
pnpm install                                            # Install dependencies
pnpm --filter @valkey-use-cases/distributed-lock dev   # Start server (port 3009)
```

**Test Lock Behavior:**

```bash
# Terminal 1: Start 30s operation
curl -X POST http://localhost:3009/api/operations/resource1

# Terminal 2: Concurrent request fails with 409
curl -i -X POST http://localhost:3009/api/operations/resource1

# Terminal 3: Different resource succeeds immediately
curl -X POST http://localhost:3009/api/operations/resource2
```

**Test Lock Expiration:**

```bash
# Start operation in background
curl -X POST http://localhost:3009/api/operations/expiry-test &

# Check lock exists
docker exec -it valkey-server valkey-cli GET "lock:expiry-test"

# Wait for auto-expiration
sleep 36 && docker exec -it valkey-server valkey-cli GET "lock:expiry-test"
# Returns: (nil)
```

## Implementation Details

**Architecture:**

```
Routes (HTTP) → Service (Business Logic) → DistributedLock (Infrastructure) → Valkey
```

**Key Design Decisions:**

- Lock ID: `crypto.randomBytes(16)` for unique ownership tokens
- Key prefix: `lock:` namespace
- TTL buffer: +5s beyond operation duration
- Error handling: Always attempt release in `finally` block
- Retry info: Return remaining TTL in 409 responses

**File Structure:**

```
apps/distributed-lock/src/
├── distributed-lock.ts    # Lock primitives
├── service.ts             # Business logic
├── routes.ts              # HTTP endpoints
├── models.ts              # TypeScript types
└── index.ts               # Server setup
```

## Further Reading

- [Valkey Distributed Locks](https://valkey.io/topics/distlock/) - Official pattern documentation
- [SET Command Options](https://redis.io/commands/set/) - Redis SET with NX/PX
- [How to do distributed locking (Martin Kleppmann)](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) - Critical analysis
- [Is Redlock safe? (Antirez response)](http://antirez.com/news/101) - Author's counterpoints
