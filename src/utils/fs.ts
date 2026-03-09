import fs from "node:fs/promises";
import path from "node:path";

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readTextIfExists(filePath: string): Promise<string | null> {
  if (!(await fileExists(filePath))) {
    return null;
  }
  return fs.readFile(filePath, "utf8");
}

export function resolveRepoPath(repoPathInput: string): string {
  return path.resolve(repoPathInput);
}

export function ensurePathInside(baseDir: string, targetPath: string): void {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);

  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new Error(`Refusing to write outside allowed directory: ${resolvedTarget}`);
  }
}

export async function safeWriteFile(
  baseDir: string,
  relativePath: string,
  content: string,
  executable = false,
): Promise<string> {
  const outputPath = path.resolve(baseDir, relativePath);
  ensurePathInside(baseDir, outputPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, content, "utf8");
  if (executable) {
    await fs.chmod(outputPath, 0o755);
  }
  return outputPath;
}

export function toPosixRelative(baseDir: string, targetPath: string): string {
  return path.relative(baseDir, targetPath).split(path.sep).join("/");
}
