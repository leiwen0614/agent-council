#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import { loadConfig, withYoloOverrides } from "./config/load.js";
import { PROVIDERS, type CouncilRun, type CouncilSession, type ProviderId } from "./core/types.js";
import { CouncilEngine, runDoctor } from "./orchestration/council.js";
import { BlindEvaluationEngine, type EvaluationSelector } from "./orchestration/evaluation.js";
import { aggregatePeerScores } from "./core/evaluation-scoring.js";
import {
  renderBlindEvaluation,
  renderEvaluationFailures,
  renderEvaluationTiming,
  renderPeerScoreSummary
} from "./ui/evaluation.js";
import { findProjectRoot } from "./storage/project.js";
import { CouncilRepository } from "./storage/repository.js";
import { CouncilError, errorMessage } from "./util/errors.js";
import { nowIso } from "./util/time.js";
import { renderDoctorTable } from "./cli/doctor.js";
import {
  askPrompt,
  askSessionName,
  chooseDecision,
  chooseHomeAction,
  chooseRecovery,
  chooseSession,
  parseCouncilProviders,
  parseEvaluator,
  parseProviders
} from "./cli/interaction.js";

type RunFlags = {
  session?: string;
  name?: string;
  prompt?: string;
  promptFile?: string;
  yolo?: string[];
  providers?: string;
  preflight?: boolean;
  live?: boolean;
};

type BlindEvaluationFlags = {
  by: EvaluationSelector;
  run?: string | undefined;
};

function collectYolo(value: string, previous: string[]): string[] {
  return [...previous, ...value.split(",").map((item) => item.trim())];
}

async function context() {
  const projectRoot = await findProjectRoot();
  const repository = new CouncilRepository(projectRoot);
  return { projectRoot, repository, config: await loadConfig(projectRoot) };
}

async function promptFromFlags(flags: RunFlags): Promise<string> {
  const supplied = [flags.prompt !== undefined, flags.promptFile !== undefined].filter(
    Boolean
  ).length;
  if (supplied > 1)
    throw new CouncilError("CONTRADICTORY_OPTIONS", "Use only one of --prompt or --prompt-file.");
  if (flags.promptFile) return readFile(resolve(flags.promptFile), "utf8");
  if (flags.prompt) return flags.prompt;
  if (!process.stdin.isTTY) {
    let content = "";
    for await (const chunk of process.stdin) content += String(chunk);
    if (content.trim()) return content;
  }
  return askPrompt();
}

function effectiveConfig(flags: RunFlags, base: Awaited<ReturnType<typeof loadConfig>>) {
  const providers = parseProviders((flags.yolo ?? []).join(","));
  const config = withYoloOverrides(base, providers);
  if (flags.providers !== undefined)
    config.enabledProviders = parseCouncilProviders(flags.providers);
  return config;
}

async function createEngine(flags: RunFlags) {
  const value = await context();
  const config = effectiveConfig(flags, value.config);
  const engine = new CouncilEngine({
    repository: value.repository,
    config,
    live: flags.live !== false,
    recover: async (stage, canContinue) => chooseRecovery(stage, canContinue)
  });
  return { ...value, config, engine };
}

async function recordDecision(
  repository: CouncilRepository,
  session: CouncilSession,
  run: CouncilRun
): Promise<void> {
  const available = PROVIDERS.filter(
    (provider) =>
      run.effectiveConfig.enabledProviders.includes(provider) &&
      run.stages.final.providers[provider].status === "completed"
  );
  if (available.length === 0)
    throw new CouncilError("FINAL_NOT_FOUND", "No completed final report is available.");
  const choice = await chooseDecision(available);
  if (choice.kind === "defer") {
    run.status = "awaiting_decision";
    await repository.saveRun(run);
    console.log(`Decision deferred. Resume session ${session.name ?? session.id} later.`);
    return;
  }
  const decision =
    choice.kind === "select"
      ? {
          schemaVersion: 1 as const,
          selectedAgent: choice.provider,
          decision: choice.note ?? `Use the ${choice.provider} final report`,
          sources: [`finals/${choice.provider}.md`],
          decidedAt: nowIso()
        }
      : {
          schemaVersion: 1 as const,
          selectedAgent: null,
          decision: choice.decision,
          sources: choice.providers.map((provider) => `finals/${provider}.md`),
          decidedAt: nowIso()
        };
  await repository.saveDecision(run, decision);
  run.status = "completed";
  await repository.saveRun(run);
  await repository.finishRun(session, run);
  console.log(
    `Decision recorded in ${repository.paths.projectRelative(repository.paths.decision(run.sessionId, run.id))}`
  );
}

