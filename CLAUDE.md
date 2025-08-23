# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a ValKey use cases demonstration project that showcases various practical implementations through REST APIs built with Node.js. The project is organized around 10 different use cases that demonstrate common ValKey patterns.

## Use Cases Implemented

The project demonstrates these ValKey use cases:

1. **Caching** - Store expensive operation results for faster future requests
2. **Session Store** - Manage user login sessions and temporary data
3. **Rate Limiter** - Control request frequency to prevent abuse
4. **Leaderboard** - Real-time ordered lists based on scores
5. **Pub/Sub Messaging** - Real-time messaging between publishers and subscribers
6. **Job & Message Queue** - Background task processing
7. **Real-time Analytics** - High-scale event counting
8. **Geospatial Indexing** - Location-based data queries
9. **Distributed Lock** - Coordinated resource access in distributed systems
10. **Feature Flags** - Dynamic feature toggling without deployments

## Architecture

This is a TypeScript monorepo using **pnpm workspaces** and **TypeScript project references** for optimal build performance and dependency management.

### Project Structure

```
valkey-use-cases/
├── packages/
│   ├── shared/          # Common ValKey utilities and client
│   └── types/           # Shared TypeScript type definitions
└── apps/
    ├── caching/
    ├── session-store/
    ├── rate-limiter/    # Currently implemented
    ├── leaderboard/
    ├── pubsub/
    ├── job-queue/
    ├── analytics/
    ├── geospatial/
    ├── distributed-lock/
    └── feature-flags/
```

### Key Components

- **Shared Package** (`@valkey-use-cases/shared`): Contains common ValKey client, configuration management, and utility functions
- **Types Package** (`@valkey-use-cases/types`): Shared TypeScript interfaces and types
- **Apps**: Individual Node.js/Express applications for each use case

## Development Commands

### Root Level Commands
- `pnpm install` - Install all dependencies across the monorepo
- `pnpm build` - Build all packages and apps with TypeScript project references
- `pnpm dev` - Start development mode for all apps
- `pnpm test` - Run tests across all packages
- `pnpm lint` - Lint all packages
- `pnpm clean` - Clean all build artifacts
- `tsc --build` - Incremental TypeScript compilation

### Working with Specific Apps
- `pnpm --filter <app-name> <command>` - Run command in specific app
- `pnpm --filter @valkey-use-cases/rate-limiter dev` - Start rate-limiter in dev mode
- `pnpm --filter @valkey-use-cases/shared build` - Build only shared package

### Performance Features

- **Incremental builds**: TypeScript project references enable fast, incremental compilation
- **Workspace dependencies**: Apps can import shared utilities with full TypeScript support
- **Efficient dependency management**: pnpm's content-addressable storage reduces disk usage

Each use case is implemented as a separate Node.js/Express application that can be developed, tested, and deployed independently while sharing common utilities.