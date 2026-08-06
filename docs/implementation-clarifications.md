# Agent Council MVP — Implementation Clarifications

These clarifications define the two-or-three-provider product model and runtime fault-tolerance behavior. Under normal operation, a Council run uses every configured provider that passes preflight. Execution is refused when fewer than two are ready. Degraded execution after a runtime failure requires explicit user confirmation.

## 1. Provider requirements

At least two providers are mandatory in the MVP.

Codex, Claude, and Copilot define the supported provider set, and all three are configured by default.

`council doctor` reports configured providers. Run preflight selects the ready configured providers, persists that effective set, and blocks a new run only when fewer than two are ready.

A provider failing after a stage has launched is a runtime partial failure. This is distinct from a run that started normally with an effective two-provider set.

## 2. Degraded continuation and minimum evidence

Explicit degraded continuation uses successfully completed evidence only.

After a partial stage, the user may retry missing providers or explicitly continue in degraded mode.

- Retry only failed or missing providers; do not rerun completed providers.
- `*.md.partial` files are never automatically treated as evidence.
- Every still-operational provider should attempt a later stage when it has sufficient input.
- A cross-reviewer needs at least one successfully completed peer answer.
- A reviewer never receives its own answer.
- If only one initial answer exists, its author is skipped for cross-review because it has no peer answer. Other operational providers may each review that single answer.
- Final Report requires at least one completed initial answer. Completed reviews are optional in degraded mode.
- If zero initial answers completed, the run cannot continue to review or final; it must be retried or abandoned.

Persist that the run or stage was explicitly continued in degraded mode and record which evidence was included or omitted.

## 3. Cross-review anonymity and answer-label mappings

Cross-review anonymity ends after review generation is complete.

The label mapping must remain hidden while cross-reviews are being generated. During Final Report, Council should attach a deterministic mapping legend to each review so references such as `Answer A` can be resolved.

Example:

```text
Review produced by Codex
Answer A = Claude initial answer
Answer B = Copilot initial answer

<verbatim Codex review>
```

Do not rewrite or synthesize the review prose; add only the mapping envelope. Every final-stage provider receives the same mappings and evidence.

Update any absolute wording such as “never reveal mappings in prompts” to “never reveal mappings in cross-review prompts.”

Anonymity is best-effort when an answer identifies its author in its own prose. Prompts should prohibit provider or model self-identification, and Council should omit identifying transport metadata, but it should not alter completed answer prose merely to redact suspected identity clues. An obvious leak may be recorded as an anonymity warning.

## 4. Safe mode and approval requests

MVP safe mode does not implement interactive approval routing.

All three reasoning stages are research-only. Their protocol prompts must explicitly prohibit:

- modifying workspace files;
- modifying Git state;
- installing packages;
- sending messages or performing other external side effects.

Council should use provider-supported read-only or safe execution controls where available.

If a safe-mode provider requests interactive approval, deny the operation programmatically and let the provider continue when supported. If it cannot continue, mark that provider `blocked_by_approval` or failed and apply the normal retry-or-continue flow.

Routing simultaneous approval dialogs into individual TUI panels is outside the MVP. A provider’s explicitly configured YOLO setting affects only that provider’s approval behavior; it does not change Council’s research-only prompt contract.

## 5. Resuming an unfinished run

`council resume` must recover an unfinished run first.

When the selected session contains an unfinished run, restore and display that run instead of silently creating another one. Offer:

- retry the failed or interrupted providers;
- explicitly continue with available evidence;
- abandon the run and start a new run.

Abandoning preserves all artifacts and marks the old run as `abandoned`; it never deletes or overwrites it.

## 6. Project-local sessions

`.council/` is always project-local in the MVP.

A Council Session belongs to the project root containing its `.council/` directory. Session names therefore need to be unique only within that project.

Bind the session to the project root, not to the exact subdirectory from which `council` was invoked. If the whole project directory is moved together with `.council/`, the session remains valid. An original absolute path may be stored for diagnostics, but it must not be the session’s identity.

## 7. Timeouts and failure cancellation

Numeric whole-run timeouts are not part of the MVP.

Remove `execution.timeout` from the MVP configuration rather than exposing a setting that only accepts `null`. Manual graceful or forced cancellation remains supported through `Ctrl+C`.

`cancelOnAgentFailure: true` contradicts a product invariant and is invalid. Prefer removing `cancelOnAgentFailure` from the MVP schema as well; if temporarily retained, only `false` is valid.

An explicit whole-run timeout can be added after the MVP.

## 8. Commands, deferred decisions, and final output

Support both `council` and `council run`.

- `council` is the primary interactive entry point. It opens the TUI and lets the user create or resume a Council Session.
- `council run` is the explicit command for starting a new run, useful for arguments and future scripting.
- `council resume <session-id-or-name>` resumes the entire Council Session and handles unfinished-run recovery as described above.

The user may defer the final decision. In that case, mark the run `awaiting_decision`; resuming it should return to the decision screen.

Selecting one provider or recording a mixed decision automatically creates `decision.json` only. `final.md` remains absent by default and is created only through a separate explicit “materialize/export final” action. Council must never synthesize mixed prose itself.

## Core product invariant

Under normal operation, Council asks every effective provider to work on the same task and requires at least two. Degraded execution is an explicitly chosen recovery path for a provider that fails after launch.
