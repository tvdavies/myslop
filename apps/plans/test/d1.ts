import type { Database } from "bun:sqlite";

// D1 shim over SQLite. Hooks let tests put a revision exactly between the
// route's plan read and its guarded review write, rather than rely on timing.
export function d1(db: Database, hooks: { beforeRun?: (sql: string) => void; afterRun?: (sql: string) => void } = {}) {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const stmt = {
        bind(...bound: unknown[]) {
          values = bound;
          return stmt;
        },
        first: async <T>() => (db.query(sql).get(...(values as never[])) as T | null) ?? null,
        all: async <T>() => ({ results: db.query(sql).all(...(values as never[])) as T[] }),
        run: async () => {
          hooks.beforeRun?.(sql);
          const result = db.query(sql).run(...(values as never[]));
          hooks.afterRun?.(sql);
          return { success: true, meta: { changes: result.changes } };
        },
      };
      return stmt;
    },
  };
}
