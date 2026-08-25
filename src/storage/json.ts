import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ZodType, ZodTypeDef } from "zod";
import { CouncilError, errorMessage } from "../util/errors.js";

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (process.platform === "win32" && ["EEXIST", "EPERM", "EACCES"].includes(code)) {
      await rm(path, { force: true });
      await rename(temporaryPath, path);
    } else {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

/**
 * Creates an immutable JSON record without replacing an existing target. A hard-link commit keeps
 * the no-overwrite transition atomic on every supported platform because the temporary file and
 * target live in the same directory. The returned bytes are exactly the bytes committed to disk.
 */
export async function writeJsonAtomicExclusive(path: string, value: unknown): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, bytes, { flag: "wx" });
  try {
    await link(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return bytes;
}

export async function readValidatedJson<T>(
  path: string,
  schema: ZodType<T, ZodTypeDef, unknown>
): Promise<T> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CouncilError(
      "STORAGE_READ_FAILED",
      `Could not read ${path}: ${errorMessage(error)}`,
      {
        cause: error
      }
    );
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new CouncilError(
      "STORAGE_SCHEMA_INVALID",
      `Stored metadata in ${path} is invalid: ${result.error.issues.map((issue) => issue.message).join("; ")}`
    );
  }
  return result.data;
}
