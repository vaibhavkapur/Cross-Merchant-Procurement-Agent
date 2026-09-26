// Minimal ambient typing for the optional PostgreSQL driver; the project only
// uses Pool#query / Pool#connect / Pool#end (see postgres.ts).
declare module "pg" {
  export interface QueryResultLike {
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }
  export interface PoolClientLike {
    query(text: string, values?: unknown[]): Promise<QueryResultLike>;
    release(): void;
  }
  export class Pool {
    constructor(options: { connectionString: string });
    query(text: string, values?: unknown[]): Promise<QueryResultLike>;
    connect(): Promise<PoolClientLike>;
    end(): Promise<void>;
  }
  const pg: { Pool: typeof Pool };
  export default pg;
}
