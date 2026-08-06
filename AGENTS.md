# Agent Council Repository Instructions

## Project Mission

Build a cross-platform CLI named **Agent Council** that sends one user prompt to Codex CLI, Claude Code, and GitHub Copilot CLI, lets the available agents independently research the same problem, runs anonymous cross-review, and presents peer final reports for the user to judge. Two or three providers may participate; all three are configured by default, and a run must never start with fewer than two ready providers.

Agent Council coordinates the provider CLIs. It does not act as a fourth agent, call an additional model, or make the final decision for the user.

## Non-Negotiable Product Invariants

Treat the following as product requirements. Do not change them without explicit user approval.

1. **One Council prompt fans out to every effective agent.**
   - The normal interaction unit is the Council, not an individual provider.
   - Every ready configured provider receives the same user-authored prompt.
   - Do not design the primary workflow around separately prompting or resuming providers.

2. **All reasoning stages remain peer-parallel.**
   - Initial answer: every effective agent independently answers the same prompt.
   - Cross-review: every effective agent runs concurrently and reviews only peer answers.
   - Final report: every effective agent runs concurrently and produces its own revised conclusion.

3. **Cross-review is anonymous.**
   - Hide provider identities from reviewers.
   - Exclude each reviewer's own answer.
   - Independently shuffle anonymous labels and answer order for each reviewer.
   - Persist the private label-to-provider mapping for reproducibility, but never reveal it in the review prompt.

4. **There is no Council-authored authoritative summary.**
   - The orchestrator may assemble prompts, route events, persist files, and render views.
   - It must not synthesize, rank, rewrite, or choose answers by itself.
   - Each provider receives the original prompt, all initial answers, and all cross-reviews, then writes one final report.
   - The user chooses one report or records a mixed decision.
   - A single `final.md` may exist only after an explicit user choice or an explicit request for one named provider to merge selected material.

5. **Live output and persistence happen together.**
   - Stream each provider's progress/output into its own terminal panel.
   - Append events and partial content to disk during execution.
   - Never make users choose between real-time output and saved artifacts.
   - Preserve completed and partial work after interruption or provider failure.

6. **No default per-agent timeout.**
   - Deep-research runs may take minutes or hours.
   - One provider finishing or failing must not stop the others.
   - A whole-run duration limit may be added as an explicit opt-in, never as the default.

7. **YOLO/permission bypass is configured per provider.**
   - Codex, Claude, and Copilot each have an independent setting.
   - Default every provider to safe/approval mode.
   - Translate the setting to provider-specific flags only inside that provider's adapter.
   - Never silently broaden permissions or enable YOLO for all providers because one provider requested it.

8. **Authentication stays provider-owned.**
   - Users authenticate once with each official CLI outside the core Council run.
   - Council reuses the child process's existing user/home/profile authentication state.
   - `council auth` may launch an official CLI login flow as a convenience, but Council must not implement OAuth, request passwords, copy credential files, or persist tokens.
   - `council doctor` checks installation and authentication before fan-out and reports exact remediation commands.

9. **The tool must behave consistently on Windows, macOS, and Linux.**
   - Do not rely on Bash, PowerShell, CMD, tmux, or another platform-specific shell for core behavior.
   - Treat platform-specific terminal layouts as optional presentation adapters, not core orchestration.

## Session and Run Semantics

Use this hierarchy consistently:

```text
Council Session
|- Council Run 1
|- Council Run 2
`- Provider Sessions
   |- Codex session
   |- Claude session
   `- Copilot session
```

- A **Council Session** is a durable multi-turn conversation with a stable generated ID and an optional human-readable name.
- A **Council Run** is one prompt/answer/review/final cycle within that session. A timestamp is suitable for a run ID, not as the only session identity.
- Each Council Session owns exactly one resumable session per enabled provider.
- `.council/` metadata is the local source of truth for mapping a Council Session to provider session IDs.
- Store only non-sensitive provider session identifiers and configuration. Never store provider auth credentials.
- `council resume <session-id-or-name>` resumes the entire Council Session and its effective provider sessions as one unit.
- After resume, the next user prompt fans out to all effective resumed provider sessions.
- Provider-specific resume commands may exist only as diagnostic/admin escape hatches; they are not the normal product workflow.

Recommended storage shape:

```text
.council/
`- sessions/
   `- <stable-session-id>/
      |- session.json
      `- runs/
         `- <timestamp-or-run-id>/
            |- prompt.md
            |- run.json
            |- events.jsonl
            |- answers/
            |  |- codex.md
            |  |- claude.md
            |  `- copilot.md
            |- reviews/
            |  |- codex.md
            |  |- claude.md
            |  `- copilot.md
            |- finals/
            |  |- codex.md
            |  |- claude.md
            |  `- copilot.md
            `- decision.json
```

Write in-progress prose to `*.md.partial` and promote it to `*.md` only after that provider stage completes successfully. Append structured lifecycle and output events to `events.jsonl` as they occur.

## MVP Scope

The MVP is a research-and-comparison workflow:

1. `council doctor`
2. Create or resume one Council Session.
3. Accept one prompt once.
4. Run initial answers from every effective provider concurrently.
5. Stream and persist every effective-provider answer.
6. Run anonymous cross-reviews from every effective provider concurrently.
7. Stream and persist every effective-provider review.
8. Run final-report prompts concurrently in every effective provider session.
9. Stream and persist every effective-provider final report.
10. Let the user record a selected or mixed decision.

Do not expand the MVP into automatic code implementation, multi-worktree execution, a desktop application, cloud sync, hosted accounts, or a Council-owned AI synthesis layer unless the user explicitly changes scope.

## Technology and Architecture

