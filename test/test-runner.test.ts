import assert from "node:assert/strict";
import { mock, test } from "node:test";

test("test runner bounds concurrency and sanitizes only the child environment", async () => {
	const parent = { ...process.env };
	const argv = process.argv;
	const exitCode = process.exitCode;
	const connection = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "TMUX", "TMUX_PANE", "PI_VOICE_CONFIG", "PI_VOICE_DEVICE_ID", "PI_VOICE_PLAYER"];
	try {
		for (const key of connection) process.env[key] = "live-state";
		process.env.PI_VOICE_TEST_TUI_MODULE = "explicit-opt-in";
		process.env.UNRELATED_TEST_RUNNER_VALUE = "preserved";
		process.argv = [process.execPath, "scripts/test.mjs", "--test-name-pattern=runner"];
		let called = false;
		mock.module("node:child_process", { namedExports: {
			spawnSync(command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: string }) {
				called = true;
				assert.equal(command, process.execPath);
				assert.deepEqual(args, ["--import", "tsx", "--test", "--experimental-test-module-mocks", "--test-concurrency=4", "--test-name-pattern=runner", "test/*.test.ts"]);
				assert.equal(options.stdio, "inherit");
				for (const key of connection) {
					assert.equal(options.env[key], undefined);
					assert.equal(process.env[key], "live-state");
				}
				assert.equal(options.env.PI_VOICE_TEST_TUI_MODULE, "explicit-opt-in");
				assert.equal(options.env.UNRELATED_TEST_RUNNER_VALUE, "preserved");
				assert.equal(options.env.PATH, parent.PATH);
				return { status: 7, signal: null };
			},
		} });
		await import(new URL("../scripts/test.mjs", import.meta.url).href);
		assert.equal(called, true);
		assert.equal(process.exitCode, 7);
	} finally {
		mock.reset();
		process.argv = argv;
		process.exitCode = exitCode;
		for (const key of Object.keys(process.env)) if (!(key in parent)) delete process.env[key];
		Object.assign(process.env, parent);
	}
});
