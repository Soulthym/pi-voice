import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

// Characterization, NOT a safety regression: stock Android commands have no
// ticket/watermark barrier. A queued start can outlive its shell caller.
for (const script of ["client/pi-voice-termux-stt-session", "termux/pi-voice-stt-session"]) {
	test(`${script}: Android dispatch closure is required beyond an idle status`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-android-boundary-"));
		const bin = path.join(root, "bin");
		await fs.mkdir(bin);
		const env: NodeJS.ProcessEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: root,
			XDG_RUNTIME_DIR: root, XDG_STATE_HOME: root, XDG_CACHE_HOME: root, XDG_CONFIG_HOME: root,
			PI_VOICE_MAX_RECORD_SECONDS: "1" };
		// Model an Android service accepting a request before its caller exits.
		// Completion is explicitly driven below, never by a timing assumption.
		await fs.writeFile(path.join(bin, "termux-microphone-record"), `#!/bin/bash
case "$1" in
-f) printf '%s' "$2" > "$TMPDIR/queued-start"; exit 1;;
-q) rm -f "$TMPDIR/running";;
-i) printf '{"isRecording":false}';;
esac
`, { mode: 0o700 });
		const children: ReturnType<typeof spawn>[] = [];
		t.after(async () => {
			for (const child of children) {
				if (child.exitCode === null && child.signalCode === null) {
					child.stdin?.end();
					child.kill("SIGTERM");
					await new Promise(resolve => child.once("close", resolve));
				}
			}
			await fs.rm(root, { recursive: true, force: true });
		});
		function connect(command: string) {
			const child = spawn("bash", [path.resolve(script)], { env });
			children.push(child);
			let output = "";
			child.stdout.on("data", chunk => { output += chunk; });
			child.stderr.resume();
			const closed = new Promise<string>(resolve => child.once("close", () => resolve(output)));
			child.stdin.write(command);
			return { child, closed };
		}
		const owner = connect("ticket\n");
		const ticket = await new Promise<string>(resolve => {
			owner.child.stdout.once("data", data => resolve(String(data).trim().slice(7)));
		});
		assert.match(ticket, /^[0-9a-f]{32}\.1$/);
		owner.child.stdin.write(`record ${ticket}\n`);
		for (let i = 0; i < 400; i++) {
			if (await fs.stat(path.join(root, "queued-start")).catch(() => false)) break;
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		const recording = await fs.readFile(path.join(root, "queued-start"), "utf8");
		owner.child.stdin.end();
		await owner.closed;
		const stop = connect(`stop ${ticket}\n`);
		stop.child.stdin.end();
		assert.equal(await stop.closed, `ok ${Buffer.from(`stopped ${ticket}`).toString("base64")}\n`);
		// Same boot; no new helper, ticket, tunnel or host admission. A service
		// request not covered by the receipt is still capable of physical work.
		await fs.writeFile(recording, "synthetic queued Android start");
		await fs.writeFile(path.join(root, "running"), ticket);
		assert.equal(await fs.readFile(path.join(root, "running"), "utf8"), ticket);
		assert.equal(await fs.stat(path.join(root, "pi-voice-recording-active")).catch(() => false), false);
	});
}
