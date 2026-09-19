import { spawnSync } from "node:child_process";

const env = { ...process.env };
for (const key of Object.keys(env)) {
	if (["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "TMUX", "TMUX_PANE"].includes(key)
		|| (key.startsWith("PI_VOICE_") && !key.startsWith("PI_VOICE_TEST_"))) delete env[key];
}

const result = spawnSync(process.execPath, [
	"--import", "tsx", "--test", "--experimental-test-module-mocks", "--test-concurrency=4",
	...process.argv.slice(2), "test/*.test.ts",
], { env, stdio: "inherit" });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
