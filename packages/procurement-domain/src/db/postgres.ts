import type { Row, SqlDriver, SqlExecutor, SqlParam } from "./driver.ts";

/**
 * PostgreSQL driver over `pg`. Translates `?` placeholders to `$n`.
 *
 * NOTE: this environment had no PostgreSQL server available, so this driver is
 * provided for deployment (docker-compose.yml provisions Postgres) but the
 * automated test suite exercises the SQLite driver. The SQL in
 * `migrations/` and the store is written in the portable subset both accept.
 */
function translate(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
  release?(): void;
}

interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

class PgExecutor implements SqlExecutor {
  readonly dialect = "postgres" as const;
  private readonly client: PgClientLike | PgPoolLike;
  constructor(client: PgClientLike | PgPoolLike) {
    this.client = client;
  }
  async run(sql: string, params: SqlParam[] = []): Promise<{ changes: number }> {
    const r = await this.client.query(translate(sql), params);
    return { changes: r.rowCount ?? 0 };
  }
  async get<T extends Row = Row>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    const r = await this.client.query(translate(sql), params);
    return r.rows[0] as T | undefined;
  }
  async all<T extends Row = Row>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const r = await this.client.query(translate(sql), params);
    return r.rows as T[];
  }
}

export class PostgresDriver extends PgExecutor implements SqlDriver {
  private readonly pool: PgPoolLike;
  private constructor(pool: PgPoolLike) {
    super(pool);
    this.pool = pool;
  }

  static async connect(connectionString: string): Promise<PostgresDriver> {
    const mod = await import("pg");
    const Pool = mod.Pool ?? mod.default?.Pool;
    if (!Pool) throw new Error("pg module did not expose Pool");
    return new PostgresDriver(new Pool({ connectionString }) as unknown as PgPoolLike);
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new PgExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release?.();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
