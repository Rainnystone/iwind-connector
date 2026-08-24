import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

type SafeAtomicWriteOptions = Readonly<{
  target: string;
  expectedTarget: string;
  allowedDirectory: string;
  protectedPaths: ReadonlyArray<string>;
  data: string | Uint8Array;
}>;

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("SAFE_WRITE_INVALID");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parentInfo = await lstat(path.dirname(directory));
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("SAFE_WRITE_INVALID");
    await mkdir(directory, { mode: 0o755 });
  }
  if ((await realpath(directory)) !== directory) throw new Error("SAFE_WRITE_INVALID");
}

async function assertSafeFinalTarget(target: string): Promise<void> {
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("SAFE_WRITE_INVALID");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeTemporary(temporary: string): Promise<void> {
  try {
    await unlink(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function safeAtomicWrite(options: SafeAtomicWriteOptions): Promise<void> {
  const target = path.resolve(options.target);
  const expectedTarget = path.resolve(options.expectedTarget);
  const allowedDirectory = path.resolve(options.allowedDirectory);
  if (target !== expectedTarget || path.dirname(target) !== allowedDirectory) {
    throw new Error("SAFE_WRITE_INVALID");
  }
  for (const protectedPath of options.protectedPaths) {
    if (isWithin(path.resolve(protectedPath), target)) throw new Error("SAFE_WRITE_INVALID");
  }

  await ensureSafeDirectory(allowedDirectory);
  await assertSafeFinalTarget(target);

  const temporary = path.join(allowedDirectory, `.${path.basename(target)}.tmp-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(options.data);
    await handle.chmod(0o644);
    await handle.sync();
    await handle.close();
    handle = undefined;

    if ((await realpath(allowedDirectory)) !== allowedDirectory) throw new Error("SAFE_WRITE_INVALID");
    await assertSafeFinalTarget(target);
    await rename(temporary, target);
  } finally {
    await handle?.close();
    await removeTemporary(temporary);
  }
}
