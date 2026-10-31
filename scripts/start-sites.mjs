import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import "./sites-env.mjs";

const cli = new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url);
const child = spawn(process.execPath, [fileURLToPath(cli), "dev",
  "--config", "dist/server/wrangler.json", "--local", "--persist-to", ".wrangler/state",
  "--ip", "127.0.0.1", "--inspector-port", "0",
  ...(existsSync(".dev.vars") ? ["--env-file", resolve(".dev.vars")] : []),
  ...process.argv.slice(2)], { stdio: "inherit" });
child.once("error", error => { throw error; });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
process.exitCode = await new Promise(resolve => child.once("exit", code => resolve(code ?? 1)));
