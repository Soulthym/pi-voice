import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

for (const script of ["client/pi-voice-stt-session", "client/pi-voice-termux-stt-session", "termux/pi-voice-stt-session"]) {
	for (const disconnect of [false, true]) test(`${script}: ${disconnect ? "disconnect" : "stop ACK"} waits for the fake recorder`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-recorder-stop-"));
		const bin = path.join(root, "bin"); await fs.mkdir(bin);
		const linux = script === "client/pi-voice-stt-session";
		const tools: Record<string, string> = linux ? {
			wpctl: "exit 0", pactl: "exit 1", ffmpeg: "exec cat",
			"pw-record": `exec '${process.execPath}' -e 'const fs = require("fs"); fs.writeFileSync(process.env.TMPDIR + "/running", "yes"); const timer = setInterval(() => {}, 100); process.on("SIGTERM", () => setTimeout(() => { fs.unlinkSync(process.env.TMPDIR + "/running"); clearInterval(timer); process.exit(0); }, 200));'`,
		} : {
			"termux-microphone-record": `case "$1" in
-q) sleep 0.2; rm -f "$TMPDIR/running";;
-i) if [[ -e "$TMPDIR/running" ]]; then printf '{"isRecording":true}'; else printf '{"isRecording":false}'; fi;;
-f) printf 'fake audio' > "$2"; touch "$TMPDIR/running";;
esac`,
		};
		for (const [name, body] of Object.entries(tools)) await fs.writeFile(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
		const env = { ...process.env, PREFIX: "", PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root, XDG_RUNTIME_DIR: root, PI_VOICE_MAX_RECORD_SECONDS: "5" };
		const child = spawn("bash", [path.resolve(script)], { env, stdio: ["pipe", "pipe", "pipe"] });
		let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.resume();
		const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
		t.after(async () => { child.stdin.end(); await closed; await fs.rm(root, { recursive: true, force: true }); });
		child.stdin.write("record\n");
		for (let i = 0; i < 300 && !await fs.stat(path.join(root, "running")).catch(() => false); i++) await new Promise(resolve => setTimeout(resolve, 5));
		assert.ok(await fs.stat(path.join(root, "running")));
		if (disconnect) child.stdin.end();
		else {
			const stop = spawn("bash", [path.resolve(script)], { env });
			let ack = ""; stop.stdout.on("data", chunk => { ack += chunk; }); stop.stderr.resume();
			const stopped = new Promise<void>(resolve => stop.once("close", () => resolve()));
			stop.stdin.end("stop\n");
			await new Promise(resolve => setTimeout(resolve, 50));
			assert.equal(ack, "", "must not acknowledge the stop request before stopping");
			await stopped;
			assert.match(ack, /^ok /);
			assert.equal(await fs.stat(path.join(root, "running")).catch(() => false), false);
		}
		await closed;
		assert.match(output, /^stream\n/);
		assert.equal(await fs.stat(path.join(root, "running")).catch(() => false), false);
	});
}

for (const script of ["client/pi-voice-termux-stt-session", "termux/pi-voice-stt-session"]) test(`${script}: an unconfirmed Android stop retains the recording marker`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-recorder-failure-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const bin = path.join(root, "bin"); await fs.mkdir(bin);
	await fs.writeFile(path.join(bin, "termux-microphone-record"), `#!/bin/bash
case "$1" in
-f) printf 'fake audio' > "$2";;
-q) exit 0;;
-i) printf '{"isRecording":true}';;
esac
`, { mode: 0o755 });
	const child = spawn("bash", [path.resolve(script)], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root } });
	child.stdout.resume(); child.stderr.resume();
	const closed = new Promise<number | null>(resolve => child.once("close", resolve));
	child.stdin.end("record\n");
	assert.equal(await closed, 1);
	assert.ok(await fs.stat(path.join(root, "pi-voice-recording-active")));
	assert.ok(await fs.stat(path.join(root, "pi-voice-recording-lock")));
});
