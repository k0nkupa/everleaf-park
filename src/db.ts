import { current } from "./runtime.ts";
import { freePlots, plotKey } from "./park-grid.ts";
export type SQLValue = string | number | null;
export const statement = (sql: string, ...args: SQLValue[]) =>
  current()
    .env.DB.prepare(sql)
    .bind(...args);
export async function one<T>(sql: string, ...args: SQLValue[]) {
  return (await statement(sql, ...args).first<T>()) ?? undefined;
}
export async function many<T>(sql: string, ...args: SQLValue[]) {
  return (await statement(sql, ...args).all<T>()).results;
}
export async function run(sql: string, ...args: SQLValue[]) {
  const result = await statement(sql, ...args).run();
  return { changes: result.meta.changes };
}
export const batch = (statements: D1PreparedStatement[]) =>
  current().env.DB.batch(statements);
export async function takenPlots() {
  return new Set(
    (
      await many<{ i: number; j: number; k: number }>(
        "SELECT park_i i,park_j j,park_k k FROM memorials WHERE park_k IS NOT NULL",
      )
    ).map(plotKey),
  );
}
export async function nextFreePlot() {
  return freePlots(await takenPlots(), 1)[0];
}
