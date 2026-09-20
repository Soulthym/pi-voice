import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as net from "node:net";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { mock, test } from "node:test";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("network padding cancellation waits for confirmed helper exit", { timeout: 5000 }, async t => {
	const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	let receipt = false;
	const server = net.createServer(socket => socket.on("data", () => socket.end(receipt ? JSON.stringify({ type: "stopped", id }) + "\n" : "")));
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const output = `tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-network-stop-"));
	const oldCache = process.env.PI_VOICE_CACHE_DIR;
	process.env.PI_VOICE_CACHE_DIR = root;
	let lines = new EventEmitter();
	const readline = await import("node:readline");
	mock.module("node:readline", { namedExports: { ...readline,
		createInterface: (options: any) => options.input === process.stdin ? lines : readline.createInterface(options),
	} });
	mock.module("@huggingface/transformers", { namedExports: {
		env: {}, RawAudio: {}, Tensor: {}, pipeline: () => { throw Error("No inference"); },
	} });
	mock.module("kokoro-js", { namedExports: { KokoroTTS: {} } });
	const players: any[] = [];
	let rejectHandshake = false;
	let lateRefusal = false;
	mock.module("node:child_process", { namedExports: { ...(await import("node:child_process")),
		fork: () => {
			const child = Object.assign(new EventEmitter(), {
				send: ({ id }: any) => queueMicrotask(() => child.emit("message", {
					id, audio: { pcm: new Float32Array([0.5]), sampleRate: 24000 },
				})),
				kill: () => {},
			});
			return child;
		},
		spawn: (_command: string, args: string[]) => {
			if (!args[0].endsWith("/tcp-playback.mjs")) throw Error("Optional alignment unavailable");
			const writes: Buffer[] = [];
			const stdin = new Writable({ highWaterMark: 1024, write(chunk, _encoding, callback) {
				writes.push(Buffer.from(chunk));
				if (writes.length === 1) callback(); // Hold final padding under backpressure.
			} });
			const control = new PassThrough();
			const commands: string[] = [];
			control.on("data", chunk => commands.push(String(chunk)));
			const child = Object.assign(new EventEmitter(), {
				stdin, stderr: new PassThrough(), stdio: [stdin, null, null, control], writes, commands,
				exitCode: null as number | null, signalCode: null as string | null,
				kill: () => { throw Error("Test must explicitly confirm helper exit"); },
			});
			players.push(child);
			if (!lateRefusal) queueMicrotask(() => control.write(rejectHandshake ? "no-audio\nerror Upgrade the audio client\n" : "ready\n"));
			return child;
		},
	} });
	mock.method(process, "exit", (() => {}) as any);
	const events: any[] = [];
	const writeStdout = process.stdout.write.bind(process.stdout);
	mock.method(process.stdout, "write", (chunk: any) => {
		try { events.push(JSON.parse(String(chunk))); } catch { return writeStdout(chunk); }
		return true;
	});
	const send = (message: any) => lines.emit("line", JSON.stringify(message));
	t.after(async () => {
		mock.reset();
		if (oldCache === undefined) delete process.env.PI_VOICE_CACHE_DIR;
		else process.env.PI_VOICE_CACHE_DIR = oldCache;
		await fs.rm(root, { recursive: true, force: true });
	});

	for (const [name, code, signal] of [
		["rejected handshake", 2, null],
		["refusal after exit", 2, null],
		["refusal after audio admission", 2, null],
		["confirmed stop", 0, null],
		["nonzero exit", 1, null],
		["signal exit", null, "SIGTERM"],
	] as const) {
		await t.test(name, async st => {
			lines = new EventEmitter();
			events.length = 0;
			players.length = 0;
			lateRefusal = name === "refusal after exit";
			rejectHandshake = name === "rejected handshake" || lateRefusal;
			st.after(async () => {
				for (const child of players) {
					if (child.exitCode === null && child.signalCode === null) {
						child.exitCode = 0;
						child.emit("exit", 0, null);
					}
					child.stdin.destroy();
					child.stdio[3].end();
					child.stderr.destroy();
					await wait(0);
					child.emit("close", child.exitCode, child.signalCode);
				}
				send({ type: "shutdown" });
				await wait(0);
			});
			await import(new URL(`../src/worker.mjs?network-stop=${encodeURIComponent(name)}`, import.meta.url).href);
			send({ type: "segment", utterance: 1, segmentId: 1, text: "Stop test.",
				voice: "af_heart", speed: 1, output });
			send({ type: "end", utterance: 1 });
			for (let attempt = 0; attempt < 100 && (rejectHandshake ? !players[0] : players[0]?.writes.length !== 2); attempt++) await wait(5);
			const child = players[0];
			assert.ok(child, "network helper was spawned");
			if (rejectHandshake) {
				await wait(20);
				assert.deepEqual(child.writes, [], "failed handshake sent no PCM or padding");
				if (!lateRefusal) assert.ok(events.some(e => e.type === "error" && /Upgrade/.test(e.message)));
				assert.ok(!events.some(e => e.type === "idle"), "handshake failure is not completion");
				child.exitCode = 2;
				child.emit("exit", 2, null);
				await wait(20);
				if (lateRefusal) child.stdio[3].write("no-audio\nerror Upgrade the audio client\n");
				send({ type: "cancel", cancelId: 42 });
				await wait(20);
				assert.ok(child.commands.includes("stop\n"), "sink stays owned until control drains");
				assert.ok(!events.some(e => e.type === "idle"), "exit alone is not stop proof");
				child.stdio[3].end();
				child.stderr.end();
				await wait(0);
				child.emit("close", 2, null);
				await wait(20);
				assert.ok(!events.some(e => e.type === "error" && /Remote playback unconfirmed/.test(e.message)));
				assert.deepEqual(events.filter(e => e.type === "idle"), [{ type: "idle" }, { type: "idle", cancelId: 42 }], "nothing was admitted; cancellation needs no invented remote stop receipt");
				return;
			}
			assert.deepEqual(child.writes.map((chunk: Buffer) => chunk.length), [4, 96000]);
			assert.ok(child.writes[1].equals(Buffer.alloc(96000)), "final write is silence padding");
			assert.equal(child.stdin.writableNeedDrain, true);
			assert.equal(child.stdin.writableEnded, false);
			assert.ok(!events.some(e => e.type === "idle"));

			if (name === "nonzero exit") child.stdio[3].write(`session ${id}\n`);
			send({ type: "cancel", cancelId: 42 });
			await wait(20); // Let destroyed-stdin close and the cancelled end operation settle.
			assert.ok(child.commands.includes("stop\n"));
			assert.equal(child.stdin.destroyed, true);
			assert.equal(child.stdin.writableEnded, false);
			assert.equal(child.exitCode, null);
			assert.equal(child.signalCode, null);
			assert.ok(!events.some(e => e.type === "idle"), "neither utterance nor cancel idle precedes helper exit");
			assert.ok(!events.some(e => e.type === "error"));

			child.exitCode = code;
			child.signalCode = signal;
			child.emit("exit", code, signal);
			await wait(20);
			assert.ok(!events.some(e => e.type === "idle"), "exit must wait for control drain");
			if (code === 2) child.stdio[3].write("no-audio\n");
			child.stdio[3].end();
			child.stderr.end();
			await wait(0);
			child.emit("close", code, signal);
			await wait(20);
			const idle = events.filter(e => e.type === "idle");
			if (code === 0) {
				assert.deepEqual(idle, [{ type: "idle", cancelId: 42 }]);
				assert.ok(!events.some(e => e.type === "error"));
			} else {
				assert.deepEqual(idle, [], "failed helper exit must not acknowledge cancellation or utterance completion");
				assert.ok(events.some(e => e.type === "error" && e.code === "REMOTE_PLAYBACK_UNCONFIRMED"));
				if (name === "nonzero exit") {
					receipt = true;
					send({ type: "cancel", cancelId: 43 });
					for (let attempt = 0; attempt < 100 && !events.some(e => e.cancelId === 43); attempt++) await wait(5);
					assert.deepEqual(events.filter(e => e.type === "idle"), [{ type: "idle", cancelId: 43 }], "exact retry receipt clears the failed barrier");
					assert.ok(events.some(e => e.type === "remote-released" && e.id === id));
					receipt = false;
				}
			}
		});
	}
});
