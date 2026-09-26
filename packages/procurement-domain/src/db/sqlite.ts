import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Row, SqlDriver, SqlExecutor, SqlParam } from "./driver.ts";

/**
 * Durable local store on Node's built-in SQLite (WAL mode so the API and the
 * recovery worker can share one file). Writers are serialised by
 * `BEGIN IMMEDIATE`, which gives the same "one writer at a time" guarantee the
 * budget ledger relies on with `FOR UPDATE` in PostgreSQL.
 */
export class SqliteDriver implements SqlDriver {
  readonly dialect = "sqlite" as const;
  private readonly db: DatabaseSync;
  private txDepth = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: SqlParam[] = []): Promise<{ changes: number }> {
    const r = this.db.prepare(sql).run(...(params as never[]));
    return { changes: Number(r.changes) };
  }

  async get<T extends Row = Row>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  async all<T extends Row = Row>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  /**
   * Transactions are queued so concurrent callers within one process cannot
   * interleave statements inside another caller's BEGIN/COMMIT window.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    // Nested call from inside an open transaction joins it. Transaction bodies
    // must only issue database statements (no network I/O), so a nested call
    // can only originate from the body currently holding the lock.
    if (this.txDepth > 0) return fn(this);
    const runTx = async (): Promise<T> => {
      this.db.exec("BEGIN IMMEDIATE");
      this.txDepth++;
      try {
        const result = await fn(this);
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* already rolled back */
        }
        throw err;
      } finally {
        this.txDepth--;
      }
    };
    const next = this.queue.then(runTx, runTx);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
