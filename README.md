# CodeLens

AI-assisted code review and evaluation API built with Node.js. CodeLens accepts a
source snippet or diff over HTTP, runs deterministic static checks on it, asks a
configurable OpenAI-compatible provider for additional findings, and stores the
resulting review metadata and findings in PostgreSQL. Submitted source code is
never persisted and is redacted before it is sent to the provider.

## 1. Project overview

CodeLens solves the problem of getting repeatable, structured feedback on a
snippet of code without building review UI or a job queue. It exposes a small
JSON API that:

- validates and normalizes submissions (`SNIPPET` or `DIFF`, four languages);
- runs six pattern-based static rules for JavaScript/TypeScript;
- requests AI findings using a strict JSON contract and a credential-redaction
  step;
- persists review state, findings, and a result summary in PostgreSQL;
- exposes create, retrieve and paginated-list endpoints plus a health check;
- tracks processing attempts and exposes building blocks for recovering stale
  reviews.

Everything is synchronous from the caller's perspective: `POST /api/reviews`
returns the terminal review (`COMPLETED` or `FAILED`) once provider and database
work has finished. There is no frontend and no background worker.

## 2. Architecture

The codebase is layered; HTTP concerns, business logic and data access stay
separate:

```
src/
  app.js, server.js          Express app assembly, listen + graceful shutdown
  config/index.js            Zod-validated environment configuration
  routes/                    Route definitions and validation middleware wiring
  controllers/               HTTP request/response handling, status codes
  middleware/                Validation, request ID/logging, error handler
  services/                  Review processing, recovery, submission normalization
  repositories/reviews.js    All Prisma/database access for reviews
  ai/                        Adapter, provider HTTP client, contract, errors, redaction
  static-analysis/           Lexer, rules, finding factory, analyzer
  validation/, serializers/  Request schemas and safe response shaping
  db/prisma.js, logger.js    Prisma client and pino logger
prisma/                      Schema and SQL migrations
tests/                       Vitest suites and fake adapters/repositories
```

**Request-processing lifecycle** (`POST /api/reviews`):

1. `requestId` accepts a safe `x-request-id` header or generates a UUID; the
   value is echoed as `X-Request-Id`. `requestLogger` logs a hashed request tag,
   never the raw ID.
2. `express.json` parses the body with a 128 KiB limit; malformed JSON yields
   `400 VALIDATION_ERROR`.
3. Route-level Zod validation rejects unknown keys and invalid fields before
   any service or repository call.
4. The controller calls the processing service, which creates a `PENDING`
   review, claims it with `markProcessing` (attempt count incremented), then
   runs static analysis and the AI adapter.
5. The AI adapter redacts secrets, retries retryable provider failures with
   exponential backoff, and strictly validates the JSON response.
6. The repository commits findings, result and terminal status in one
   transaction, scoped to the claimed `processingStartedAt` so a stale worker
   cannot overwrite a newer claim.
7. The controller maps failures to safe HTTP errors and serializes the review;
   the serializer allow-lists fields so source text and secret-bearing metadata
   never leave the process.

`getReview` and `listReviews` read the same serialized shape; the legacy
`POST /reviews` endpoint only validates and normalizes input — it does not
persist or analyse anything.

## 3. Technology stack

| Technology | Role |
|---|---|
| Node.js (ESM, `type: module`) | Runtime; `engines` requires >= 22.9.0 (v26.13.1 verified here) |
| Express 5 | HTTP routing, JSON parsing, middleware and error pipeline |
| Prisma 6.19.3 (`@prisma/client`) | Typed data access, migrations, transactional writes |
| PostgreSQL 18 | Development database (Docker Compose `postgres:18` image) |
| Zod 4 | Environment, request, provider-envelope and AI-finding validation |
| pino 10 | Structured JSON logs with redaction |
| Vitest 3 + Supertest 7 | Unit/HTTP tests and live-database integration tests |
| Docker Compose | Reproducible local PostgreSQL service |
| npm | Scripts and dependency management (no other package manager) |

## 4. Prerequisites

- Node.js **>= 22.9.0** and a compatible npm (version 26.13.1 / npm 11 were used here).
- Git.
- A running Docker engine with Compose v2 (Docker Desktop works). The Compose
  service publishes loopback port **55432**; it must be free.
