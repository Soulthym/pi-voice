import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { PhoneInputClient } from "../src/phone-input.js";

function ticketServer(handler: (socket: net.Socket, receipt: string) => void): net.Server {
	let ticket = 0;
	const epoch = randomBytes(16).toString("hex");
	return net.createServer(socket => {
		socket.once("data", raw => {
			const command = String(raw);
			if (command === "ticket\n") {
				socket.write(`ticket ${epoch}.${++ticket}\n`);
				socket.once("data", () => { handler(socket, ""); socket.emit("data", "record\n"); });
			} else {
				assert.match(command, /^stop [0-9a-f]{32}\.[1-9][0-9]*\n$/);
				handler(socket, `ok ${Buffer.from(`stopped ${command.trim().slice(5)}`).toString("base64")}\n`); socket.emit("data", "stop\n");
			}
		});
	});
}

async function listen(server: net.Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return address.port;
}

function wav(samples = 16000, overshoot = false): Buffer {
	const width = overshoot ? 4 : 2;
	const audio = Buffer.alloc(44 + samples * width);
	audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4);
	audio.write("WAVEfmt ", 8); audio.writeUInt32LE(16, 16);
	audio.writeUInt16LE(overshoot ? 3 : 1, 20); audio.writeUInt16LE(1, 22);
	audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(16000 * width, 28);
	audio.writeUInt16LE(width, 32); audio.writeUInt16LE(width * 8, 34);
	audio.write("data", 36); audio.writeUInt32LE(samples * width, 40);
	if (overshoot) for (let i = 0; i < samples; i++) audio.writeFloatLE(i % 2 ? -1.0243 : 1.0243, 44 + i * 4);
	return audio;
}

