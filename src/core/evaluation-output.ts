import type { BlindCandidateId, EvaluatorOutput } from "./evaluation-types.js";
import { evaluatorOutputForCandidatesSchema } from "./evaluation-schemas.js";
import { CouncilError } from "../util/errors.js";

function extractJson(value: string): string {
  const trimmed = value.trim();
  const fenced = /^```json\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  if (fenced !== null) return fenced[1] ?? "";
  if (trimmed.startsWith("```")) {
    throw new CouncilError(
      "BLIND_EVAL_OUTPUT_INVALID",
      "Evaluator output used an unsupported Markdown fence."
    );
  }
  return trimmed;
}

export function parseEvaluatorOutput(
  value: string,
  candidateIds: readonly BlindCandidateId[]
): EvaluatorOutput {
  let untrusted: unknown;
  try {
    untrusted = JSON.parse(extractJson(value)) as unknown;
  } catch (error) {
    throw new CouncilError(
      "BLIND_EVAL_OUTPUT_INVALID",
      "Evaluator output was not exactly one valid JSON object.",
      { cause: error }
    );
  }
  const parsed = evaluatorOutputForCandidatesSchema(candidateIds).safeParse(untrusted);
  if (!parsed.success) {
    throw new CouncilError(
      "BLIND_EVAL_OUTPUT_INVALID",
      `Evaluator output failed validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return parsed.data;
}

export function buildEvaluationRepairPrompt(
  originalPrompt: string,
  invalidOutput: string,
  validationMessage: string
): string {
  return `<<<COUNCIL_BLIND_EVAL_REPAIR_PROTOCOL_START>>>
The previous blind-evaluation response was invalid. Return exactly one corrected JSON object and
no other text. Candidate identities remain hidden. Do not guess or name providers, calculate totals
or ranks, recommend a winner, inspect other files, or perform external side effects.

Validation error:
${validationMessage}
<<<COUNCIL_BLIND_EVAL_REPAIR_PROTOCOL_END>>>

<<<COUNCIL_BLIND_EVAL_ORIGINAL_PACKAGE_START>>>
${originalPrompt}
<<<COUNCIL_BLIND_EVAL_ORIGINAL_PACKAGE_END>>>

<<<COUNCIL_BLIND_EVAL_INVALID_RESPONSE_START>>>
${invalidOutput}
<<<COUNCIL_BLIND_EVAL_INVALID_RESPONSE_END>>>`;
}
