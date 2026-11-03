# Contributing

1. Fork, create a branch from `main`.
2. `npm install`, then copy `.dev.vars.example` to `.dev.vars` (fake values are fine for tests).
3. Make your change with tests where it makes sense.
4. Run `npm run typecheck && npm test` and make sure both pass.
5. Open a pull request. CI runs typecheck, tests, a dependency audit, CodeQL and a secret scan.

## Style

- TypeScript, no new dependencies without a reason (the Worker bundle stays small).
- Money amounts use `BigInt` stroops, never floats.
- Bot messages follow the layout documented in `src/telegram/ui.ts`: title, key figure, context, then detail rows, at most one emoji.
- Never log secrets or private keys.

## Security issues

Do not file them as public issues. See [SECURITY.md](SECURITY.md).
