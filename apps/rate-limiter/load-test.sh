#!/bin/bash

# Rate Limiter Load Test Script
# Runs 3 RPS against 1 RPS rate limit with real-time output

set -e

TARGET_URL="${TARGET_URL:-http://localhost:3003/api/protected}"
RATE="${RATE:-3/1s}"
DURATION="${DURATION:-30s}"

echo "🔥 Rate Limiter Load Test"
echo "========================="
echo "Target: $TARGET_URL"
echo "Rate: $RATE (against 2 RPS limit)"
echo "Duration: $DURATION"
echo ""
echo "Press Ctrl+C to stop at any time"
echo ""

# Check if vegeta is installed
if ! command -v vegeta &> /dev/null; then
    echo "❌ Vegeta not found. Install with:"
    echo "   brew install vegeta"
    exit 1
fi

# Check if server is running
HEALTH_URL="http://localhost:3003/health"
if ! curl -sf "$HEALTH_URL" > /dev/null; then
    echo "❌ Server not running at $HEALTH_URL. Start with:"
    echo "   pnpm --filter @valkey-use-cases/rate-limiter dev"
    exit 1
fi

echo "✅ Prerequisites OK - Starting load test..."
echo ""

# Run vegeta with real-time progress
echo "GET $TARGET_URL" | vegeta attack -rate="$RATE" -duration="$DURATION" | vegeta report -type=text