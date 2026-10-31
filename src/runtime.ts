import { AsyncLocalStorage } from "node:async_hooks";

type Runtime = {
  env: Cloudflare.Env;
  ctx: ExecutionContext;
  origin: string;
  request: Request;
};
export const runtime = new AsyncLocalStorage<Runtime>();
export function current() {
  const value = runtime.getStore();
  if (!value) throw Error("Request context is unavailable.");
  return value;
}
