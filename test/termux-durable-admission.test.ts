import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

for (const script of ["client/pi-voice-termux-stt-session", "termux/pi-voice-stt-session"]) {
	for (const existingStateHome of [true, false]) test(`${script}: publication sync stops at first existing parent (state home exists=${existingStateHome})`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-termux-sync-"));
		t.after(() => fs.rm(root, { recursive: true, force: true }));
		const bin = path.join(root, "bin"); await fs.mkdir(bin);
		const stateHome = existingStateHome ? root : path.join(root, "new", "state");
		// Model Android denying access above the app-owned tree (e.g. /data).
		await fs.writeFile(path.join(bin, "sync"), `#!/bin/bash
for target in "$@"; do
  printf '%s\\n' "$target" >> "$HOME/synced"
  case "$target" in
    "$HOME"|"$HOME"/*) ;;
    *) echo 'Permission denied' >&2; exit 1;;
  esac
done
exec /usr/bin/sync "$@"
`, { mode: 0o700 });
		const child = spawn("bash", [path.resolve(script)], {
			env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: root, XDG_STATE_HOME: stateHome },
		});
		let output = "", errors = "";
		child.stdout.on("data", chunk => { output += chunk; });
		child.stderr.on("data", chunk => { errors += chunk; });
		const closed = new Promise(resolve => child.once("close", resolve));
		child.stdin.end("ticket\n");
		await closed;
		assert.match(output, /^ticket [0-9a-f]{32}\.1 /);
		assert.equal(errors, "");
		const state = path.join(stateHome, "pi-voice/microphone/termux");
		const publication = [state, path.dirname(state), path.join(stateHome, "pi-voice"), stateHome];
		if (!existingStateHome) publication.push(path.dirname(stateHome), root);
		const synced = (await fs.readFile(path.join(root, "synced"), "utf8")).trim().split("\n");
		assert.deepEqual(synced.slice(0, publication.length), publication);
		assert.ok(synced.every(target => target === root || target.startsWith(`${root}/`)));
	});
	test(`${script}: ownership loss while stop waits cannot acknowledge retirement`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-termux-owner-loss-"));
		t.after(() => fs.rm(root, { recursive: true, force: true }));
		const state = path.join(root, "pi-voice/microphone/termux");
		await fs.mkdir(path.join(state, "recording"), { recursive: true, mode: 0o700 });
		const boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
		const epoch = "a".repeat(32), ticket = `${epoch}.1`, owner = `${ticket}:${process.pid}`;
		await fs.writeFile(path.join(state, "recording.tickets"), `${epoch} 1 0 ${boot} ${owner}\n`);
		await fs.writeFile(path.join(state, "active"), owner);
		const child = spawn("bash", [path.resolve(script)], {
			env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, XDG_STATE_HOME: root },
		});
		let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.resume();
		const closed = new Promise(resolve => child.once("close", resolve));
		t.after(async () => { child.kill("SIGTERM"); await closed; });
		child.stdin.end(`stop ${ticket}\n`);
		for (let i = 0; i < 200 && !await fs.stat(path.join(state, "stop")).catch(() => false); i++) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		assert.ok(await fs.stat(path.join(state, "stop")));
		await fs.unlink(path.join(state, "active"));
		await closed;
		assert.equal(output, "", "marker disappearance is not durable retirement");
		assert.match(await fs.readFile(path.join(state, "recording.tickets"), "utf8"), new RegExp(`${owner}\\n$`));
	});
	test(`${script}: durable boot-bound tickets, cancellation and legacy refusal`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-termux-state-"));
		t.after(() => fs.rm(root, { recursive: true, force: true }));
		const bin = path.join(root, "bin"); await fs.mkdir(bin);
		const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: root, XDG_STATE_HOME: root };
		// No hardware command may run in this admission-only test.
		await fs.writeFile(path.join(bin, "termux-microphone-record"), '#!/bin/bash\ntouch "$HOME/unexpected-api"\nexit 1\n', { mode: 0o700 });
		async function run(command: string, follow?: (line: string) => string) {
			const child = spawn("bash", [path.resolve(script)], { env });
			let output = "";
			child.stderr.resume();
			child.stdout.on("data", chunk => {
				output += chunk;
				if (follow && output.includes("\n")) {
					child.stdin.end(follow(output.trim())); follow = undefined;
				}
			});
			const closed = new Promise<string>(resolve => child.once("close", () => resolve(output)));
			if (follow) child.stdin.write(command); else child.stdin.end(command);
			return closed;
		}
		const boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
		const first = await run("ticket\n");
		const [, ticket, issuedBoot] = first.trim().split(" ");
		assert.equal(issuedBoot, boot);
		assert.match(ticket, /^[0-9a-f]{32}\.1$/);
		const epoch = ticket.split(".")[0];
		const state = path.join(root, "pi-voice/microphone/termux");
		assert.equal((await fs.stat(state)).mode & 0o777, 0o700);
		assert.equal((await fs.stat(path.join(state, "recording.tickets"))).mode & 0o777, 0o600);
		assert.equal(await run(`stop ${ticket}\n`), `ok ${Buffer.from(`stopped ${ticket}`).toString("base64")}\n`);
		assert.equal(await run("ticket\n", line => `record ${line.split(" ")[1]} 00000000-0000-0000-0000-000000000000\n`), `ticket ${epoch}.2 ${boot}\n`);
		assert.equal(await run("ticket\n", line => `record ${line.split(" ")[1]}\n`), `ticket ${epoch}.3 ${boot}\n`);
		// A persisted prior-boot dispatch is reclaimable without invoking Android.
		await fs.writeFile(path.join(state, "recording.tickets"), `${epoch} 3 1 00000000-0000-0000-0000-000000000000 ${epoch}.3:99999999\n`);
		await fs.writeFile(path.join(state, "active"), `${epoch}.3:99999999\n`);
		assert.equal(await run(`stop ${epoch}.3\n`), `ok ${Buffer.from(`stopped ${epoch}.3`).toString("base64")}\n`);
		assert.equal(await fs.stat(path.join(state, "active")).catch(() => false), false);
		assert.equal(await fs.readFile(path.join(state, "recording.tickets"), "utf8"), `${epoch} 3 3 ${boot} -\n`);
		assert.equal(await run("ticket\n"), `ticket ${epoch}.4 ${boot}\n`);
		const saved = await fs.readFile(path.join(state, "recording.tickets"), "utf8");
		await fs.writeFile(path.join(state, "recording.tickets"), `${epoch} 4 3 ${boot}\n`);
		assert.equal(await run(`stop ${epoch}.4\n`), "", "old state without dispatch proof is not idle proof");
		assert.equal(await run("ticket\n"), "");
		await fs.writeFile(path.join(state, "recording.tickets"), saved);
		await fs.writeFile(path.join(root, "pi-voice-recording-active"), "legacy-owner");
		assert.equal(await run("ticket\n"), "");
		await fs.unlink(path.join(root, "pi-voice-recording-active"));
		// Missing kernel identity fails closed; no fallback to random/process identity.
		await fs.writeFile(path.join(bin, "cat"), '#!/bin/bash\nif [[ $1 == /proc/sys/kernel/random/boot_id ]]; then exit 1; fi\nexec /bin/cat "$@"\n', { mode: 0o700 });
		assert.equal(await run("ticket\n"), "");
		assert.equal(await fs.stat(path.join(root, "unexpected-api")).catch(() => false), false);
	});
}
