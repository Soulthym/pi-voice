import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

// Shell-only service schedules, not Android/hardware dispatch-closure evidence.
// A failed/timed-out caller can leave a queued native request after it exits.
for (const script of ["client/pi-voice-termux-stt-session", "termux/pi-voice-stt-session"]) {
	for (const outcome of ["failed", "timeout", "interrupted", "empty-success", "unknown", "json", "wrong-path", "error", "success", "success-no-space", "success-retained", "success-missing-active", "success-delayed-quit"]) test(`${script}: ${outcome} start completion gates idle stop proof`, async t => {
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
-f) printf '%s' "$2" > "$TMPDIR/queued-start"
    case ${outcome} in
      success*) printf audio > "$2"; touch "$TMPDIR/running";;
    esac
    case ${outcome} in
      empty-success) exit 0;;
      unknown) printf 'Unknown response\\n';;
      json) printf '{"message":"Recording started: %s"}\\n' "$2";;
      wrong-path) printf 'Recording started: %s.other \\nMax Duration: 00:01\\n' "$2";;
      error) printf '{"error":"Recording start error"}\\n';;
      success-no-space) printf 'Recording started: %s\\nMax Duration: 00:01\\n' "$2";;
      *) printf 'Recording started: %s \\nMax Duration: 00:01\\n' "$2";;
    esac
    case ${outcome} in
      failed) exit 1;;
      timeout) sleep 5;;
      interrupted) kill -TERM $$;;
    esac;;
-q) ${outcome === "success-delayed-quit" ? 'touch "$TMPDIR/queued-quit"; rm -f "$TMPDIR/running"; sleep 5;' : ""}
    ${["success-retained", "success-missing-active"].includes(outcome) ? '[[ -e "$TMPDIR/allow-stop" ]] &&' : ""} rm -f "$TMPDIR/running"; exit 0;;
-i) if [[ -e "$TMPDIR/running" ]]; then printf '{"isRecording":true}'; else printf '{"isRecording":false}'; fi;;
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
		const admission = await new Promise<string>(resolve => {
			owner.child.stdout.once("data", data => resolve(String(data).trim().slice(7)));
		});
		const [ticket, boot] = admission.split(" ");
		assert.match(ticket, /^[0-9a-f]{32}\.1$/);
		assert.equal(boot, (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim());
		owner.child.stdin.write(`record ${admission}\n`);
		for (let i = 0; i < 400; i++) {
			if (await fs.stat(path.join(root, "queued-start")).catch(() => false)) break;
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		const recording = await fs.readFile(path.join(root, "queued-start"), "utf8");
		owner.child.stdin.end();
		await owner.closed;
		const state = path.join(root, "pi-voice/microphone/termux");
		if (outcome === "success-missing-active") {
			assert.ok(await fs.stat(path.join(root, "running")));
			await fs.unlink(path.join(state, "active"));
			for (const command of [`stop ${ticket}\n`, "ticket\n"]) {
				const rejected = connect(command); rejected.child.stdin.end();
				assert.equal(await rejected.closed, "", "missing owner must neither acknowledge stop nor admit");
			}
			assert.ok(await fs.stat(path.join(state, "recording")));
			assert.ok(await fs.stat(path.join(root, "running")));
			return;
		}
		const stop = connect(`stop ${ticket}\n`);
		stop.child.stdin.end();
		const reply = await stop.closed;
		if (outcome === "success" || outcome === "success-no-space") {
			assert.equal(reply, `ok ${Buffer.from(`stopped ${ticket}`).toString("base64")}\n`);
			assert.match(await fs.readFile(path.join(state, "start-completed"), "utf8"), new RegExp(`^${ticket}:`));
			assert.equal(await fs.stat(path.join(state, "active")).catch(() => false), false);
			return;
		}
		assert.match(reply, /^error /);
		assert.match(await fs.readFile(path.join(state, "active"), "utf8"), new RegExp(`^${ticket}:`));
		if (outcome === "success-delayed-quit") {
			assert.ok(await fs.stat(path.join(state, "quit-uncertain")));
			assert.ok(await fs.stat(path.join(state, "start-completed")));
			assert.equal(await fs.stat(path.join(root, "running")).catch(() => false), false, "idle snapshot does not close the queued quit");
			const blocked = connect("ticket\n");
			const next = await new Promise<string>(resolve => blocked.child.stdout.once("data", data => resolve(String(data).trim().slice(7))));
			blocked.child.stdin.end(`record ${next}\n`);
			assert.match(await blocked.closed, /\nerror /);
			// Deliver the service's outstanding quit only after replacement was attempted.
			await fs.rename(path.join(root, "queued-quit"), path.join(root, "delivered-quit"));
			const retry = connect(`stop ${ticket}\n`); retry.child.stdin.end();
			assert.match(await retry.closed, /^error /, "no completion evidence can be invented on retry");
			assert.ok(await fs.stat(path.join(state, "active")));
			return;
		}
		if (outcome === "success-retained") {
			assert.match(await fs.readFile(path.join(state, "start-completed"), "utf8"), new RegExp(`^${ticket}:`));
			await fs.writeFile(path.join(root, "allow-stop"), "");
			const retry = connect(`stop ${ticket}\n`); retry.child.stdin.end();
			assert.equal(await retry.closed, `ok ${Buffer.from(`stopped ${ticket}`).toString("base64")}\n`);
			assert.equal(await fs.stat(path.join(state, "active")).catch(() => false), false);
			return;
		}
		assert.equal(await fs.stat(path.join(state, "start-completed")).catch(() => false), false);
		// Same boot; no new helper, ticket, tunnel or host admission. A service
		// request not covered by the receipt is still capable of physical work.
		await fs.writeFile(recording, "synthetic queued Android start");
		await fs.writeFile(path.join(root, "running"), ticket);
		assert.equal(await fs.readFile(path.join(root, "running"), "utf8"), ticket);
		assert.ok(await fs.stat(path.join(state, "active")));
		// Runtime loss does not erase durable uncertainty or rotate the epoch.
		const nextRuntime = path.join(root, "new-runtime"); await fs.mkdir(nextRuntime);
		env.TMPDIR = nextRuntime;
		const retry = connect(`stop ${ticket}\n`); retry.child.stdin.end();
		assert.match(await retry.closed, /^error /);
		const blocked = connect("ticket\n");
		const next = await new Promise<string>(resolve => blocked.child.stdout.once("data", data => resolve(String(data).trim().slice(7))));
		assert.equal(next, `${ticket.split(".")[0]}.2 ${boot}`);
		blocked.child.stdin.end(`record ${next}\n`);
		assert.match(await blocked.closed, /\nerror /);
		assert.equal(await fs.stat(path.join(nextRuntime, "queued-start")).catch(() => false), false);
	});
}
