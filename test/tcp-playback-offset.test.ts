import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock, test } from "node:test";

test("host helper maps device positions without changing the client protocol", async t => {
	const sent: string[] = [];
	const socket = Object.assign(new EventEmitter(), { write: (value: string) => sent.push(value), destroy() {} });
	const control = Object.assign(new EventEmitter(), { write() {} });
	mock.module("node:net", { namedExports: {
		Socket: class { constructor() { return control; } },
		createConnection: () => socket,
	} });
	const argv = process.argv;
	process.argv = [process.execPath, "tcp-playback.mjs", "tcp://inert.invalid:1", "24000", "7", "0.25"];
	const events: any[] = [];
	mock.method(process.stdout, "write", ((chunk: any, callback?: () => void) => { events.push(JSON.parse(String(chunk))); callback?.(); return true; }) as any);
	mock.method(process, "exit", (() => {}) as any);
	mock.method(process.stdin, "pipe", (() => socket) as any);
	t.after(() => { process.argv = argv; mock.reset(); });
	await import(new URL("../src/tcp-playback.mjs", import.meta.url).href);
	const feedback = (event: object) => socket.emit("data", JSON.stringify(event) + "\n");
	const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", boot_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	socket.emit("connect");
	feedback({ type: "protocol", version: 4, native_watchdog: true, lease_seconds: 30 });
	feedback({ type: "prepared", id, boot_id, version: 4, native_watchdog: true, lease_seconds: 30 });
	control.emit("data", `grant ${id} ${boot_id}\n`);
	feedback({ type: "session", id, boot_id, version: 4 });
	try {
		for (const position of [0, 0.75, 1.25, -1, "2", null]) feedback({ type: "playback", position });
		assert.deepEqual(events, [0.25, 1, 1.5].map(position => ({ type: "playback", utterance: 7, position })));
		assert.deepEqual(sent, ["PI_VOICE_CONTROLhello\n", "PI_VOICE_PREPARE 4\n", `PI_VOICE_COMMIT ${id} ${boot_id}\n`]);
	} finally {
		feedback({ type: "complete", id, boot_id });
		socket.emit("close");
	}
});
