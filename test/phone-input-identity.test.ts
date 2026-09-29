import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { PhoneInputClient } from "../src/phone-input.js";

for (const script of ["termux/pi-voice-stt-session", "client/pi-voice-termux-stt-session"]) {
	for (const identity of [undefined, "null", "phone-1"]) test(`${script}: nullable identity ${identity}`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-identity-"));
		t.after(() => fs.rm(root, { recursive: true, force: true }));
		await fs.mkdir(path.join(root, "pi-voice"), { mode: 0o700 });
		if (identity !== undefined) await fs.writeFile(path.join(root, "pi-voice/device-id"), identity);
		const header = spawnSync("bash", [script], { input: "ticket-admit\n", encoding: "utf8",
			env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root } }).stdout;
		assert.equal(header.trim().split(" ")[4], JSON.stringify(identity ?? null));
		let retained: Parameters<NonNullable<ConstructorParameters<typeof PhoneInputClient>[0]>>[0] | undefined;
		const commands: string[] = [];
		const server = net.createServer(socket => {
			socket.once("data", raw => {
				if (String(raw).startsWith("stop ")) {
					socket.end(`ok ${Buffer.from(`stopped ${String(raw).trim().slice(5)}`).toString("base64")}\n`);
					return;
				}
				commands.push(String(raw)); socket.write(header);
				socket.once("data", raw => { commands.push(String(raw)); socket.end("ok b2s=\n"); });
			});
		});
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
		const address = server.address(); assert.ok(address && typeof address === "object");
		await new PhoneInputClient(handle => { retained = handle; }).capture(`tcp://127.0.0.1:${address.port}`);
		assert.equal(retained?.deviceId, identity);
		assert.equal(retained?.networkAdmission, true);
		// index's automatic-route admission requires independently matching identity.
		const selectedDevice = "null";
		const rebootSafe = retained?.networkAdmission === true && retained.deviceId === selectedDevice;
		assert.equal(rebootSafe, identity === "null");
		assert.match(commands[1], /^record /);
	});
}

for (const identity of ["phone-1", '""', '"bad id"', '"null" extra', "undefined"]) {
	test(`reject ambiguous/malformed admission identity ${identity}`, async t => {
		let start = false;
		const server = net.createServer(socket => socket.once("data", () => {
			socket.write(`ticket ${"a".repeat(32)}.1 11111111-1111-4111-8111-111111111111 admit-v1 ${identity}\n`);
			socket.once("data", () => { start = true; });
		}));
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
		const address = server.address(); assert.ok(address && typeof address === "object");
		await assert.rejects(new PhoneInputClient().capture(`tcp://127.0.0.1:${address.port}`), /admission unavailable/);
		assert.equal(start, false);
	});
}
