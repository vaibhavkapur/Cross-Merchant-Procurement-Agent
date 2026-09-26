import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const VENDOR_ROOT = join(here, "..", "vendor");

export function readVendoredJson<T = unknown>(relPath: string): T {
  return JSON.parse(readFileSync(join(VENDOR_ROOT, relPath), "utf8")) as T;
}

export function listVendoredFiles(relDir: string, ext = ".json"): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(ext)) out.push(relative(VENDOR_ROOT, full));
    }
  };
  walk(join(VENDOR_ROOT, relDir));
  return out.sort();
}

export function sha256OfVendoredFile(relPath: string): string {
  return createHash("sha256").update(readFileSync(join(VENDOR_ROOT, relPath))).digest("hex");
}
