import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

// Fake commands only: these schedules are not Android/hardware validation.
for (const script of ["termux/pi-voice-stt-session", "client/pi-voice-termux-stt-session"]) for (const scenario of ["success", "idle-quit", "bare-quit", "wrong-path-quit", "unknown-start", "dead-owner", "canonical-slashes", "canonical-symlink", "dead-during-stop", "partial-ack", "unknown-quit", "timeout-quit", "failed-info"]) {
	test(`${script} network admission: ${scenario}`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-termux-network-"));
		const bin = path.join(root, "bin"); await fs.mkdir(bin);
		const state = path.join(root, "pi-voice/microphone/termux");
		const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: root, XDG_STATE_HOME: root,
			PI_VOICE_MAX_RECORD_SECONDS: "30" };
		const canonicalRecovery = scenario.startsWith("canonical-");
		if (scenario === "canonical-slashes") env.TMPDIR = `${root}//`;
		if (scenario === "canonical-symlink") {
			await fs.symlink(root, path.join(root, "alias"));
			env.TMPDIR = path.join(root, "alias");
		}
		await fs.writeFile(path.join(bin, "termux-microphone-record"), `#!/bin/bash
printf '%s\\n' "$1" >> "$HOME/calls"
case "$1" in
-f) printf '%s' "$2" > "$HOME/requested-path"
    actual="$(realpath -e "$(dirname "$2")")/$(basename "$2")"
    printf '%s' "$actual" > "$HOME/path"
    printf audio > "$actual"
    touch "$HOME/start-waiting"
    while [[ ! -e "$HOME/allow-start" ]]; do sleep 0.01; done
    ${scenario === "unknown-start" ? "printf 'unknown\\n'" : "printf 'Recording started: %s \\nMax Duration: 00:30\\n' \"$actual\""};;
-q) ${scenario === "timeout-quit" ? "sleep 5" : ""}
    ${scenario === "unknown-quit" ? "printf 'unknown\\n'" : ["idle-quit", "unknown-start"].includes(scenario) ? "printf 'No recording to stop\\n'" : scenario === "bare-quit" ? "printf 'Recording finished\\n'" : `printf 'Recording finished: %s\\n' "$(cat "$HOME/path")${scenario === "wrong-path-quit" ? ".other" : ""}"`};;
-i) printf '{"isRecording":false}'; ${scenario === "failed-info" ? "exit 1" : ""};;
esac
`, { mode: 0o700 });
		// Halt receipt publication after its bytes were written, but before rename.
		// Kill the fixture's owner and publisher; a later stop must recover the ack.
		await fs.writeFile(path.join(bin, "sync"), `#!/bin/bash
if [[ $1 == */start-completed.tmp && ! -e "$HOME/release-ack" ]]; then
  printf '%s' "$PPID" > "$HOME/ack-worker"
  touch "$HOME/ack-waiting"
  while [[ ! -e "$HOME/release-ack" ]]; do sleep 0.01; done
fi
exec /usr/bin/sync "$@"
`, { mode: 0o700 });
		const children: ReturnType<typeof spawn>[] = [];
		t.after(async () => {
			await fs.writeFile(path.join(root, "allow-start"), "");
			await fs.writeFile(path.join(root, "release-ack"), "");
			for (const child of children) {
				child.stdin?.end();
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
			}
			await Promise.all(children.map(child => child.stdout?.destroyed ? undefined
				: new Promise(resolve => child.once("close", resolve))));
			await fs.rm(root, { recursive: true, force: true });
		});
		function connect(command: string) {
			const child = spawn("bash", [path.resolve(script)], { env });
			children.push(child);
			let output = "";
			child.stdout.on("data", chunk => { output += chunk; }); child.stderr.resume();
			const closed = new Promise<string>(resolve => child.once("close", () => resolve(output)));
			child.stdin.write(command);
			return { child, closed, output: () => output };
		}
		async function until(check: () => Promise<unknown> | unknown) {
			for (let i = 0; i < 500; i++) {
				if (await check()) return;
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			assert.fail("fixture did not reach the requested schedule");
		}
		const exists = (name: string) => fs.stat(path.join(root, name)).catch(() => false);
		const capture = connect("ticket-admit\n");
		await until(() => capture.output().includes("\n"));
		const [, ticket, boot, capability] = capture.output().trim().split(" ");
		assert.equal(capability, "admit-v1");
		assert.match(ticket, /^[0-9a-f]{32}\.1$/);
		assert.equal(boot, (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim());
		capture.child.stdin.write(`record ${ticket} ${boot}\n`);
		await until(() => exists("start-waiting"));
		const recording = await fs.readFile(path.join(root, "path"), "utf8");
		assert.doesNotMatch(capture.output(), /\nstream\n/, "file creation is not admission");
		await fs.writeFile(path.join(root, "allow-start"), "");
		if (scenario !== "unknown-start") {
			await until(() => exists("ack-waiting"));
			assert.doesNotMatch(capture.output(), /\nstream\n/, "stdout ack must be durable before admission");
		}
		let stop: ReturnType<typeof connect> | undefined;
		if (canonicalRecovery || ["dead-owner", "dead-during-stop", "partial-ack"].includes(scenario)) {
			if (scenario === "dead-during-stop") {
				stop = connect(`stop ${ticket}\n`); stop.child.stdin.end();
				await until(() => exists("pi-voice/microphone/termux/stop"));
			}
			process.kill(Number(await fs.readFile(path.join(root, "ack-worker"), "utf8")), "SIGKILL");
			const exited = new Promise(resolve => capture.child.once("exit", resolve));
			capture.child.kill("SIGKILL"); await exited;
			capture.child.stdin.end();
			assert.equal(await fs.stat(path.join(state, "start-completed")).catch(() => false), false);
			assert.ok(await fs.stat(path.join(state, "start-completed.tmp")));
			if (scenario === "partial-ack") {
				await fs.writeFile(path.join(state, "start-completed.tmp"), `${ticket}:${capture.child.pid}\n${recording}\nRecording started: ${recording}\n`);
			}
		}
		if (canonicalRecovery) {
			assert.equal(await fs.readFile(path.join(root, "requested-path"), "utf8"), recording, "canonicalize before dispatch, not just when comparing stdout");
			env.TMPDIR = path.join(root, "new-tmp");
			await fs.mkdir(env.TMPDIR);
		}
		await fs.writeFile(path.join(root, "release-ack"), "");
		if (canonicalRecovery || ["unknown-start", "partial-ack", "dead-owner", "dead-during-stop"].includes(scenario)) {
			await capture.closed;
		} else await until(() => capture.output().includes("\nstream\n"));
		stop ??= connect(`stop ${ticket}\n`); stop.child.stdin.end();
		const reply = await stop.closed;
		await capture.closed;
		if (canonicalRecovery || ["success", "idle-quit", "dead-owner", "dead-during-stop"].includes(scenario)) {
			assert.equal(reply, `ok ${Buffer.from(`stopped ${ticket}`).toString("base64")}\n`);
			const ack = await fs.readFile(path.join(state, "start-completed"), "utf8");
			assert.ok(ack.includes(`Recording started: ${recording} \nMax Duration: 00:30\n`));
			assert.equal((await fs.stat(path.join(state, "start-completed"))).mode & 0o777, 0o600);
			assert.doesNotMatch(ack, /audio/, "receipt stores path and stdout, never audio");
			if (canonicalRecovery) {
				assert.match(await fs.readFile(path.join(state, "recording.tickets"), "utf8"), / retired:/);
				const before = await fs.readFile(path.join(root, "calls"), "utf8");
				const replay = connect(`stop ${ticket}\n`); replay.child.stdin.end();
				assert.equal(await replay.closed, reply);
				assert.equal(await fs.readFile(path.join(root, "calls"), "utf8"), before);
				assert.equal(await fs.readFile(path.join(state, "start-completed"), "utf8"), ack, "tombstone retains the actual path through replay");
			}
			assert.equal(await fs.stat(path.join(state, "active")).catch(() => false), false);
		} else {
			assert.match(reply, /^error /);
			assert.equal(await fs.readFile(recording, "utf8"), "audio");
			assert.ok(await fs.stat(path.join(state, "active")));
			if (scenario === "unknown-start") {
				assert.doesNotMatch(capture.output(), /\nstream\n/);
				const error = capture.output().trim().split("\n")[1];
				assert.match(Buffer.from(error.slice(6), "base64").toString(), /unknown\/pending/);
			}
			const before = await fs.readFile(path.join(root, "calls"), "utf8");
			if (["unknown-start", "partial-ack"].includes(scenario)) assert.doesNotMatch(before, /-i\n/, "bare idle must not close an unknown start");
			if (scenario.endsWith("quit")) {
				assert.ok(await fs.stat(path.join(state, "quit-uncertain")));
				const retry = connect(`stop ${ticket}\n`); retry.child.stdin.end();
				assert.match(await retry.closed, /^error /);
				assert.equal(await fs.readFile(path.join(root, "calls"), "utf8"), before, "unscoped uncertain quit must not be retried");
			}
			const blocked = connect("ticket-admit\n");
			await until(() => blocked.output().includes("\n"));
			const [, next, nextBoot] = blocked.output().trim().split(" ");
			blocked.child.stdin.end(`record ${next} ${nextBoot}\n`);
			assert.match(await blocked.closed, /\nerror /);
		}
	});
}

