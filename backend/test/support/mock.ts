import { spawn, type ChildProcess } from "node:child_process";

/** Starts the starter-kit mock on its own port for a test file; state is fresh each time. */
export async function startMock(port: number, { flaky = false } = {}): Promise<{ baseUrl: string; stop: () => void }> {
  const args = ["starter-kit/mock-apis/mock_server.py", "--port", String(port)];
  if (!flaky) args.push("--no-flake");
  const pythonBin = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const proc: ChildProcess = spawn(pythonBin, args, { stdio: "ignore" });
  const baseUrl = `http://localhost:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error("mock did not start");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { baseUrl, stop: () => proc.kill() };
}
