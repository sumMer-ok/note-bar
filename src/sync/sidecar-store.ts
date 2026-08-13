import { promises as fs } from "fs";
import * as path from "path";
import { SIDECAR_SUFFIX, SIDECAR_VERSION, type SidecarFile } from "./types";

/** `<词库>.canvas` → `<词库>.nb-sync.json`（位于同步目录下同一相对路径） */
export function sidecarPathForBook(syncDir: string, bookRelPath: string): string {
  const base = bookRelPath.endsWith(".canvas")
    ? bookRelPath.slice(0, -".canvas".length)
    : bookRelPath;
  return path.join(syncDir, `${base}${SIDECAR_SUFFIX}`);
}

export async function readSidecar(filePath: string): Promise<SidecarFile | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw) as Partial<SidecarFile>;
    if (
      data?.version !== SIDECAR_VERSION ||
      typeof data.book !== "string" ||
      !data.words ||
      typeof data.words !== "object" ||
      Array.isArray(data.words)
    ) {
      return null;
    }
    return {
      version: SIDECAR_VERSION,
      book: data.book,
      words: data.words as SidecarFile["words"],
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export async function writeSidecarAtomic(filePath: string, data: SidecarFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