async function runCommand(flags: RunFlags): Promise<void> {
  const { repository, engine } = await createEngine(flags);
  if (flags.preflight !== false) await engine.preflight();
  let session: CouncilSession;
  if (flags.session) session = await repository.resolveSession(flags.session);
  else
    session = await repository.createSession(
      flags.name ?? (process.stdin.isTTY ? await askSessionName() : null)
    );
  const prompt = await promptFromFlags(flags);
  const run = await engine.start(session, prompt);
  console.log(
    `Artifacts: ${repository.paths.projectRelative(repository.paths.runRoot(session.id, run.id))}`
  );
  if (run.status === "awaiting_decision") await recordDecision(repository, session, run);
}

async function resumeCommand(idOrName: string, flags: RunFlags): Promise<void> {
  const { repository, engine } = await createEngine(flags);
  const session = await repository.resolveSession(idOrName);
  let run =
    session.activeRunId === null ? null : await repository.loadRun(session.id, session.activeRunId);
  if (run?.status === "awaiting_decision") return recordDecision(repository, session, run);
  if (run !== null && run.status !== "completed" && run.status !== "abandoned") {
    run = await engine.resume(session, run);
    if (run.status === "awaiting_decision") await recordDecision(repository, session, run);
    return;
  }
  const prompt = await promptFromFlags(flags);
  if (flags.preflight !== false) await engine.preflight();
  run = await engine.start(session, prompt);
  if (run.status === "awaiting_decision") await recordDecision(repository, session, run);
}

async function interactiveHome(): Promise<void> {
  const { repository } = await context();
  const sessions = await repository.listSessions();
  const action = await chooseHomeAction(sessions.length > 0);
  if (action === "doctor") return doctorCommand();
  if (action === "resume") {
    const session = await chooseSession(sessions);
    return resumeCommand(session.id, {});
  }
  return runCommand({});
}

async function doctorCommand(): Promise<void> {
  const { config } = await context();
  const diagnostics = await runDoctor(undefined, config.enabledProviders);
  console.log(renderDoctorTable(config, diagnostics, process.stdout.columns || 120));
  const readyCount = diagnostics.filter(
    (result) => result.installed.ok && result.authenticated.ok
  ).length;
  if (readyCount < 2) process.exitCode = 1;
}

async function blindEvaluationCommand(
  sessionValue: string | undefined,
  flags: BlindEvaluationFlags
): Promise<void> {
  const { repository } = await context();
  const engine = new BlindEvaluationEngine({ repository });
  const target = await engine.resolveTarget(sessionValue, flags.run);
  const execution = await engine.execute(target, flags.by);
  for (const result of execution.results) {
    console.log(
      renderBlindEvaluation(
        result,
        target.session.name ?? target.session.id,
        process.stdout.columns || 120,
        flags.by !== "all"
      )
    );
  }
  if (flags.by === "all" && execution.results.length > 0) {
    const summaries = aggregatePeerScores(
      execution.results,
      target.run.effectiveConfig.enabledProviders
    );
    console.log(
      renderPeerScoreSummary(
        summaries,
        execution.failures.length === 0 &&
          execution.results.length === target.run.effectiveConfig.enabledProviders.length,
        process.stdout.columns || 120
      )
    );
    const timingResult = execution.results[0];
    if (timingResult !== undefined) {
      console.log(renderEvaluationTiming(timingResult, process.stdout.columns || 120));
    }
  }
  if (execution.failures.length > 0) {
    const terminalColumns = process.stderr.columns || process.stdout.columns || 120;
    console.error(renderEvaluationFailures(execution.failures, terminalColumns));
    process.exitCode = 1;
  }
}

