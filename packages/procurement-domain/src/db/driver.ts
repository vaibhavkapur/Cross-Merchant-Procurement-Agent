/**
 * Minimal synchronous-or-async SQL driver abstraction. SQL is written once with
 * `?` positional placeholders; drivers translate as needed. Every mutation that
 * must be atomic runs inside `transaction`, which serialises writers:
 *   - SQLite: BEGIN IMMEDIATE (database-level write lock)
 *   - PostgreSQL: BEGIN + explicit `SELECT ... FOR UPDATE` in the ledger code
 */
export type SqlParam = string | number | null | bigint;
export type Row = Record<string, unknown>;

export interface SqlExecutor {
  run(sql: string, params?: SqlParam[]): Promise<{ changes: number }>;
  get<T extends Row = Row>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  all<T extends Row = Row>(sql: string, params?: SqlParam[]): Promise<T[]>;
  readonly dialect: "sqlite" | "postgres";
}

export interface SqlDriver extends SqlExecutor {
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}
