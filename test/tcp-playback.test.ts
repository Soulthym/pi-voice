import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../src/tcp-playback.mjs", import.meta.url));

test("network playback helper exits after a completed client stream", async () => {
	const socketPath = path.join(os.tmpdir(), `pi-voice-playback-${process.pid}-${Date.now()}.sock`);
	const server = net.createServer(socket => {
		socket.write('{"type":"session","id":"test"}\n');
		socket.resume();
		socket.on("end", () => socket.end());
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	const child = spawn(process.execPath, [helper, `unix://${socketPath}`, "24000", "1"], {
		stdio: ["pipe", "pipe", "pipe", "pipe"],
	});
	try {
		child.stdin.end(Buffer.alloc(1_024));
		const result = await Promise.race([
			new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
				child.once("exit", (code, signal) => resolve({ code, signal }));
			}),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("playback helper did not exit")), 2_000).unref();
			}),
		]);
		assert.equal(result.signal, "SIGTERM");
	} finally {
		child.kill("SIGKILL");
		await new Promise<void>(resolve => server.close(() => resolve()));
		fs.rmSync(socketPath, { force: true });
	}
});
