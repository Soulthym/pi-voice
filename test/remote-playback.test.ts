import assert from "node:assert/strict";
import { once } from "node:events";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { REMOTE_STOP_DEADLINE_MS, stopRemotePlayback } from "../src/remote-playback.mjs";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const boot = "11111111-1111-1111-1111-111111111111";
const nextBoot = "22222222-2222-2222-2222-222222222222";
const originalDevice = "original-device_1.0";

test("stop receipts require exact scope; reboot requires explicit same-device opt-in and both known boots", async () => {
	const reboot = { type: "stopped", id, boot_id: nextBoot, device_id: originalDevice, proof: "reboot", expected_boot_id: boot };
	const cases: { bootId?: string | null; deviceId?: string; allowReboot?: boolean; nativeWatchdog?: boolean; event: object; accepted: boolean; sendBoot?: boolean }[] = [
		{ bootId: boot, event: { type: "stopped", id, boot_id: boot }, accepted: true },
		{ bootId: null, event: { type: "stopped", id, boot_id: null }, accepted: true },
		{ event: { type: "stopped", id }, accepted: true },
		{ bootId: null, event: { type: "stopped", id }, accepted: false },
		{ bootId: boot, event: reboot, accepted: false },
		{ bootId: boot, allowReboot: true, event: reboot, accepted: true },
		{ bootId: boot, allowReboot: true, event: { ...reboot, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, accepted: false },
		{ bootId: boot, allowReboot: true, event: { ...reboot, expected_boot_id: nextBoot }, accepted: false },
		{ bootId: boot, allowReboot: true, event: { ...reboot, expected_boot_id: undefined }, accepted: false },
		{ bootId: boot, allowReboot: true, event: { ...reboot, boot_id: boot }, accepted: false },
		{ bootId: boot, allowReboot: true, event: { ...reboot, boot_id: null }, accepted: false },
		{ bootId: boot, allowReboot: true, event: { ...reboot, boot_id: "invented" }, accepted: false },
		{ bootId: boot, allowReboot: true, event: { ...reboot, proof: undefined }, accepted: false },
		{ bootId: null, allowReboot: true, event: { ...reboot, expected_boot_id: null }, accepted: false },
		{ allowReboot: true, event: { ...reboot, expected_boot_id: undefined }, accepted: false },
	];
	const native = { type: "stopped", id, boot_id: boot, proof: "native-process-exit" };
	cases.push(
		{ bootId: boot, event: native, accepted: false },
		{ bootId: boot, nativeWatchdog: true, event: native, accepted: true },
		{ bootId: null, nativeWatchdog: true, event: { ...native, boot_id: null }, accepted: false },
		{ nativeWatchdog: true, event: native, accepted: false },
		{ bootId: boot, nativeWatchdog: true, event: { ...native, proof: undefined }, accepted: false },
		{ bootId: boot, nativeWatchdog: true, event: { ...native, boot_id: nextBoot }, accepted: false },
		{ bootId: boot, nativeWatchdog: true, event: { ...native, id: nextBoot }, accepted: false },
		{ bootId: boot, nativeWatchdog: true, allowReboot: true, event: reboot, accepted: true },
		{ bootId: boot, allowReboot: true, event: { ...reboot, device_id: "foreign-device" }, accepted: false },
		{ bootId: boot, allowReboot: true, event: { ...reboot, device_id: undefined }, accepted: false },
		{ bootId: boot, allowReboot: true, event: { ...reboot, device_id: null }, accepted: false },
	);
	const sealed = { type: "stopped", id, boot_id: boot, proof: "sealed-nonadmission" };
	cases.push(
		{ bootId: boot, nativeWatchdog: true, event: sealed, accepted: true },
		{ bootId: boot, event: sealed, accepted: false },
		{ bootId: null, nativeWatchdog: true, event: { ...sealed, boot_id: null }, accepted: false },
		{ nativeWatchdog: true, event: sealed, accepted: false },
		{ bootId: boot, nativeWatchdog: true, event: { ...sealed, boot_id: nextBoot }, accepted: false },
		{ bootId: boot, nativeWatchdog: true, event: { ...sealed, id: nextBoot }, accepted: false },
		{ bootId: boot, nativeWatchdog: true, event: { ...sealed, proof: "not-admitted" }, accepted: false },
	);
	for (const deviceId of ["", "legacy-loopback", "bad/id", "x".repeat(129), "device\n", "device\r", "device\u2028"]) {
		cases.push({ bootId: boot, deviceId, allowReboot: true, event: { ...reboot, device_id: deviceId }, accepted: false, sendBoot: false });
	}
	for (const { bootId, deviceId = originalDevice, allowReboot, nativeWatchdog, event, accepted, sendBoot = true } of cases) {
		let command = "";
		const server = net.createServer({ allowHalfOpen: true }, peer => {
			peer.on("data", chunk => command += chunk);
			peer.on("end", () => peer.end(`${JSON.stringify(event)}\n`));
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const output = `tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
			const stopped = stopRemotePlayback({ output, id, bootId, deviceId: deviceId || undefined, allowReboot, nativeWatchdog });
			if (accepted) await stopped;
			else await assert.rejects(stopped, { code: "REMOTE_PLAYBACK_UNCONFIRMED" });
			assert.equal(command, `PI_VOICE_CONTROLstop ${id}${sendBoot && allowReboot === true && typeof bootId === "string" ? ` ${bootId}` : ""}\n`);
		} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
	}
});

test("stop deadline accepts delayed proof, rejects drop/wrong/silent/trickling peers without extending the budget", { timeout: 25_000 }, async () => {
	assert.equal(REMOTE_STOP_DEADLINE_MS, 20_000);
	await Promise.all(["delayed", "drop", "wrong", "silent", "trickle"].map(async mode => {
		const sockets = new Set<net.Socket>();
		const timers: NodeJS.Timeout[] = [];
		const server = net.createServer({ allowHalfOpen: true }, peer => {
			sockets.add(peer);
			peer.on("error", () => {});
			peer.resume();
			peer.on("end", () => {
				const receipt = JSON.stringify({ type: "stopped", id: mode === "wrong" ? "wrong" : id, boot_id: boot }) + "\n";
				if (mode === "delayed") timers.push(setTimeout(() => peer.end(receipt), 1800));
				if (mode === "wrong") peer.end(receipt);
				if (mode === "drop") peer.destroy();
				if (mode === "trickle") timers.push(setInterval(() => peer.write("{}\n"), 100));
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const start = performance.now();
		try {
			const stopped = stopRemotePlayback({ output: `tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`, id, bootId: boot });
			if (mode === "delayed") { await stopped; assert.ok(performance.now() - start >= 1800); }
			else await assert.rejects(stopped, error => {
				assert.equal((error as { code: string }).code, "REMOTE_PLAYBACK_UNCONFIRMED");
				if (["silent", "trickle"].includes(mode)) assert.match(String(error), /control timed out after 20000ms/);
				return true;
			});
			assert.ok(performance.now() - start < REMOTE_STOP_DEADLINE_MS + 3000);
		} finally {
			for (const timer of timers) clearInterval(timer);
			for (const peer of sockets) peer.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	}));
});

for (const helper of ["client/pi-voice-audio-session", "termux/pi-voice-audio-session"]) {
test(`${helper}: reboot proof independently reads device identity without fabricating child-wait receipts`, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-reboot-"));
	try {
		const bootFile = path.join(root, "boot");
		const script = path.join(root, "session");
		fs.writeFileSync(script, fs.readFileSync(helper, "utf8").replace("/proc/sys/kernel/random/boot_id", bootFile));
		fs.copyFileSync(path.join(path.dirname(helper), "pi-voice-mpv-watchdog.lua"), path.join(root, "pi-voice-mpv-watchdog.lua"));
		const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_RUNTIME_DIR: root, XDG_STATE_HOME: path.join(root, "state"), XDG_CONFIG_HOME: "", PI_VOICE_DEVICE_ID: "must-not-be-used" };
		const deviceFile = path.join(root, ".config/pi-voice/device-id");
		fs.mkdirSync(path.dirname(deviceFile), { recursive: true });
		const stop = (expected: string) => {
			const result = spawnSync("bash", [script], { env, input: `PI_VOICE_CONTROLstop ${id}${expected}\n`, encoding: "utf8", timeout: 3000 });
			assert.ifError(result.error);
			assert.equal(result.status, 0, result.stderr);
			return result.stdout;
		};
		fs.writeFileSync(bootFile, nextBoot);
		for (const value of [null, "", "bad/id", "bad\"id", "x".repeat(129), "device\nextra", "device\n\n", "device\r\n", "de\0vice", "é", originalDevice, originalDevice + "\n", "x".repeat(128)]) {
			if (value === null) fs.rmSync(deviceFile, { force: true });
			else fs.writeFileSync(deviceFile, value);
			const expected = value === originalDevice || value === originalDevice + "\n" ? originalDevice : value === "x".repeat(128) ? value : null;
			assert.deepEqual(JSON.parse(stop(` ${boot}`)), { type: "stopped", id, boot_id: nextBoot, device_id: expected, proof: "reboot", expected_boot_id: boot });
		}
		env.XDG_CONFIG_HOME = path.join(root, "config");
		assert.equal(JSON.parse(stop(` ${boot}`)).device_id, null, "XDG path must not fall back to HOME or environment identity");
		fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, "pi-voice"), { recursive: true });
		fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, "pi-voice/device-id"), "foreign-device\n");
		assert.equal(JSON.parse(stop(` ${boot}`)).device_id, "foreign-device");
		assert.equal(fs.existsSync(env.XDG_STATE_HOME), false, "reboot proof must not create fake durable receipts");
		const configuredDevice = path.join(env.XDG_CONFIG_HOME, "pi-voice/device-id");
		for (const value of [null, "invalid/id", "foreign-device\n"]) {
			if (value === null) fs.unlinkSync(configuredDevice);
			else fs.writeFileSync(configuredDevice, value);
			const prepared = spawnSync("bash", [script], { env, input: "PI_VOICE_CONTROLhello\nPI_VOICE_PREPARE 4\n", encoding: "utf8", timeout: 3000 });
			assert.ifError(prepared.error);
			assert.equal(prepared.status, 1, "EOF before commit must prevent playback");
			const event = prepared.stdout.trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "prepared");
			assert.equal(event?.device_id, value === "foreign-device\n" ? "foreign-device" : null);
		}
		for (const expected of ["", " null", ` ${nextBoot}`, " invalid", ` ${boot} extra`]) assert.equal(stop(expected), "");
		for (const current of [null, "invalid"]) {
			if (current === null) fs.unlinkSync(bootFile);
			else fs.writeFileSync(bootFile, current);
			assert.equal(stop(` ${boot}`), "", "unknown current boot cannot prove reboot");
		}
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
}
