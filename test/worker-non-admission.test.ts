import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test("real helper startup pause refusal releases only verified non-admitted ownership through worker/client", { timeout: 10000 }, async t => {
	const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	let pcm = 0;
	const server = net.createServer(socket => {
		socket.on("error", () => {});
		socket.on("data", bytes => {
			if (String(bytes) === "PI_VOICE_CONTROLhello\n") socket.write('{"type":"protocol","version":2}\n');
			else if (String(bytes) === "PI_VOICE_AUDIO\n") {
				// Remove the endpoint after assigning a handle, before startup pause.
				server.close();
				socket.write(JSON.stringify({ type: "session", version: 2, id }) + "\n");
			} else pcm += bytes.length;
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const output = `tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
	const wire: any[] = [];
	mock.module("node:child_process", { namedExports: { spawn: (command: string, args: string[], options: any) => {
		const child = realSpawn(command, ["--experimental-test-module-mocks", "--import", fileURLToPath(new URL("./helpers/worker-transport-mocks.mjs", import.meta.url)), ...args], options);
		let buffer = "";
		child.stdout!.on("data", bytes => {
			buffer += bytes;
			let end: number;
			while ((end = buffer.indexOf("\n")) >= 0) {
				wire.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
			}
		});
		return child;
	} } });
	t.after(() => mock.reset());
	const { VoiceWorkerClient } = await import("../src/worker-client.js");
	const events: any[] = [];
	const worker = new VoiceWorkerClient(event => events.push(event));
	t.after(() => worker.terminate());
	worker.setPlaybackPaused(true);
	worker.sendSegment(1, 1, "Synthetic audio only", { ...DEFAULT_VOICE_CONFIG, output, audioCache: false });
	for (let i = 0; i < 500 && !wire.some(e => e.type === "error"); i++) await tick();
	const cancelId = worker.cancel();
	for (let i = 0; i < 500 && !events.some(e => e.cancelId === cancelId); i++) await tick();
	assert.ok(wire.some(e => e.type === "remote-handle" && e.id === id));
	assert.deepEqual(wire.filter(e => e.type === "remote-not-admitted"), [{ type: "remote-not-admitted", id }], JSON.stringify({ wire, pcm }));
	assert.ok(!wire.some(e => e.type === "remote-released"), "non-admission is not a physical player-exit receipt");
	assert.equal(pcm, 0);
	assert.ok(events.some(e => e.type === "idle" && e.cancelId === cancelId));
	await worker.terminate(); // Endpoint is gone: a stale retained handle would reject here.
});
