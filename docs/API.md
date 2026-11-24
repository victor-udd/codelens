# CodeLens HTTP API reference

Base URL in development: `http://127.0.0.1:3000`. All bodies are JSON
(`Content-Type: application/json`). Responses are JSON. Review endpoints require
an API key; `/health` is open. There is no CORS configuration, no TLS, and no
version prefix.

Every response carries `X-Request-Id`. If a request includes an `x-request-id`
header matching `^[A-Za-z0-9_-]{1,64}$`, that value is reused; otherwise a UUID
is generated. The same value appears in error bodies. Logs use a non-reversible
8-character SHA-256 tag, never the raw ID.

## Authentication and rate limits

Every `/reviews` and `/api/reviews` request must present a configured API key
in either `X-API-Key: <key>` or `Authorization: Bearer <key>`. Keys are configured
through `API_KEYS`; a missing or unknown key returns `401 UNAUTHORIZED`. Raw keys
are never logged: request identity is a truncated SHA-256 tag.

`GET /api/reviews` (list all reviews) additionally requires a key from
`ADMIN_API_KEYS`. A valid non-admin key returns `403 FORBIDDEN`.

Authenticated review requests are rate limited per API key within
`RATE_LIMIT_WINDOW_MS` (default 60,000 ms) to `RATE_LIMIT_MAX` requests (default
60). Responses include `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset` headers; exceeding the budget returns `429 RATE_LIMITED`.

```bash
curl -i http://127.0.0.1:3000/api/reviews \
  -H 'X-API-Key: dev-user-key' \
  -H 'Content-Type: application/json' \
  -d '{"content":"print(\"hello\")","sourceType":"SNIPPET","language":"PYTHON"}'
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `POST` | `/reviews` | Validate and normalize a submission (no persistence or analysis) |
| `POST` | `/api/reviews` | Create, process and return a review |
| `GET` | `/api/reviews/:id` | Retrieve a stored review by UUID |
| `GET` | `/api/reviews` | List stored reviews with pagination |

Any other method/path returns `404 NOT_FOUND`.

---

## GET /health

No parameters. Does not query the database (it only proves the HTTP process is
up).

```bash
curl -i http://127.0.0.1:3000/health
```

```http
HTTP/1.1 200 OK
X-Request-Id: 05ccfacb-2b16-4a2e-9b9e-62fd1b6be7c4
```

```json
{
  "status": "ok",
  "uptimeSeconds": 15,
  "timestamp": "2026-11-23T15:57:27.707Z"
}
```

---

## POST /reviews

Validation-only compatibility endpoint. It applies the same submission schema
as `POST /api/reviews` but does **not** store a review, run static analysis, or
call the AI provider. The response is the normalized submission with `content`
removed.

### Request body

| Field | Type | Required | Rules |
|---|---|---|---|
| `content` | string | yes | non-empty after trimming, at most `MAX_CONTENT_BYTES` UTF-8 bytes (default 65,536) |
| `sourceType` | string enum | yes | `SNIPPET` or `DIFF` |
| `language` | string enum | yes | `JAVASCRIPT`, `TYPESCRIPT`, `PYTHON`, `GO` |
| `options` | object | no | optional boolean `includeStaticChecks`; unknown keys are preserved but filtered from responses |
| `provider` | string | no | 1–100 characters |
| `model` | string | no | 1–100 characters |

The object is **strict**: unrecognized top-level keys (for example `source`)
are rejected. The whole JSON body is limited to `REQUEST_BODY_LIMIT_BYTES`
(default 131,072).

```bash
curl -i http://127.0.0.1:3000/reviews \
  -H 'X-API-Key: dev-user-key' \
  -H 'Content-Type: application/json' \
  -d '{"content":"print(\"hello\")","sourceType":"SNIPPET","language":"PYTHON"}'
