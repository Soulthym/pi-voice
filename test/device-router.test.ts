import assert from "node:assert/strict";
import * as fs from "node:fs";
import net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DeviceRouter, type VoiceDeviceRegistration } from "../src/device-router.js";

function fixture(t: { after(fn: () => void): void }) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-devices-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const write = (id: string, audioEndpoint = "tcp://127.0.0.1:8765", inputEndpoint = "unix:///missing-input.sock") => {
		const device: VoiceDeviceRegistration = {
			version: 1, id, name: id, platform: "linux", audioEndpoint, inputEndpoint, connectedAt: 1, lastActive: 1,
		};
		fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify(device));
		return device;
	};
	return { directory, write };
}

test("routing returns metadata even for broken forwards, without opening TCP or Unix connections", async t => {
	const { directory, write } = fixture(t);
	const create = t.mock.method(net, "createConnection", () => { throw new Error("destructive probe"); });
	const connect = t.mock.method(net.Socket.prototype, "connect", () => { throw new Error("destructive probe"); });
	const device = write("B");
	write("A");
	const router = new DeviceRouter(directory, "B", {});
	for (const direction of ["input", "output"] as const) {
		assert.deepEqual(await router.route("auto", direction), {
			kind: "device", endpoint: direction === "input" ? device.inputEndpoint : device.audioEndpoint, device,
		});
	}
	assert.equal(create.mock.callCount(), 0);
	assert.equal(connect.mock.callCount(), 0);
	fs.unlinkSync(path.join(directory, "B.json"));
	await assert.rejects(router.route("auto", "output"), { code: "device_unavailable" });
	assert.throws(() => router.resolve("auto"), { code: "device_unavailable" });
});

test("unpinned SSH/tmux auto fails closed even with another registered device", async t => {
	const { directory, write } = fixture(t);
	write("other");
	for (const context of [{ SSH_CONNECTION: "ssh" }, { SSH_CLIENT: "ssh" }, { SSH_TTY: "/dev/pts/1" }, { TMUX: "/tmp/socket,1,0" }, { PI_VOICE_DEVICE_TARGET: "target" }]) {
		const router = new DeviceRouter(directory, "", context);
		await assert.rejects(router.route("auto", "output"), { code: "missing_identity" });
		assert.throws(() => router.resolve("auto"), { code: "missing_identity" });
		assert.throws(() => router.claim("auto"), { code: "missing_identity" });
		assert.deepEqual(await router.route("local", "output"), { kind: "intentional_local", endpoint: "local" });
		assert.deepEqual(await router.route("auto", "output", "local"), { kind: "intentional_local", endpoint: "local" });
		assert.deepEqual(await router.route("auto", "input", "disabled"), { kind: "disabled", endpoint: "disabled" });
		assert.deepEqual(await router.route("auto", "output", "unix:///custom"), { kind: "custom", endpoint: "unix:///custom" });
		assert.equal((await router.route("other", "output")).kind, "device");
	}
});

test("local auto never discovers registered devices; explicit claims do not adopt a pin", async t => {
	const { directory, write } = fixture(t);
	const router = new DeviceRouter(directory, "", {});
	for (const id of ["one", "two"]) {
		write(id);
		assert.deepEqual(await router.route("auto", "output"), { kind: "intentional_local", endpoint: "local" });
		assert.equal(router.resolve("auto"), undefined);
	}
	assert.ok(router.claim("one")!.lastActive > 1);
	assert.equal(router.resolve("auto"), undefined);
	router.setEnvironmentDevice("one");
	assert.equal(router.resolve("auto")?.id, "one");
});

test("only the selected endpoint is format validated, never connectivity tested", async t => {
	const { directory, write } = fixture(t);
	const router = new DeviceRouter(directory, "B", {});
	for (const endpoint of ["garbage", "tcp://example.com:1234", "tcp://127.0.0.1:0", "tcp://127.0.0.1:65536", "tcp://127.0.0.1:1234/path", "tcp://user@127.0.0.1:1234", "unix://host/path", "unix:///", "unix:///bad%00path", "unix:///bad%XX", "unix:///path?query"]) {
		write("B", endpoint);
		await assert.rejects(router.route("auto", "output"), { code: "device_unavailable" });
		assert.equal((await router.route("auto", "input")).kind, "device");
	}
	for (const endpoint of ["tcp://127.0.0.1:8765", "tcp://[::1]:8765", "unix:///missing%20socket"]) {
		write("B", endpoint);
		assert.equal((await router.route("auto", "output")).endpoint, endpoint);
	}
});