- `curl` (for the examples) and a POSIX shell.
- WSL/Linux note: if `git` reports "dubious ownership" when the repo is reached
  from Windows, prefix Git commands with `git -c safe.directory='*' ...`.

## 5. Installation

```bash
git clone https://github.com/victor-udd/codelens.git
cd codelens
cp .env.example .env          # .env is gitignored; edit it if needed
npm ci                        # installs dependencies and generates the Prisma client
npm run db:start              # docker compose up -d -> codelens-db on 127.0.0.1:55432
npm run db:deploy             # apply migrations to codelens_dev
npm run dev                   # http://127.0.0.1:3000/health
```

If the Prisma client was not generated (for example after a partial install),
run `npm run db:generate`. To verify the installation, run `npm test` — all
suites should pass, including the live-database suite.

## 6. Environment variables

`.env.example` is the source of truth. Configuration is parsed with Zod at
startup; invalid values make the process exit. Defaults below are applied when
a variable is absent.

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development`, `test` or `production` |
| `HOST` | no | `127.0.0.1` | Listen address; keep loopback unless protected |
| `PORT` | no | `3000` | Listen port (1–65535) |
| `LOG_LEVEL` | no | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` |
| `DATABASE_URL` | **yes** | — | PostgreSQL URL; must start with `postgresql://`. The example points at the Compose database |
| `API_KEYS` | **yes** | — | Comma-separated keys accepted by `/reviews` and `/api/reviews`; `.env.example` contains development-only placeholders |
| `ADMIN_API_KEYS` | no | empty | Comma-separated keys with the `admin` scope required by `GET /api/reviews` (list all) |
| `RATE_LIMIT_WINDOW_MS` | no | `60000` | Per-key rate-limit window in milliseconds |
| `RATE_LIMIT_MAX` | no | `60` | Maximum authenticated review requests per key per window |
| `REQUEST_BODY_LIMIT_BYTES` | no | `131072` | Express JSON body limit (128 KiB) |
| `MAX_CONTENT_BYTES` | no | `65536` | Maximum UTF-8 byte length of `content` (64 KiB) |
| `PROVIDER_TIMEOUT_MS` | no | `15000` | Per-attempt AI provider request timeout |
| `MAX_PROVIDER_ATTEMPTS` | no | `3` | Provider attempts per review (1–10); retryable failures only |
| `MAX_PROCESSING_ATTEMPTS` | no | `3` | Review-level attempt limit (1–10) before terminal failure |
| `STALE_PROCESSING_MS` | no | `90000` | Age after which `PROCESSING` reviews are stale |
| `STALE_PENDING_MS` | no | `300000` | Age after which `PENDING` reviews are stale |
| `RECOVERY_BATCH_SIZE` | no | `50` | Maximum stale reviews returned per recovery scan (1–1000) |
| `AI_PROVIDER` | no | `openai-compatible` | Provider factory name: `openai-compatible` or `openai` |
| `AI_API_KEY` | no | empty | Provider credential; empty disables AI reviews (requests fail with `AI_CONFIGURATION_ERROR` only when an AI review is attempted) |
| `AI_MODEL` | no | `gpt-4o-mini` | Model sent to the provider |
| `AI_BASE_URL` | no | `https://api.openai.com/v1` | Base URL; `chat/completions` is appended |

`STALE_PROCESSING_MS` **must** exceed
`PROVIDER_TIMEOUT_MS * MAX_PROVIDER_ATTEMPTS` (90,000 > 15,000 × 3 by default),
otherwise startup fails. `resolveAIConfig` also accepts `OPENAI_API_KEY`,
`OPENAI_MODEL` and `OPENAI_BASE_URL` as aliases when the canonical `AI_*`
variables are unset; these aliases are supported in code but are not listed in
`.env.example`. Never commit real credentials: `.env` and `.env.*` are ignored,
`.env.example` is not.

## 7. Database setup

`docker-compose.yml` defines one dedicated service: container `codelens-db`
(image `postgres:18`), database `codelens_dev`, user `postgres` with `trust`
authentication, named volume `codelens_pgdata` mounted at `/var/lib/postgresql`,
and `127.0.0.1:55432:5432` port mapping. This matches the `DATABASE_URL` in
`.env.example`. No other project's containers, databases or volumes are used.

