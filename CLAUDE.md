# SpaceMolt Commander v3

Autonomous fleet manager for SpaceMolt space MMO (Bun + TypeScript).

## Commands

```bash
bun run dev       # Backend watch    bun run dev:web   # Dashboard dev
bun test          # Tests            bun run db:push   # Schema → PG
```

## Git: `master` = upstream, `local` = our branch. Rebase local onto master.

## References — read ONLY when working on related code

| When you need to understand… | Read |
|------------------------------|------|
| Directory structure, services, wiring | [architecture](docs/references/architecture.md) |
| DB schema, Redis, multi-tenancy, queries | [data-layer](docs/references/data-layer.md) |
| Game mechanics, routines, supply chain | [game-logic](docs/references/game-logic.md) |
| REST/WS API, auth, MCP tools | [api-and-server](docs/references/api-and-server.md) |
| Config (TOML), CLI args, env vars | [config](docs/references/config.md) |
| AI brains, scoring, bandit learning | [ai-brains](docs/references/ai-brains.md) |
| Optimization proposals | [docs/roadmap/](docs/roadmap/) |
