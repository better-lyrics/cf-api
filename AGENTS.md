# Repository Guidelines

## Project Structure & Module Organization

This TypeScript Cloudflare Worker fetches and caches lyrics. The entry point is `src/index.ts`, with HTTP handlers in `src/endpoints/`, business logic in `src/services/`, provider integrations in `src/providers/`, and shared types/utilities in `src/types.ts`, `src/utils.ts`, and `src/auth.ts`. Static challenge pages live in `assets/`. D1 schema changes are ordered SQL files in `migrations/`. Tests are in `test/`.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run dev` or `npm start`: run the Worker locally with Wrangler.
- `npm run lint`: run ESLint over `src/**/*.ts` and `test/**/*.ts`.
- `npx vitest run`: run the Worker test suite using `vitest.config.mts`.
- `npm run cf-typegen`: regenerate Cloudflare binding types after `wrangler.toml` changes.
- `npm run deploy`: deploy with Wrangler.

For local secrets, create an uncommitted `.dev.vars` containing values such as `GOOGLE_API_KEY`, `TURNSTILE_SECRET_KEY`, and `JWT_SECRET`.

## Coding Style & Naming Conventions

Use TypeScript ES modules and keep strict typing enabled. Source and tests generally use 4-space indentation; follow the surrounding file style. Name classes and endpoint handlers in `PascalCase` (`LyricsService`, `VerifyTurnstile`) and functions, variables, and instances in `camelCase`. Prefix intentionally unused values with `_`. `any` and `console` are allowed by ESLint, but prefer explicit types where they clarify contracts.

## Testing Guidelines

Write `*.spec.ts` files under `test/`. Use `vitest` with `cloudflare:test` helpers such as `createExecutionContext`, `env`, and `SELF`. Cover authentication, status codes, streaming behavior, cache-sensitive paths, and provider failures when changing those areas. Run `npm run lint` and `npx vitest run` before opening a pull request.

## API Compatibility

Explicitly ask the user for permission before making any change to the external API surface. This includes response shapes, field names, payload formats, status codes, headers, streaming event names or contents, and other externally observable behavior. Preserve existing client-facing behavior unless the user approves the change.

## Commit & Pull Request Guidelines

Recent history uses short, imperative commit subjects such as `Add JWT rate limiting via Cloudflare rate limit binding` and `Ensure that writes to the response stream happen sequentially in Lyrics v2`. Keep subjects concise and specific; reference issues or PR numbers when applicable. Pull requests should describe the behavior change, list testing performed, mention any new bindings/secrets/migrations, and include screenshots only for asset or challenge-page changes.

## Security & Configuration Tips

Keep secrets in Wrangler secrets or `.dev.vars`, never in source. When modifying `wrangler.toml`, update generated types with `npm run cf-typegen`. Add D1 changes as a new numbered migration instead of editing existing migration files.
