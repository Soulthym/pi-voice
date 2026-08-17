import assert from "node:assert/strict";
import * as net from "node:net";
import test from "node:test";
import { PhoneInputClient } from "../src/phone-input.js";

async function listen(server: net.Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return address.port;
}

test("requests a phone recording and decodes the returned audio", async () => {
	const expectedAudio = Buffer.from([0, 1, 2, 3, 254, 255]);
	const server = net.createServer(socket => {
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

test("accepts a live binary phone audio stream", async () => {
	const expectedAudio = Buffer.from("OggS-stream-payload");
	const server = net.createServer(socket => {
		socket.once("data", () => socket.end(Buffer.concat([Buffer.from("stream\n"), expectedAudio])));
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
