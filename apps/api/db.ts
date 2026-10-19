import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
export interface Sql { query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> }
export interface Database extends Sql { exec(sql: string): Promise<unknown>; transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>; close(): Promise<void> }
export async function openDatabase(path = 'memory://', url?: string): Promise<Database> {
  let db: Database;
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    db = {
      query: async <T>(sql: string, values?: unknown[]) => ({ rows: (await pool.query(sql, values)).rows as T[] }),
      exec: sql => pool.query(sql), close: () => pool.end(),
      transaction: async fn => { const client = await pool.connect(); try { await client.query('BEGIN'); const value = await fn({ query: async <T>(sql: string, values?: unknown[]) => ({ rows: (await client.query(sql, values)).rows as T[] }) }); await client.query('COMMIT'); return value; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } },
    };
  } else {
    const lite = await PGlite.create(path);
    db = { query: (s, v) => lite.query(s, v), exec: s => lite.exec(s), transaction: fn => lite.transaction(fn), close: () => lite.close() };
  }
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  const migrations = [[1,'./schema.sql'],[2,'./migrations/002-classes-schedules.sql'],[3,'./migrations/003-lesson-changes.sql'],[4,'./migrations/004-resources.sql'],[5,'./migrations/005-identity.sql'],[6,'./migrations/006-imports.sql'],[7,'./migrations/007-import-sheets.sql'],[8,'./migrations/008-leave-review.sql'],[9,'./migrations/009-payroll.sql']] as const;
  for (const [version,file] of migrations) {
    if ((await db.query('SELECT 1 FROM schema_migrations WHERE version=$1',[version])).rows.length) continue;
    const sql = await readFile(new URL(file, import.meta.url), 'utf8');
    if (url) await db.transaction(async tx => { await tx.query(sql); await tx.query('INSERT INTO schema_migrations(version) VALUES($1)',[version]); });
    else await db.exec(`BEGIN; ${sql} INSERT INTO schema_migrations(version) VALUES(${version}); COMMIT;`);
  }
  return db;
}
