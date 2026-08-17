# DishList API

A Node.js/Express API for the DishList recipe sharing platform


## Tech Stack
- Node.js + Express + TypeScript
- PostgreSQL + Prisma ORM
- Supabase Auth
- Supabase Storage


## Quick Start

1. **Install dependencies**
   ```bash
   npm install
2. **Set up database**
   ```bash
   npm run migrate
2. **Start development server**
    ```bash
    npm run dev
API runs on http://localhost:3000

## Moderation operations

Apply the moderation workflow migration before deploying the admin dashboard.
Grant the first administrator with:

```bash
npm run admin:role -- owner@example.com ADMIN
```

The admin API is mounted at `/admin` and requires a valid Supabase session plus
a `MODERATOR` or `ADMIN` database role. See `../MODERATION_RUNBOOK.md` for the
review and incident process.

### Available Scripts 
- npm run dev - Start with hot reload
- npm run build - Build for production
- npm run start - Start production build
- npm run migrate - Run database migrations
- npm run studio - Open Prisma Studio

### Health Check
Visit http://localhost:3000/health to verify the API is running.

## Social recipe imports

Social imports are processed by the database-backed worker started with the API.
The worker is safe to run on multiple long-lived API instances because each job
is claimed with an expiring lease. Configure:

- `SCRAPECREATORS_API_KEY` for TikTok, Instagram, Facebook, YouTube, and Pinterest metadata.
- `GEMINI_API_KEY` for video understanding when caption, transcript, linked-site JSON-LD, and carousel-image extraction are insufficient.
- `SOCIAL_IMPORT_WORKER_CONCURRENCY` to control per-instance work (default `2`, maximum `8`).
- `SOCIAL_THUMBNAIL_INGESTION_ENABLED=true` only after confirming that storing and redisplaying each platform's thumbnails is authorized. The safe default is no third-party media retention.

Before deploying this API version, apply
`prisma/migrations/20260817150000_social_import_reliability/migration.sql` through
the normal production migration workflow. Do not deploy the worker before the
migration. Import logs are structured JSON with `type: "social_import"` and do
not include captions, media, tokens, or recipe content.