- Use TypeScript on Node.js 22 or newer.
- Prefer an npm workspace only when multiple packages provide a real boundary; do not create a monorepo prematurely.
- Recommended libraries:
  - `commander` for commands and flags
  - `execa` for cross-platform child processes
  - `ink` and React for the three-panel terminal UI
  - `zod` for config and persisted-schema validation
  - `yaml` for user configuration
  - `vitest` for tests
- Keep storage file-based for the MVP. Do not add SQLite before file storage becomes insufficient.
- Enable strict TypeScript settings. Avoid `any`; validate all provider output and persisted metadata at runtime.

Keep these responsibilities separate:

```text
CLI commands
  -> Council orchestration/state machine
     -> Provider adapter interface
        -> Codex adapter
        -> Claude adapter
        -> Copilot adapter
     -> Event stream and file store
     -> Terminal UI projection
```

The terminal UI and persisted artifacts are two projections of the same normalized event stream. Business logic must not live in Ink components.

## Provider Adapter Rules

Provider differences belong behind a typed adapter boundary. The orchestration layer must not know provider command names, JSONL shapes, session-resume flags, authentication probes, or YOLO flags.

An adapter should cover at least:

```ts
interface AgentAdapter {
  readonly id: "codex" | "claude" | "copilot";
  checkInstalled(): Promise<DiagnosticResult>;
  checkAuthenticated(): Promise<DiagnosticResult>;
  start(options: StartOptions): AgentProcess;
  resume(options: ResumeOptions): AgentProcess;
}
```

- Spawn executables with an argument array; never interpolate prompts into a shell command string.
- Send large prompts through stdin or a provider-supported input channel.
- Keep `shell: false` unless a documented Windows shim issue requires a narrowly tested fallback.
- Normalize provider output into typed events while retaining raw output for diagnostics.
- Treat provider JSON/JSONL as untrusted external input.
- Redact secrets from logs and error messages.
- Never log the entire environment or credential-related variables.
- Preserve enough raw diagnostic information to debug adapters without contaminating user-facing Markdown.

## Concurrency, Failure, and Cancellation

- Start all enabled providers concurrently at each stage.
- Use explicit stage barriers: review begins only after the initial-answer stage is resolved; final reporting begins only after review is resolved.
- Define and test behavior for a provider that fails or produces no answer. Do not invent a replacement answer or ask another provider to impersonate it.
- Surface partial-stage status clearly and let the user retry or continue when the effective-provider stage is incomplete.
- First `Ctrl+C`: request graceful cancellation from all running children, stop accepting new events, flush files, and preserve partial outputs.
- Second `Ctrl+C`: force termination of remaining child processes and still attempt a final metadata flush.
- Account for Windows process-tree termination separately from POSIX signals and cover both paths with tests.

## Configuration Rules

Support checked-in defaults plus user-local overrides without committing credentials. A configuration model should make provider choices explicit:

```yaml
enabledProviders:
  - codex
  - claude
  - copilot

agents:
  codex:
    yolo: false
    model: null
    effort: null
  claude:
    yolo: false
    model: null
    effort: null
  copilot:
    yolo: false
    model: null
    effort: null
```

- Council imposes no timeout by default.
- CLI flags may override config for one run, but persisted run metadata must record the effective non-sensitive settings.
- Optional provider-specific `model` and `effort` values must stay inside adapters, be validated
  against that provider's supported effort vocabulary, and be reused on resume. `null` inherits
  the official provider CLI default.
- Reject unknown provider names and contradictory options with actionable messages.
- Never persist secrets in project config, `run.json`, `events.jsonl`, Markdown output, fixtures, or snapshots.

## Prompt Construction

- Preserve the user's original prompt verbatim in `prompt.md`.
- Separate Council-authored protocol instructions from user-authored content with explicit delimiters.
- Do not silently rewrite the user's question differently for each provider.
- Cross-review prompts must use per-reviewer anonymous labels and include only available peer answers.
- Final-report prompts must give each provider the same complete evidence set: original prompt, all available initial answers, and all available cross-reviews.
- Require each final report to state:
  - revised conclusion
  - accepted and rejected review feedback
  - consensus and material disagreements
  - unresolved facts and risks
  - final recommendation

## User Decision

The user remains the final authority. Store the decision as data rather than treating one provider as Council chair.

Support both a single selection and a mixed decision, for example:

```json
{
  "selectedAgent": null,
  "decision": "Use Claude's architecture with Codex's test plan",
  "sources": ["finals/claude.md", "finals/codex.md"]
}
```

Do not auto-populate a winner, score providers using hidden heuristics, or describe one final report as authoritative without an explicit user decision.

## Engineering Workflow

When changing this repository:

1. Read this file and relevant nearby code before editing.
2. State assumptions when the repository has not yet encoded a product decision.
3. Keep changes narrow and do not silently expand product scope.
4. Add or update tests for behavior changes, especially adapter parsing, concurrency, cancellation, session mapping, anonymization, and crash recovery.
5. Run the repository's formatter, linter, type-checker, and tests before handing off work.
6. Report commands run and any verification that could not be completed.
7. Update user-facing docs when commands, config, persisted schemas, or filesystem layout change.

Do not claim cross-platform support from tests that only run on one operating system. Keep platform-independent unit tests, add Windows/macOS/Linux CI coverage when CI is introduced, and isolate the few platform-specific process behaviors for targeted testing.

## Definition of Done

A feature is done only when:

- it preserves the non-negotiable product invariants above;
- success, failure, interruption, and resume paths are defined;
- persisted files can be validated and recovered after a partial run;
- provider-specific behavior remains inside adapters;
- tests cover the changed behavior;
- documentation matches the actual CLI and configuration;
- no credentials or sensitive environment data are written to disk or logs; and
- the implementation works without assuming a Unix shell.
