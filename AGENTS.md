# AGENTS.md

## Layout

- `server/`: the Bun server. `app.ts` routes by host, `auth.ts` makes sessions from auth.zyx.tw's signed token (`gate.ts` is a copy of `zyx1121/auth/client/gate.ts`; change it there), `files.ts` the owner file API, `shares.ts` links and the public routes, `paths.ts` path safety.
- `src/`: the React app for nas.zyx.tw (`owner.tsx`). s.zyx.tw has no app: a file link answers with the file itself, and a folder link with a plain list from `barePage`. The shell and `components/ui` come from the task-web starter and ui.zyx.tw; do not edit `components/ui`.
- `deploy/`: the release bundle, its smoke test, the start script land runs, the unit hardening and the env file shape. A merge to `main` deploys through land; wait with `golem-watch zyx1121/nas <sha>`. The CT needs `poppler-utils` for PDF thumbnails; without `pdftoppm` a PDF shows its label instead.

## Rules

- Every path from a request goes through `cleanRel` and then `resolveExisting` or `resolveNew`. Never join a request path yourself.
- Public routes return the same 404 for unknown, expired, revoked and deleted links. Keep it that way.
- Files that a browser could run (HTML, SVG) always download. Keep `inlineSafe` strict.
- The session cookie has no `Domain`, so it stays on the owner host. Never widen it.
- Sign-in happens only at auth.zyx.tw. `/auth/callback` accepts a token only with `Origin` equal to the auth origin, the state cookie, the pinned key in `server/auth-key.json` and this origin as audience.
- Log events with `log()` from `server/otel.ts`. Send counts and short ids, never file names, contents or tokens.
- Install, test and build on the build host, not on a laptop.

## Verify

```sh
bun test server
bun run typecheck && bun run lint
npm run audit -- <url>
```
