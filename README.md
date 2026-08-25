# Agent Council

Agent Council is a cross-platform CLI that coordinates Codex CLI, Claude Code, and GitHub
Copilot CLI as peer research agents. One user prompt fans out to every enabled provider, each
agent anonymously reviews its peers, and every enabled agent produces an independent final
report for the user to judge. Two or three providers may participate; all three are enabled by
default. A run never starts with fewer than two ready providers.

Agent Council is an orchestrator, not a fourth agent. It does not synthesize an authoritative
answer or choose a winner. Its optional blind-evaluation command displays scores authored by a
named provider; Council contributes only transparent arithmetic and never a hidden judgment.

> [!IMPORTANT]
> This project is an early MVP. Provider CLI output formats and resume behavior can change between
> provider releases, so run `council doctor` after upgrading a provider CLI.

## Intended workflow

Each Council run will:

1. send the same prompt to all enabled providers concurrently;
2. stream and persist their independent initial answers;
3. run concurrent, anonymous cross-reviews, with each provider reviewing only its peers;
4. give every enabled provider the complete evidence set and collect revised final reports; and
5. let the user select one report or record a mixed decision.

See [the product design](docs/product-design.md) and
[implementation clarifications](docs/implementation-clarifications.md) for the complete product
contract.

## Requirements

- Node.js 22 or newer
- Codex CLI, authenticated with `codex login` or configured with an authenticated custom model
  provider
- Claude Code, authenticated with `claude auth login` or configured with an authenticated custom
  API provider (optional when disabled)
- GitHub Copilot CLI, authenticated with `copilot login` or one of its supported environment
  variables (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`)

Provider authentication remains owned by each official CLI.

## Install and run

```shell
npm ci
npm run build
npm link
council doctor
council
```

The primary `council` command opens an interactive session picker. Other useful commands are:

```shell
council run --name "my research" --prompt "Compare these approaches"
council resume "my research"
council sessions
council decide "my research"
council export "my research" codex
council blind-eval --by codex
council blind-eval "my research" --run 2026-08-25_10-30-42 --by all
```

Prompts can also be read from `--prompt-file` or standard input. Permission bypass is explicit per
provider, for example `--yolo codex --yolo claude`; safe mode is the default. There is no default
Council or per-provider timeout.

In the interactive flow, type the Council prompt directly into the terminal and press Enter. Council
saves it verbatim as plain text in the run's `.council/.../prompt.md`; it never launches an external
editor. For a multiline prompt, use `--prompt-file` or pipe standard input.

Provider enablement is configured in `council.config.yaml` or overridden for one run with
`--providers codex,copilot`. At least two providers are required:

```yaml
enabledProviders:
  - codex
  - copilot
```

Each provider can also pin its official CLI model and reasoning effort. Use `null` to inherit the
provider CLI default. This repository's deep-research configuration uses the strongest supported
settings exposed by the currently tested CLI versions:

```yaml
agents:
  codex:
    yolo: true
    model: gpt-5.6-sol
    effort: xhigh
  claude:
    yolo: true
    model: claude-opus-4-8
    effort: xhigh
  copilot:
    yolo: true
    model: gpt-5.6-sol
    effort: max
```

These values are passed on both provider start and resume and are persisted in `run.json`. YOLO
bypasses provider permission checks and is not confined to the project directory; use it only in
an externally isolated environment when filesystem confinement is required.

During a live stage, each agent panel shows a terminal-height-bounded tail preview. When the stage
finishes, Council appends one complete, immutable rendering of every agent's wrapped output to the
terminal; side-by-side panels share the height of the longest output. Completed Initial Answer,
Cross-Review, and Final Report renderings therefore remain in the terminal's normal scrollback.
Full provider output is also saved under `.council/` as it streams.
After the final snapshot is appended, Council keeps the terminal open at an interactive decision
menu so the user can select one final report, record a mixed decision, or defer the choice.

## Post-run blind evaluation

`council blind-eval [session] --by <codex|claude|copilot|all> [--run <run-id>]` optionally asks a
visible evaluator to score every provider's complete Initial Answer, Cross-Review, and Final Report
bundle. With no session or run selector, Council uses the newest eligible run in the current
project. An eligible run must be a non-degraded, complete three-stage run from at least two
providers. A named evaluator can be outside the original run if its CLI is ready; `--by all` means
all effective providers recorded in the original run.

Candidate identities are best-effort blind during scoring. Each evaluator receives an independently
randomized Candidate A/B/C mapping in a fresh, safe provider session whose isolated working
directory contains only anonymous evidence. Council withholds provider identities, Self/Peer
relationships, model and effort, session metadata, and original-run execution time. It validates
the evaluator's seven rubric scores, computes the weighted totals, and atomically locks the blind
record before revealing identities. Execution time is attached afterward and never affects rank.

The result is explicitly labeled as the named evaluator's judgment. `--by all` runs independent
evaluations concurrently and adds peer averages, self-versus-peer gaps, and peer ranks without
creating a blended "Council score." Blind evaluation does not recommend a report, select a winner,
modify `decision.json`, or create `final.md`. Repeating a completed evaluation reuses its persisted
result. Records are stored beside the run under `evaluations/<evaluator>.blind.json` and
`evaluations/<evaluator>.json`; the corresponding persisted prompt contains anonymous Candidate
IDs only.

Although Claude Code accepts `max`, some inference gateways route Claude through a backend whose
maximum supported effort is `xhigh`. This repository uses `xhigh` to avoid repeated invalid-request
retries on such installations.

At preflight, Council uses every configured provider that is installed and authenticated. If one
of three is unavailable, the run proceeds with the other two and records that effective provider
set in `run.json`. If fewer than two are ready, the run is refused.
`council doctor` displays providers side by side, with rows for readiness, CLI version,
authentication, effective configured model, reasoning effort, permission mode, and remediation.
The value `provider default` means that model or effort is inherited from the provider CLI.

## Development

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

During development, use `npm run dev -- --help`. After `npm run build`, use `npm start -- --help`.

## Local data and authentication

Council runtime data lives under the project-local `.council/` directory, which is ignored by
Git. Provider authentication remains owned by the official provider CLIs; this project must not
store provider credentials or tokens. Local `.env*` files are also ignored, except for an
optional `.env.example`.

## License

No license has been selected. Until a license is added, copyright law reserves all rights and the
repository is not offered under an open-source license.