function addRunOptions(command: Command): Command {
  return command
    .option("-s, --session <id-or-name>", "run in an existing Council session")
    .option("-n, --name <name>", "name a newly created Council session")
    .option("-p, --prompt <text>", "user prompt")
    .option("--prompt-file <path>", "read the prompt verbatim from a file")
    .option("--providers <list>", "comma-separated providers for this run (minimum two)")
    .addOption(
      new Option("--yolo <provider>", "enable provider-specific permission bypass; repeatable")
        .argParser(collectYolo)
        .default([])
    )
    .option("--no-preflight", "skip provider diagnostics (admin/debug only)")
    .option("--no-live", "disable the live panel projection");
}

const program = new Command()
  .name("council")
  .description("Coordinate two or three provider CLIs through a peer research Council")
  .version("0.1.0")
  .action(interactiveHome);

addRunOptions(program.command("run").description("start a new Council run")).action(runCommand);
addRunOptions(
  program.command("resume <session>").description("resume an entire Council session")
).action(resumeCommand);
program
  .command("doctor")
  .description("check provider installation, authentication, model, and effort")
  .action(doctorCommand);
program
  .command("blind-eval [session]")
  .description(
    "blindly evaluate all providers across the three stages; identities reveal only after scores lock"
  )
  .requiredOption("--by <evaluator>", "evaluator: codex, claude, copilot, or all", parseEvaluator)
  .option("--run <run-id>", "evaluate a specific run in the selected session")
  .action(blindEvaluationCommand);
program
  .command("sessions")
  .description("list local Council sessions")
  .action(async () => {
    const { repository } = await context();
    for (const session of await repository.listSessions())
      console.log(`${session.id}	${session.name ?? "-"}	${session.updatedAt}`);
  });
program
  .command("decide <session>")
  .description("record or update a run decision")
  .action(async (value: string) => {
    const { repository } = await context();
    const session = await repository.resolveSession(value);
    const run = await repository.latestRun(session.id);
    if (run === null) throw new CouncilError("RUN_NOT_FOUND", "The session has no runs.");
    await recordDecision(repository, session, run);
  });
program
  .command("export <session> <provider>")
  .description("explicitly materialize one provider final report")
  .action(async (value: string, providerValue: string) => {
    const provider = providerValue.toLowerCase() as ProviderId;
    if (!PROVIDERS.includes(provider))
      throw new CouncilError("INVALID_PROVIDER", `Unknown provider: ${providerValue}`);
    const { repository } = await context();
    const session = await repository.resolveSession(value);
    const run = await repository.latestRun(session.id);
    if (run === null) throw new CouncilError("RUN_NOT_FOUND", "The session has no runs.");
    console.log(await repository.exportProviderFinal(run, provider));
  });
program
  .command("auth [provider]")
  .description("launch an official provider login flow")
  .action(async (providerValue?: string) => {
    const { execa } = await import("execa");
    const provider = providerValue?.toLowerCase() as ProviderId | undefined;
    if (provider === undefined || !PROVIDERS.includes(provider))
      throw new CouncilError("INVALID_PROVIDER", "Specify one of: codex, claude, copilot");
    const commands: Record<ProviderId, [string, string[]]> = {
      codex: ["codex", ["login"]],
      claude: ["claude", ["auth", "login"]],
      copilot: ["copilot", ["login"]]
    };
    const [file, args] = commands[provider];
    await execa(file, args, { stdio: "inherit", shell: false });
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const prefix = error instanceof CouncilError ? `[${error.code}] ` : "";
  console.error(prefix + errorMessage(error));
  process.exitCode = 1;
}