```bash
npm run db:start     # docker compose up -d (idempotent; creates volume on first run)
npm run db:deploy    # prisma migrate deploy (safe for existing data)
npm run db:status    # prisma migrate status
npm run db:migrate   # prisma migrate dev: create/apply a new migration during development (can reset data)
npm run db:generate  # regenerate Prisma client after schema edits
npm run db:studio    # Prisma Studio
npm run db:stop      # docker compose stop; container + volume are kept
```

Useful diagnostics: `docker compose ps`, `docker compose logs db`,
`docker compose down` (removes container/network, **keeps** the volume),
`docker compose down -v` (**deletes all database data** — destructive).
Migrations live in `prisma/migrations/`; `prisma/schema.prisma` declares
`url = env("DATABASE_URL")` for the CLI, while the app also passes the same URL
to `PrismaClient` at runtime. Database-level CHECK constraints added in the
second migration enforce positive `sourceSizeBytes`, non-negative
`attemptCount`, positive line numbers and `lineEnd >= lineStart`.

## 8. Running the application

```bash
npm run dev     # node --watch, restarts on source changes
npm start       # node --env-file-if-exists=.env src/server.js (production-like)
NODE_ENV=production npm start
```

Configuration is read from `.env` via Node's `--env-file-if-exists`. The server
connects to PostgreSQL at startup and exits with status 1 if the connection
fails. `SIGINT`/`SIGTERM` close the HTTP server and disconnect Prisma cleanly.
There is no build step and no application Docker image in this repository.
A working `AI_API_KEY` is required for successful `POST /api/reviews` calls;
without it, the route returns `502 AI_CONFIGURATION_ERROR` and stores a `FAILED`
review. Review endpoints also require an `API_KEYS` credential; `GET /health`
needs no credentials. `POST /reviews` works without AI credentials.

## 9. API documentation

Summary (full request/response details, status codes and error catalogue in
[`docs/API.md`](docs/API.md)):

| Method | Path | Purpose | Success |
|---|---|---|---|
| `GET` | `/health` | Liveness, uptime and timestamp | 200 |
| `POST` | `/reviews` | Validate/normalize a submission only (no DB write, no AI) | 201 |
| `POST` | `/api/reviews` | Create and synchronously process a review | 201 + `Location` |
| `GET` | `/api/reviews/:id` | Retrieve one stored review (UUID) | 200 |
| `GET` | `/api/reviews?page=&limit=` | List reviews, newest first | 200 + pagination |
| any | unknown path | Structured 404 | 404 |

All review endpoints require an API key in `X-API-Key` or
`Authorization: Bearer`; `GET /api/reviews` requires an `ADMIN_API_KEYS` key.
Requests are rate limited per key. See [`docs/API.md`](docs/API.md).

Example create (with AI configured):

```bash
curl -i http://127.0.0.1:3000/api/reviews \
  -H 'X-API-Key: dev-user-key' \
  -H 'Content-Type: application/json' \
  -d '{"content":"const apiKey = \"abcdef123456\";\neval(userInput);","sourceType":"SNIPPET","language":"JAVASCRIPT","options":{"includeStaticChecks":true}}'
```

```http
HTTP/1.1 201 Created
Location: /api/reviews/84db23e2-ccf7-4f8d-a256-ea3fe18c8c69
X-Request-Id: b76a2485-1754-47ed-b34c-5f4f381e92b0
```

```json
{
  "id": "84db23e2-ccf7-4f8d-a256-ea3fe18c8c69",
  "status": "COMPLETED",
  "sourceType": "SNIPPET",
  "language": "JAVASCRIPT",
  "sourceSizeBytes": 47,
  "options": { "includeStaticChecks": true },
  "provider": "openai-compatible",
  "model": "gpt-4o-mini",
  "attemptCount": 1,
  "processingStartedAt": "2026-11-23T15:57:20.135Z",
  "completedAt": "2026-11-23T15:57:20.820Z",
  "createdAt": "2026-11-23T15:57:20.103Z",
  "updatedAt": "2026-11-23T15:57:21.055Z",
  "errorCode": null,
  "summary": "Review completed with 2 finding(s): 2 static, 0 AI.",
  "latencyMs": 634,
  "findingCount": 2,
  "findings": [
    {
      "source": "STATIC", "severity": "CRITICAL", "category": "SECURITY",
      "title": "Potential hardcoded credential",
      "explanation": "A literal is assigned to a credential-like field, or matches a known secret token prefix. Committed credentials remain valid in source control history and must be treated as exposed.",
      "suggestedFix": "Load the value from an environment variable or secret manager, and rotate the exposed credential.",
      "filePath": null, "lineStart": 1, "lineEnd": 1,
      "metadata": { "ruleId": "hardcoded-secret", "detector": "field-name", "field": "apiKey" }
    },
    {
      "source": "STATIC", "severity": "CRITICAL", "category": "SECURITY",
      "title": "Use of eval()",
      "explanation": "eval() executes its argument as JavaScript with the privileges of the calling code. Data that reaches it from a request, file, or message can become arbitrary code execution.",
      "suggestedFix": "Remove eval() and parse data with a safe format such as JSON.parse(), or replace dynamic evaluation with explicit branching.",
      "filePath": null, "lineStart": 2, "lineEnd": 2,
      "metadata": { "ruleId": "eval-use" }
    }
  ]
}
```

