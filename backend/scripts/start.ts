// One command: starts the starter-kit mock (Shopify Admin + store tool + terminal on one port), waits for it, then
// the API pointed at it. To run against real systems instead, set SHOPIFY_BASE_URL etc. and use `npm run api`.
//   npm start            mock without random 429/503
//   npm run start:flaky  mock with production-like 429/503
import { spawn, type ChildProcess } from "node:child_process";

const MOCK_PORT = Number(process.env.MOCK_PORT ?? 8787);
const MOCK_URL = `http://localhost:${MOCK_PORT}`;
const flaky = process.env.MOCK_FLAKE === "1" || process.argv.includes("--flaky");
const children: ChildProcess[] = [];

async function mockIsUp(): Promise<boolean> {
  try {
    return (await fetch(`${MOCK_URL}/health`)).ok;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${what} did not come up within ${timeoutMs} ms`);
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const child = spawn(cmd, args, { stdio: "inherit", env });
  child.on("exit", (code) => {
    console.log(`${cmd} exited (${code}); shutting down`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0): never {
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (await mockIsUp()) {
  console.log(`mock already running on ${MOCK_URL}; reusing it`);
} else {
  const args = ["starter-kit/mock-apis/mock_server.py", "--port", String(MOCK_PORT)];
  if (!flaky) args.push("--no-flake");
  const pythonBin = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  run(pythonBin, args);
  await waitFor(mockIsUp, "mock server");
}

run(process.execPath, ["--import", "tsx", "src/server.ts"], {
  ...process.env,
  SHOPIFY_BASE_URL: MOCK_URL,
  SMT_BASE_URL: MOCK_URL,
  TERMINAL_BASE_URL: MOCK_URL,
});