test("Termux ticket-admit cancellation before record is a closed dispatch", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-termux-cancel-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const env = { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, XDG_STATE_HOME: root };
	const capture = spawn("bash", [path.resolve("termux/pi-voice-stt-session")], { env });
	capture.stderr.resume();
	const line = new Promise<string>(resolve => capture.stdout.once("data", data => resolve(String(data).trim())));
	const closed = new Promise(resolve => capture.once("close", resolve));
	capture.stdin.write("ticket-admit\n");
	const [, ticket, boot, capability] = (await line).split(" ");
	assert.equal(capability, "admit-v1");
	const stop = spawn("bash", [path.resolve("termux/pi-voice-stt-session")], { env });
	let reply = ""; stop.stdout.on("data", data => { reply += data; }); stop.stderr.resume();
	const stopped = new Promise(resolve => stop.once("close", resolve));
	stop.stdin.end(`stop ${ticket}\n`); await stopped;
	assert.equal(reply, `ok ${Buffer.from(`stopped ${ticket}`).toString("base64")}\n`);
	let output = ""; capture.stdout.on("data", data => { output += data; });
	capture.stdin.end(`record ${ticket} ${boot}\n`); await closed;
	assert.equal(output, "");
	assert.equal(await fs.stat(path.join(root, "pi-voice/microphone/termux/active")).catch(() => false), false);
});