This response was captured from a live server with a local fake provider that
returned zero AI findings; real AI findings vary. Submitted source is never
returned. List responses use `{ "data": [review, ...], "pagination": { "page",
"limit", "total", "totalPages" } }`. Errors use
`{ "error": { "code", "message", "details"?, "reviewId"?, "requestId" } }`.

## 10. AI integration

- **Configuration:** `AI_PROVIDER` selects `openai-compatible` (or its `openai`
  alias); `AI_BASE_URL` + `/chat/completions` is the endpoint, `AI_MODEL` is the
  model, `AI_API_KEY` is sent as a bearer token. Requests use `temperature: 0`
  and `response_format: { type: "json_object" }`. A missing key produces
  `AI_CONFIGURATION_ERROR` when a review is submitted.
- **Prompt contract:** the system prompt treats submitted source as untrusted
  data, instructs the provider to ignore prompt injection, forbids code
  execution and tools, and requires a single JSON object:
  `{"findings":[{"severity","category","title","explanation","suggestedFix","filePath","lineStart","lineEnd"}]}`.
- **Validation:** the provider envelope and every finding are strictly parsed
  with Zod. Severity/category must be Prisma enum values, strings are length
  bounded, `filePath`/line numbers are nullable, `lineEnd >= lineStart`, and at
  most 100 findings are accepted. Failures become `AI_INVALID_RESPONSE` without
  echoing provider output.
- **Redaction:** credential literals found by the JS lexer, known token
  prefixes (Stripe/GitHub/Slack/AWS/Google shapes), `Bearer ...` values, and
  generic credential assignments for Python/Go are replaced with `[REDACTED]`
  before the source is sent. Line breaks are preserved. Redaction count is
  tracked internally but is not exposed via the API.

## 11. Static analysis

JavaScript and TypeScript submissions are tokenized by a lightweight lexer that
masks comments, string contents and regexes while recording literals for the
secret rule. Six rules are implemented:

| Rule ID | Detects | Severity / Category |
|---|---|---|
| `eval-use` | `eval(...)`, indirect eval | CRITICAL / SECURITY |
| `dynamic-code-execution` | `new Function(...)`, `Function(...)`, Node `vm` APIs | ERROR / SECURITY |
| `timer-string-code` | string literals passed to `setTimeout`/`setInterval` | ERROR / SECURITY |
| `hardcoded-secret` | credential-like assignments and known token prefixes | CRITICAL / SECURITY |
| `empty-catch` | empty `catch {}` blocks | WARNING / BUG |
| `debugger-statement` | `debugger;` | WARNING / STYLE |

Set `options.includeStaticChecks: false` to skip static analysis for one
submission. **Limitations:** Python and Go submissions are accepted but produce
no static findings (no rules implemented); rules are regular expressions over
masked text, not a full AST, so obfuscation can evade them; there is no type
checking, cross-file analysis, or control-flow analysis; static findings always
have `filePath: null`.

## 12. Reliability

- **Provider retries:** only retryable errors (`429`, `408`/`504`, `5xx`,
  network/timeouts) are retried, up to `MAX_PROVIDER_ATTEMPTS` with exponential
  backoff starting at 50 ms and doubling per retry. Authentication failures and invalid responses fail immediately.
- **Idempotency:** each review gets a stable SHA-256 key derived from
  `review:<reviewId>`, sent as the `Idempotency-Key` header on every provider
  attempt, including recovered ones. Actual de-duplication depends on the
  provider honouring that header.
