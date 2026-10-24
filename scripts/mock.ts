import { spawn } from "node:child_process";

const pythonBin = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const child = spawn(pythonBin, ["starter-kit/mock-apis/mock_server.py", "--no-flake", ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