```

### 201 Created

```json
{
  "sourceType": "SNIPPET",
  "language": "PYTHON",
  "sourceSizeBytes": 14,
  "status": "PENDING"
}
```

`options`, `provider` and `model` are included when supplied; `content` is
never returned.

### Errors

- `400 VALIDATION_ERROR` — invalid body or malformed JSON (see error format below).
- `401 UNAUTHORIZED`, `429 RATE_LIMITED` — authentication or rate-limit failure.

---

## POST /api/reviews

Creates a review, processes it synchronously (static analysis plus AI), and
returns the terminal state. On failure the review is still persisted with
`status: "FAILED"` and a safe `errorCode`; the HTTP response is an error body
carrying that `reviewId`.

### Request body

Identical schema to `POST /reviews` (see table above), including strict key
checking and size limits. `options.includeStaticChecks: false` skips static
rules for that review. `provider`/`model` are recorded as submission metadata
only; provider selection itself comes from the `AI_*` configuration.

```bash
curl -i http://127.0.0.1:3000/api/reviews \
  -H 'X-API-Key: dev-user-key' \
  -H 'Content-Type: application/json' \
  -d '{"content":"const apiKey = \"abcdef123456\";\neval(userInput);","sourceType":"SNIPPET","language":"JAVASCRIPT","options":{"includeStaticChecks":true}}'
```

### 201 Created

Headers: `Location: /api/reviews/<id>` (the ID is a UUID), plus `X-Request-Id`.

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
      "source": "STATIC",
      "severity": "CRITICAL",
      "category": "SECURITY",
      "title": "Potential hardcoded credential",
      "explanation": "A literal is assigned to a credential-like field, or matches a known secret token prefix. Committed credentials remain valid in source control history and must be treated as exposed.",
      "suggestedFix": "Load the value from an environment variable or secret manager, and rotate the exposed credential.",
      "filePath": null,
      "lineStart": 1,
      "lineEnd": 1,
      "metadata": { "ruleId": "hardcoded-secret", "detector": "field-name", "field": "apiKey" }
    },
    {
      "source": "STATIC",
      "severity": "CRITICAL",
      "category": "SECURITY",
      "title": "Use of eval()",
      "explanation": "eval() executes its argument as JavaScript with the privileges of the calling code. Data that reaches it from a request, file, or message can become arbitrary code execution.",
      "suggestedFix": "Remove eval() and parse data with a safe format such as JSON.parse(), or replace dynamic evaluation with explicit branching.",
      "filePath": null,
      "lineStart": 2,
      "lineEnd": 2,
      "metadata": { "ruleId": "eval-use" }
    }
  ]
}
```

This example was captured from a live instance using a local fake provider that
returned no AI findings; content of AI findings depends on the configured
provider. `summary` is derived from the number of static vs AI findings.
`latencyMs` is the processing duration. Timestamps are ISO-8601 strings;
`processingStartedAt` and `completedAt` are `null` for reviews that never
entered processing.

### Review object fields

| Field | Type | Notes |
|---|---|---|
| `id` | string (UUID) | Stable review identifier |
| `status` | `PENDING` / `PROCESSING` / `COMPLETED` / `FAILED` | Terminal states returned by this API are `COMPLETED` or `FAILED` |
| `sourceType`, `language` | string enums | From the submission |
| `sourceSizeBytes` | integer | UTF-8 byte length of the original source; source itself is not stored |
| `options` | object or null | Only `includeStaticChecks` is exposed when present |
| `provider`, `model` | string or null | AI identity used for the attempt |
| `attemptCount` | integer | Number of processing attempts started |
| `processingStartedAt`, `completedAt`, `createdAt`, `updatedAt` | ISO string or null | Timestamps |
| `errorCode` | string or null | Safe application error code when `FAILED` |
| `summary`, `latencyMs` | string/integer or null | Result metadata |
| `findingCount`, `findings` | integer, array | Findings for the latest completed attempt |

### Finding object fields

| Field | Type | Notes |
|---|---|---|
| `source` | `STATIC` / `AI` | Origin of the finding |
| `severity` | `INFO` / `WARNING` / `ERROR` / `CRITICAL` | From the rule or provider |
| `category` | `SECURITY` / `BUG` / `PERFORMANCE` / `STYLE` / `MAINTAINABILITY` | From the rule or provider |
| `title`, `explanation`, `suggestedFix` | strings | Human-readable content |
| `filePath` | string or null | Static rules return `null`; AI may supply a path |
| `lineStart`, `lineEnd` | integers or null | 1-based, inclusive |
| `metadata` | object or null | Allow-listed string keys only: `ruleId`, `detector`, `field`, `provider`, `model` |

No submitted source, raw provider output, token usage, credentials or stack
traces appear in these objects.

### Errors

