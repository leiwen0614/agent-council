import { describe, expect, it } from "vitest";
import { parseEvaluatorOutput } from "../../src/core/evaluation-output.js";

function candidate(candidateId: "Candidate A" | "Candidate B") {
  const dimension = { score: 8, rationale: "Specific rationale." };
  return {
    candidateId,
    dimensions: {
      correctness: dimension,
      taskFulfillment: dimension,
      evidenceQuality: dimension,
      reasoningRigor: dimension,
      critiqueQuality: dimension,
      synthesisImprovement: dimension,
      clarityActionability: dimension
    },
    criticalError: { present: false, categories: [], evidence: null }
  };
}

describe("parseEvaluatorOutput", () => {
  const output = JSON.stringify({
    schemaVersion: 1,
    candidates: [candidate("Candidate A"), candidate("Candidate B")]
  });

  it("accepts exactly one JSON object or one JSON fence", () => {
    expect(parseEvaluatorOutput(output, ["Candidate A", "Candidate B"]).candidates).toHaveLength(2);
    expect(
      parseEvaluatorOutput(`\`\`\`json\n${output}\n\`\`\``, ["Candidate A", "Candidate B"])
        .candidates
    ).toHaveLength(2);
  });

  it("rejects surrounding prose and model-supplied totals", () => {
    expect(() =>
      parseEvaluatorOutput(`Here is the result: ${output}`, ["Candidate A", "Candidate B"])
    ).toThrowError(/exactly one valid JSON/iu);
    const withTotal = JSON.stringify({
      schemaVersion: 1,
      candidates: [{ ...candidate("Candidate A"), total: 80 }, candidate("Candidate B")]
    });
    expect(() => parseEvaluatorOutput(withTotal, ["Candidate A", "Candidate B"])).toThrowError(
      /failed validation/iu
    );
  });
});
