import { stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { CouncilError } from "../util/errors.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function findProjectRoot(startDirectory = process.cwd()): Promise<string> {
  let current = resolve(startDirectory);
  const filesystemRoot = parse(current).root;
  let gitCandidate: string | null = null;
  let packageCandidate: string | null = null;

  for (;;) {
    if (await exists(join(current, ".council"))) {
      return current;
    }
    if (gitCandidate === null && (await exists(join(current, ".git")))) {
      gitCandidate = current;
    }
    if (packageCandidate === null && (await exists(join(current, "package.json")))) {
      packageCandidate = current;
    }
    if (current === filesystemRoot) {
      break;
    }
    current = dirname(current);
  }

  const root = gitCandidate ?? packageCandidate;
  if (root === null) {
    throw new CouncilError(
      "PROJECT_ROOT_NOT_FOUND",
      "No project root was found. Run Council inside a Git repository or a directory containing package.json."
    );
  }
  return root;
}