- `400 VALIDATION_ERROR` — invalid submission.
- `401 UNAUTHORIZED`, `429 RATE_LIMITED` — authentication or rate-limit failure.
- `409 REVIEW_STATE_CONFLICT` or `409 MAX_ATTEMPTS_EXCEEDED` — state/attempt conflict.
- `502 AI_*` — provider/authentication/rate-limit/timeout/invalid-response failures.
- `500 DATABASE_ERROR` / `500 PROCESSING_FAILED` — whitelisted internal failures.

Example (provider rejected the credential):

```json
{
  "error": {
    "code": "AI_AUTHENTICATION_FAILED",
    "message": "Review processing failed",
    "reviewId": "632cf84f-8d76-4357-99a2-b006d6052e18",
    "requestId": "3b1f279f-6e63-4f3a-9c69-1e6a4e6aaf2b"
  }
}
```

The referenced review can be fetched with `GET /api/reviews/<reviewId>`; it will
show `status: "FAILED"`, `errorCode: "AI_AUTHENTICATION_FAILED"`, an empty
`findings` array and `summary: null`.

---

## GET /api/reviews/:id

Path parameter `id` must be a UUID.

```bash
curl -i http://127.0.0.1:3000/api/reviews/84db23e2-ccf7-4f8d-a256-ea3fe18c8c69 \
  -H 'X-API-Key: dev-user-key'
```

Returns `200 OK` with the same review object shape as above. Errors:

- `400 VALIDATION_ERROR` with `details[0].path = "id"` — malformed UUID.
- `401 UNAUTHORIZED`, `429 RATE_LIMITED` — authentication or rate-limit failure.
- `404 REVIEW_NOT_FOUND` — well-formed UUID that does not exist.

```json
{
  "error": {
    "code": "REVIEW_NOT_FOUND",
    "message": "Review not found",
    "requestId": "8bb7c0a5-1a3d-4f7e-9a2b-3c1fd4e5a6b7"
  }
}
```

---

## GET /api/reviews

Query parameters (strict — unknown keys such as `offset` are rejected):

| Parameter | Type | Default | Rules |
|---|---|---|---|
| `page` | integer | `1` | positive |
| `limit` | integer | `20` | positive, at most 100 |

Results are ordered by `createdAt` descending. Pagination metadata is computed
from the total row count.

```bash
curl -i 'http://127.0.0.1:3000/api/reviews?page=2&limit=2' \
  -H 'X-API-Key: dev-admin-key'
```

```json
{
  "data": [ /* review objects */ ],
  "pagination": {
    "page": 2,
    "limit": 2,
    "total": 3,
    "totalPages": 2
  }
}
```

`400 VALIDATION_ERROR` is returned for `page=0`, `limit=101`, `limit=0`,
non-numeric values, or unknown query keys. `401 UNAUTHORIZED`, `403 FORBIDDEN`
(non-admin key), and `429 RATE_LIMITED` are also possible.

---

## Error format

All non-2xx responses share this envelope (fields marked `?` are conditional):

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid review submission",
    "details": [ { "path": "content", "message": "content must not be empty", "code": "too_small" } ],
    "reviewId": null,
    "requestId": "26733f2f-c42b-4a9b-9ea8-1a26929df2c9"
  }
}
```

`details` is present for validation errors (including `unrecognized_keys`
issues reported per key). `reviewId` is present when a persisted review failed.
`requestId` is always present. Unexpected 5xx errors that are not expected
review failures are reported with the generic message `Internal server error`
and code `INTERNAL_ERROR`; their details are only in server logs.

| Status | Codes |
|---|---|
| 400 | `VALIDATION_ERROR` |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND`, `REVIEW_NOT_FOUND` |
| 429 | `RATE_LIMITED` |
| 409 | `REVIEW_STATE_CONFLICT`, `MAX_ATTEMPTS_EXCEEDED` |
| 502 | `AI_PROVIDER_ERROR`, `AI_CONFIGURATION_ERROR`, `AI_AUTHENTICATION_FAILED`, `AI_RATE_LIMITED`, `AI_TIMEOUT`, `AI_UNAVAILABLE`, `AI_INVALID_RESPONSE` |
| 500 | `DATABASE_ERROR`, `PROCESSING_FAILED`, `INTERNAL_ERROR` |

Malformed JSON also maps to `400 VALIDATION_ERROR`. Request logging records a
hashed request tag, method, route, status and duration; it never logs request
bodies or raw IDs.