test("requests a phone recording and decodes the returned audio", async () => {
	const expectedAudio = Buffer.from([0, 1, 2, 3, 254, 255]);
	const server = ticketServer(socket => {
		socket.setEncoding("utf8");
		socket.once("data", command => {
			assert.equal(command, "record\n");
			socket.end(`audio ${expectedAudio.toString("base64")}\n`);
		});
	});
	const port = await listen(server);
	try {
		const client = new PhoneInputClient();
		const capture = await client.capture(`tcp://127.0.0.1:${port}`);
		assert.equal(capture.type, "audio");
		if (capture.type === "audio") assert.deepEqual(capture.data, expectedAudio);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test("cancellation finishes the old stop before a replacement capture starts", async () => {
	let activeRecord: net.Socket | undefined;
	let records = 0;
	const commands: string[] = [];
	const server = ticketServer((socket, receipt) => {
		socket.on("error", (error: NodeJS.ErrnoException) => assert.equal(error.code, "ECONNRESET"));
		socket.setEncoding("utf8");
		socket.once("data", command => {
			commands.push(String(command));
			if (String(command) === "stop\n") {
				activeRecord?.destroy();
				activeRecord = undefined;
				socket.end(receipt);
				return;
			}
			records += 1;
			if (records === 1) {
				activeRecord = socket;
				socket.write(Buffer.concat([Buffer.from("stream\n"), wav(160000)]));
			} else socket.end(`audio ${Buffer.from("replacement").toString("base64")}\n`);
		});
	});
	const port = await listen(server);
	try {
		const client = new PhoneInputClient();
		const first = client.capture(`tcp://127.0.0.1:${port}`);
		const firstRejected = assert.rejects(first);
		await new Promise(resolve => setTimeout(resolve, 30));
		const cancellation = client.cancel();
		const replacement = client.capture(`tcp://127.0.0.1:${port}`);
		await firstRejected;
		await cancellation;
		const result = await replacement;
		assert.equal(result.type, "audio");
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.deepEqual(commands, ["record\n", "stop\n", "record\n"], "cancelled decoder must not stop the replacement");
	} finally {
		activeRecord?.destroy();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test("connects to microphone bridges forwarded over Unix sockets", async () => {
	const socketPath = path.join(os.tmpdir(), `pi-voice-input-${process.pid}-${Date.now()}.sock`);
	const server = ticketServer(socket => {
		socket.once("data", command => {
			assert.equal(String(command), "record\n");
			socket.end(`audio ${Buffer.from("unix-audio").toString("base64")}\n`);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	try {
		const capture = await new PhoneInputClient().capture(`unix://${socketPath}`);
		assert.equal(capture.type, "audio");
		if (capture.type === "audio") assert.equal(capture.data.toString(), "unix-audio");
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test("accepts a live binary phone audio stream and drains the decoder before resolving", async () => {
	// Float WAV includes legal decoder overshoot, like Opus reconstructed from PCM16.
	const expectedAudio = wav(16000, true);
	const server = ticketServer((socket, receipt) => {
		socket.once("data", command => socket.end(String(command) === "stop\n"
			? receipt : Buffer.concat([Buffer.from("stream\n"), expectedAudio])));
	});
	const port = await listen(server);
	try {
		const client = new PhoneInputClient();
		let samples = 0;
		const capture = await client.capture(`tcp://127.0.0.1:${port}`, { onAudio: pcm => {
			samples += pcm.length;
			assert.ok(pcm.every(sample => Math.abs(sample) === 1), "decoded overshoot must be clamped");
		} });
		assert.equal(capture.type, "audio");
		if (capture.type === "audio") assert.deepEqual(capture.data, expectedAudio);
		assert.equal(samples, 16000, "capture must wait for all decoded PCM before resolving");
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

for (const audio of [wav(0), Buffer.from("not an audio container")]) test("rejects streams without decoded samples with a private actionable diagnostic", async () => {
	const server = ticketServer((socket, receipt) => {
		socket.once("data", command => socket.end(String(command) === "stop\n"
			? receipt : Buffer.concat([Buffer.from("stream\n"), audio])));
	});
	const port = await listen(server);
	try {
		await assert.rejects(new PhoneInputClient().capture(`tcp://127.0.0.1:${port}`), /no decodable audio; check the selected device's recorder/);
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("failed microphone stop rejects cancellation and prevents replacement capture until confirmed", async () => {
	let records = 0;
	let safe = false;
	const recording = Promise.withResolvers<void>();
	const server = ticketServer((socket, receipt) => {
		socket.on("error", () => {});
		socket.once("data", command => {
			if (String(command) === "record\n") {
				records++; recording.resolve();
				if (safe) socket.end(`audio ${Buffer.from("replacement").toString("base64")}\n`);
			} else socket.end(safe ? receipt : `error ${Buffer.from("Stop unconfirmed").toString("base64")}\n`);
		});
	});
	const port = await listen(server);
	const client = new PhoneInputClient();
	try {
		const first = assert.rejects(client.capture(`tcp://127.0.0.1:${port}`), /cancelled/);
		await recording.promise;
		await assert.rejects(client.cancel(), /Stop unconfirmed/);
		await first;
		await assert.rejects(client.capture(`tcp://127.0.0.1:${port}`), /Stop unconfirmed/);
		assert.equal(records, 1);
		safe = true;
		await client.capture(`tcp://127.0.0.1:${port}`);
		assert.equal(records, 2);
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const response of ["legacy", "generic", "foreign", "wrong-counter", "timeout", "disconnect"]) test(`microphone ${response} is not a stop acknowledgement`, async t => {
	const commanded = Promise.withResolvers<void>();
	let connection: net.Socket | undefined;
	const server = ticketServer((socket, receipt) => {
		connection = socket;
		socket.once("data", command => {
			if (String(command) === "record\n") { commanded.resolve(); return; }
			commanded.resolve();
			if (["legacy", "generic", "foreign", "wrong-counter"].includes(response)) {
				const message = response === "legacy" ? "stopping" : response === "generic" ? "stopped"
					: response === "foreign" ? `stopped ${"f".repeat(32)}.1`
					: Buffer.from(receipt.trim().slice(3), "base64").toString().replace(/\.1$/, ".2");
				socket.end(`ok ${Buffer.from(message).toString("base64")}\n`);
			}
			if (response === "disconnect") socket.end();
		});
	});
	const port = await listen(server);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const client = new PhoneInputClient();
		const capture = assert.rejects(client.capture(`tcp://127.0.0.1:${port}`));
		await commanded.promise;
		const stopped = assert.rejects(client.stop(`tcp://127.0.0.1:${port}`), /not confirmed|timed out|closed/);
		await commanded.promise;
		if (response === "timeout") {
			await new Promise(resolve => setImmediate(resolve));
			t.mock.timers.tick(10_000);
		}
		await stopped;
		const cancelled = client.cancel();
		if (response === "timeout") { await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(10_000); }
		await assert.rejects(cancelled, /not confirmed|timed out|closed/);
		await capture;
	} finally {
		connection?.destroy();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

for (const stop of [false, true]) test(`${stop ? "stop" : "cancel"} before ticket never sends record`, async () => {
	const requested = Promise.withResolvers<net.Socket>();
	const commands: string[] = [];
	const server = net.createServer(socket => {
		socket.on("error", () => {});
		socket.on("data", raw => { commands.push(String(raw)); requested.resolve(socket); });
	});
	const port = await listen(server);
	const client = new PhoneInputClient();
	try {
		const capture = assert.rejects(client.capture(`tcp://127.0.0.1:${port}`), /cancelled/);
		const socket = await requested.promise;
		await (stop ? client.stop("tcp://127.0.0.1:1") : client.cancel());
		socket.end("ticket 1\n");
		await capture;
		assert.deepEqual(commands, ["ticket\n"]);
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("synchronous cancellation before connection setup never requests a ticket", async () => {
	const client = new PhoneInputClient();
	const capture = assert.rejects(client.capture("invalid endpoint"), /cancelled/);
	await client.cancel();
	await capture;
});

test("stop uses the active capture endpoint, not a newly routed endpoint", async () => {
	const recorded = Promise.withResolvers<void>();
	let active: net.Socket | undefined;
	const server = ticketServer((socket, receipt) => socket.once("data", command => {
		if (String(command) === "record\n") { active = socket; recorded.resolve(); }
		else { socket.end(receipt); active?.end("ok \n"); }
	}));
	const port = await listen(server);
	try {
		const client = new PhoneInputClient();
		const capture = client.capture(`tcp://127.0.0.1:${port}`);
		await recorded.promise;
		await client.stop("tcp://127.0.0.1:1");
		assert.deepEqual(await capture, { type: "text", data: "" });
	} finally { active?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const ticket of ["1", `${"a".repeat(32)}.0`, `${"a".repeat(32)}.9007199254740992`]) test(`rejects unsafe admission ${ticket}`, async () => {
	const commands: string[] = [];
	const server = net.createServer(socket => socket.on("data", raw => {
		commands.push(String(raw)); socket.end(`ticket ${ticket}\n`);
	}));
	const port = await listen(server);
	try {
		await assert.rejects(new PhoneInputClient().capture(`tcp://127.0.0.1:${port}`), /update the recorder/);
		assert.deepEqual(commands, ["ticket\n"]);
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("reassigned endpoint cannot confirm an unconfirmed origin; retry at origin can", async () => {
	const a = "a".repeat(32), b = "b".repeat(32);
	let origin = a, latest = 1, confirmed = false;
	const recorded = Promise.withResolvers<void>();
	const stops: string[] = [];
	const server = net.createServer(socket => {
		socket.on("error", () => {});
		socket.on("data", raw => {
			const command = String(raw).trim();
			if (command === "ticket") socket.write(`ticket ${origin}.${latest}\n`);
			else if (command.startsWith("record ")) recorded.resolve();
			else {
				stops.push(command);
				socket.end(command === `stop ${origin}.1` && latest >= 1 && confirmed
					? `ok ${Buffer.from(`stopped ${origin}.1`).toString("base64")}\n` : `error ${Buffer.from("Stop unconfirmed").toString("base64")}\n`);
			}
		});
	});
	const port = await listen(server);
	try {
		const client = new PhoneInputClient();
		const capture = assert.rejects(client.capture(`tcp://127.0.0.1:${port}`), /cancelled/);
		await recorded.promise;
		await assert.rejects(client.cancel(), /unconfirmed/); await capture;
		origin = b; latest = 10; confirmed = true;
		await assert.rejects(client.stop(), /unconfirmed/);
		origin = a;
		await client.stop();
		assert.deepEqual(stops, Array(3).fill(`stop ${a}.1`));
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
