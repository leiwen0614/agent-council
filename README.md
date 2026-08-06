# Agent Council

Agent Council is a planned cross-platform CLI that coordinates Codex CLI, Claude Code, and
GitHub Copilot CLI as three equal research agents. One user prompt fans out to all three
providers, each agent anonymously reviews the other two answers, and all three then produce
independent final reports for the user to judge.

Agent Council is an orchestrator, not a fourth agent. It does not synthesize an authoritative
answer, rank providers, or choose a winner.

> [!IMPORTANT]
> This repository is an early implementation scaffold. It currently contains the core types,
> runtime schemas, configuration loading, and file-based session storage. Provider adapters,
> orchestration, terminal UI, tests, and the declared CLI entrypoint are not implemented yet.

## Intended workflow

Each Council run will:

1. send the same prompt to Codex, Claude, and Copilot concurrently;
2. stream and persist three independent initial answers;
3. run three concurrent, anonymous cross-reviews, with each provider reviewing only its peers;
4. give every provider the complete evidence set and collect three revised final reports; and
5. let the user select one report or record a mixed decision.

See [the product design](docs/product-design.md) and
[implementation clarifications](docs/implementation-clarifications.md) for the complete product
contract.

## Development

Prerequisites:

- Node.js 22 or newer
- npm

Install dependencies from the committed lockfile:

```shell
npm ci
```

Available quality checks:

```shell
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

The `dev` and `start` scripts are reserved for the future CLI entrypoint and are not usable in
the current scaffold.

## Local data and authentication

Council runtime data will live under the project-local `.council/` directory, which is ignored by
Git. Provider authentication remains owned by the official provider CLIs; this project must not
store provider credentials or tokens. Local `.env*` files are also ignored, except for an
optional `.env.example`.

## License

No license has been selected. Until a license is added, copyright law reserves all rights and the
repository is not offered under an open-source license.
