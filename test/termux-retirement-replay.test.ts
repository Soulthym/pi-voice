import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

// Only fake API calls. Kill the retiring helper at each durable transition.
for (const script of ["termux/pi-voice-stt-session", "client/pi-voice-termux-stt-session"])
for (const pending of [false, true])
for (const boundary of ["publish-before", "publish-after", "remove-before", "remove-after"]) {
	test(`${script}: retirement replay ${boundary}, pending=${pending}`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-retirement-"));
		t.after(() => fs.rm(root, { recursive: true, force: true }));
		const bin = path.join(root, "bin"), state = path.join(root, "pi-voice/microphone/termux");
		await fs.mkdir(bin);
		await fs.mkdir(path.join(state, "recording"), { recursive: true, mode: 0o700 });
		const boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
		const epoch = "a".repeat(32), ticket = `${epoch}.1`, owner = `${ticket}:99999999`;
		const recording = path.join(root, `pi-voice-recording-${owner}.ogg`);
		await fs.writeFile(path.join(state, "recording.tickets"), `${epoch} 1 0 ${boot} ${owner}\n`);
		await fs.writeFile(path.join(state, "active"), `${owner}\n`);
		if (pending) await fs.writeFile(path.join(state, "pending"), "");
		else await fs.writeFile(path.join(state, "start-completed"), `${owner}\n${recording}\nRecording started: ${recording}\nMax Duration: 00:30\n`, { mode: 0o600 });
		await fs.writeFile(path.join(bin, "termux-microphone-record"), `#!/bin/bash
printf '%s\\n' "$1" >> "$HOME/calls"
case "$1" in
-q) printf 'Recording finished: %s\\n' '${recording}';;
-i) printf '{"isRecording":false}';;
*) exit 1;;
esac
`, { mode: 0o700 });
		const command = boundary.startsWith("publish") ? "mv" : "rm";
		const condition = command === "mv"
			? '[[ ${@: -1} == */recording.tickets ]] && grep -q " retired:" "${@: -2:1}"'
			: '[[ $* == *"/active"* ]]';
		await fs.writeFile(path.join(bin, command), `#!/bin/bash
if [[ ! -e "$HOME/injected" ]] && ${condition}; then
  touch "$HOME/injected"
  ${boundary.endsWith("after") ? `/usr/bin/${command} "$@" || exit 1` : ":"}
  kill -KILL "$PPID"
  exit 1
fi
exec /usr/bin/${command} "$@"
`, { mode: 0o700 });
		async function run(input: string) {
			const child = spawn("bash", [path.resolve(script)], {
				env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: root, XDG_STATE_HOME: root },
			});
			let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.resume();
			const closed = new Promise<string>(resolve => child.once("close", () => resolve(output)));
			child.stdin.end(input); return closed;
		}
		assert.equal(await run(`stop ${ticket}\n`), "");
		assert.ok(await fs.stat(path.join(root, "injected")));
		const calls = await fs.readFile(path.join(root, "calls"), "utf8").catch(() => "");
		assert.equal(calls, pending ? "" : "-q\n-i\n");
		const reply = `ok ${Buffer.from(`stopped ${ticket}`).toString("base64")}\n`;
		assert.equal(await run(`stop ${ticket}\n`), reply);
		assert.equal(await run(`stop ${ticket}\n`), reply, "replay is idempotent");
		assert.equal(await fs.stat(path.join(state, "active")).catch(() => false), false);
		assert.match(await fs.readFile(path.join(state, "recording.tickets"), "utf8"), new RegExp(` retired:${owner}\\n$`));
		if (boundary !== "publish-before") assert.equal(await fs.readFile(path.join(root, "calls"), "utf8").catch(() => ""), calls, "durable proof needs no new physical stop");
		assert.match(await run("ticket\n"), new RegExp(`^ticket ${epoch}\\.2 `));
	});
}
