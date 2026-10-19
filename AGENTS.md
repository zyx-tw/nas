# AGENTS.md

## Layout

- `server/`: the Bun server. `app.ts` routes by host, `auth.ts` does passkeys and sessions, `files.ts` the owner file API, `shares.ts` links and the public routes, `paths.ts` path safety.
- `src/`: the React app. `owner.tsx` is nas.zyx.tw, `share.tsx` is s.zyx.tw. The shell and `components/ui` come from the task-web starter and ui.zyx.tw; do not edit `components/ui`.
- `deploy/`: the systemd unit and the env file shape.

## Rules

- Every path from a request goes through `cleanRel` and then `resolveExisting` or `resolveNew`. Never join a request path yourself.
- Public routes return the same 404 for unknown, expired, revoked and deleted links. Keep it that way.
- Files that a browser could run (HTML, SVG) always download. Keep `inlineSafe` strict.
- The session cookie has no `Domain`, so it stays on the owner host. Never widen it.
- Log events with `log()` from `server/otel.ts`. Send counts and short ids, never file names, contents or tokens.
- Install, test and build on the build host, not on a laptop.

## Verify

```sh
bun test server
bun run typecheck && bun run lint
node scripts/e2e.mjs http://localhost:8090 http://127.0.0.1:8090 <setup-token>
npm run audit -- <url>
```
