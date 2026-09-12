import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DeviceRouter, type VoiceDeviceRegistration } from "../src/device-router.js";

function fixture() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-devices-"));
	const write = (device: VoiceDeviceRegistration): void => {
		for (const endpoint of [device.audioEndpoint, device.inputEndpoint]) {
			const socket = decodeURIComponent(new URL(endpoint).pathname);
			fs.writeFileSync(socket, "");
		}
		fs.writeFileSync(path.join(directory, `${device.id}.json`), JSON.stringify(device));
	};
	return { directory, write };
}

test("managed loopback TCP registrations require a live reverse listener", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-devices-tcp-"));
	const server = net.createServer(socket => socket.end());
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const registration: VoiceDeviceRegistration = {
			version: 1,
			id: "tailnet-phone",
			name: "Phone",
			platform: "termux",
			audioEndpoint: `tcp://127.0.0.1:${address.port}`,
			inputEndpoint: `tcp://127.0.0.1:${address.port}`,
			connectedAt: 1,
			lastActive: 1,
		};
		fs.writeFileSync(path.join(directory, `${registration.id}.json`), JSON.stringify(registration));
		assert.equal(new DeviceRouter(directory).resolve("auto")?.id, registration.id);
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		assert.equal(new DeviceRouter(directory).resolve("auto"), undefined, "closed reverse forwards are ignored");
	} finally {
		if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("auto routing prefers the inherited client, then most recently active", () => {
	const { directory, write } = fixture();
	try {
		write({
			version: 1,
			id: "phone",
			name: "Phone",
			platform: "termux",
			audioEndpoint: `unix://${directory}/phone-audio.sock`,
			inputEndpoint: `unix://${directory}/phone-input.sock`,
			connectedAt: 1,
			lastActive: 2,
		});
		write({
			version: 1,
			id: "laptop",
			name: "Laptop",
			platform: "linux",
			audioEndpoint: `unix://${directory}/laptop-audio.sock`,
			inputEndpoint: `unix://${directory}/laptop-input.sock`,
			connectedAt: 3,
			lastActive: 4,
		});
		assert.equal(new DeviceRouter(directory).resolve("auto")?.id, "laptop");
		assert.equal(new DeviceRouter(directory, "phone").resolve("auto")?.id, "phone");
		assert.equal(new DeviceRouter(directory).resolve("local"), undefined);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("claiming a device makes it the most recently active client", () => {
	const { directory, write } = fixture();
	try {
		for (const [id, lastActive] of [
			["one", 1],
			["two", 2],
		] as const) {
			write({
				version: 1,
				id,
				name: id,
				platform: "linux",
				audioEndpoint: `unix://${directory}/${id}-audio.sock`,
				inputEndpoint: `unix://${directory}/${id}-input.sock`,
				connectedAt: lastActive,
				lastActive,
			});
		}
		const router = new DeviceRouter(directory);
		router.claim("one");
		assert.equal(router.resolve("auto")?.id, "one");
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
