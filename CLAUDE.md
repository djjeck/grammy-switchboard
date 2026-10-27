# grammy-switchboard

A grammY plugin that routes a Telegram bot's topics to typed handlers: registered commands, its
own inline buttons, and (if asked) messages, replies and photos, each with the topic it arrived in,
the ref of the conversation it belongs to, and who sent it. Extracted from a private gateway
service that ran the same code in production; this repo starts clean and holds nothing of that
service's deployment.

## Local validation

```sh
source ~/.nvm/nvm.sh && nvm use && npm run validate && npm run test:coverage
```

`validate` runs `build → test → typecheck → lint:fix → format`; it is the gate before every
commit. Coverage (100% on every metric, `vitest.config.ts`) is a separate script. `typecheck`
covers `src/` and `tests/` (`tsconfig.json`); `build` emits `src/` only (`tsconfig.build.json`).
No Docker.

## Conventions

- ESM only, `"type": "module"`, NodeNext resolution: relative imports end in `.js`.
- `erasableSyntaxOnly`: no enums, namespaces or parameter properties, so the sources run under
  Node's type stripping as they are. Published as compiled JavaScript with `.d.ts` files, since
  Node never strips types under `node_modules`.
- Runtime dependencies: none. `grammy` is a peer dependency.
- Tests never reach Telegram: a real grammY `Bot` with `botInfo` set, every API call answered by
  the transformer in `tests/botApi.ts`. Examples use neutral data (topics like `ops`, chat ids
  like `-100123`), never real chats, tokens or people.
- Semver, on 0.x until the API has been tried by its first consumers: a 0.x minor may break the
  API. Every release gets a `CHANGELOG.md` entry.