- **Processing attempts:** `attemptCount` increments on each claim; terminal
  writes are conditioned on the stored `processingStartedAt` so a stale worker
  cannot overwrite a newer claim. Failures persist only whitelisted error
  codes (`AI_*`, `DATABASE_ERROR`, `MAX_ATTEMPTS_EXCEEDED`, etc.).
- **Stale-review recovery:** `createReviewRecoveryService()` in
  `src/services/review-recovery.js` exposes `findStaleReviews()`,
  `recoverStaleReviews()` and `recoverReview(id)`. It finds `PENDING` reviews
  older than `STALE_PENDING_MS` and `PROCESSING` reviews older than
  `STALE_PROCESSING_MS`, claims them with an atomic database update (losers get
  `CLAIM_CONFLICT`), stops at `MAX_PROCESSING_ATTEMPTS` with
  `MAX_ATTEMPTS_EXCEEDED`, and reuses the stable idempotency key. Because source
  is never persisted, a `sourceLoader` callback must be supplied; otherwise the
  review is failed with `STALE_RECOVERY_SOURCE_UNAVAILABLE`.
- **How recovery is triggered:** **there is currently no HTTP route, CLI
  command, timer, queue or scheduler for recovery.** It is a library API that
  an operator or future scheduler must call from Node.js. This is an explicit
  limitation, not an automatic background process.

## 13. Testing

```bash
npm test                                       # all suites, single run
npm run test:watch                             # watch mode
npx vitest run tests/api-reviews.test.js       # HTTP API suite
npx vitest run tests/ai/adapter.test.js        # retry/validation suite
npx vitest run tests/services/review-recovery.test.js
npx vitest run tests/database.test.js          # requires running PostgreSQL
```

Vitest runs in the `node` environment with `NODE_ENV=test` and
`LOG_LEVEL=error`, and includes `tests/**/*.test.js`. Most suites use fake AI
adapters and a fake repository (`tests/helpers/`) and need no services;
`tests/database.test.js` is the live PostgreSQL integration suite, so start the
database first (`npm run db:start && npm run db:deploy`). No live third-party
provider is contacted by the tests. Current baseline: 14 files / 112 tests
passing.

## 14. Security and data handling

- **Source retention:** submitted `content` is never written to the database
  (only `sourceSizeBytes`), never echoed in responses, and never logged; logs
  use SHA-256 request tags and hashed review tags.
- **Sensitive data:** provider requests use redacted source; the pino logger
  redacts authorization/cookie headers and content/source fields; serializers
  allow-list finding metadata keys (`ruleId`, `detector`, `field`, `provider`,
  `model`); error responses expose whitelisted codes, not provider messages or
  stack traces.
- **Validation and limits:** strict JSON schemas, 128 KiB request body limit and
  64 KiB source limit reduce oversized/malformed input risk. Database CHECK
  constraints guard persisted numeric fields.
- **API limitations / risks:** review endpoints use API-key authentication,
  admin scope for list-all, and per-key rate limits; there is **no TLS** and
  the server binds to loopback by default. Keep `HOST` internal unless traffic
  is protected by a trusted proxy or gateway. The development database uses
  `trust` auth on loopback only. Redaction is heuristic, not a guarantee:
  redacted source is still sent to a third-party provider, so do not submit
  regulated data. Provider-side idempotency is best-effort. Submitted code is
  never executed locally, but AI findings are advisory and should not be
  trusted without review. Never commit `.env` or real API keys.

## 15. Known limitations and future improvements

Implemented today: the HTTP endpoints above, synchronous static + AI review
with strict validation, safe persistence/serialization, provider retries and
idempotency key, and an opt-in recovery service.

Not implemented (candidates for future work): JWT/SSO authentication or
external rate-limit storage; a scheduled recovery worker, queue or CLI trigger; asynchronous review
processing and status polling; static rules for Python/Go; AST-based analysis
and cross-file review; update/delete endpoints, severity counts and other
result analytics; an application Docker image or deployment configuration; API
versioning; and live-provider integration tests. `POST /reviews` is a
validation-only legacy endpoint and intentionally does not create reviews — use
`POST /api/reviews` for persistence and analysis. See
[`docs/API.md`](docs/API.md) for the complete HTTP contract.
