import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlDriver } from "./driver.ts";
import { PostgresDriver } from "./postgres.ts";
import { SqliteDriver } from "./sqlite.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "..", "..", "..", "migrations");

export async function migrate(driver: SqlDriver): Promise<string[]> {
  const applied: string[] = [];
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    // The bootstrap migration creates schema_migrations itself; check lazily.
    let done = false;
    try {
      done = !!(await driver.get("SELECT name FROM schema_migrations WHERE name = ?", [file]));
    } catch {
      done = false;
    }
    if (done) continue;
    await driver.exec(sql);
    await driver.run("INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)", [file, new Date().toISOString()]);
    applied.push(file);
  }
  return applied;
}

/**
 * Open the configured database: `DATABASE_URL=postgres://…` selects PostgreSQL,
 * otherwise a SQLite file (`DATABASE_FILE`, default `data/procurement.db`).
 */
export async function openDatabase(opts: { databaseUrl?: string; sqliteFile?: string } = {}): Promise<SqlDriver> {
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  let driver: SqlDriver;
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    driver = await PostgresDriver.connect(url);
  } else {
    driver = new SqliteDriver(opts.sqliteFile ?? process.env.DATABASE_FILE ?? join(MIGRATIONS_DIR, "..", "data", "procurement.db"));
  }
  await migrate(driver);
  return driver;
}
