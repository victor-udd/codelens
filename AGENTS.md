# AGENTS.md

## Scope and stack

- Backend only. Do not add frontend or UI code.
- Use JavaScript (not TypeScript) on Node.js.
- Stack decisions: Express for REST APIs, PostgreSQL with Prisma for persistence, Zod for request validation, Vitest + Supertest for tests.
- The repo is still a scaffold: only `README.md`, `LICENSE`, and `.gitignore` are tracked (initial commit `0bfe253`). No manifest, lockfile, source, tests, CI, or `opencode.json` exist yet. Do not assume tooling or commands beyond the rules above; re-check before inventing any.

## Architecture

- Keep controllers, services, and repositories separate: HTTP handling in controllers, business logic in services, data access in repositories. Do not collapse these layers.

## Working rules

- Never claim functionality works without running the relevant tests. If no tests exist yet, say that explicitly instead of implying verification.
- Never introduce unnecessary dependencies; prefer the stack above and justify any addition.
- Never commit secrets. `.gitignore` excludes `.env` and `.env.*` but re-includes `.env.example`; commit an example, not real values.
- Ask before performing destructive operations (including destructive Prisma resets/force-pushes) or pushing changes.
- In this workspace the repo is reached from Windows at a `\\wsl.localhost\...` path, so plain `git` fails with "dubious ownership". Use `git -c safe.directory='*' <cmd>` (or configure `safe.directory` once) for git operations.
