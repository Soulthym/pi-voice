import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";

import { nativeBinding } from "./helpers/native-binding.js";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
	const deadline = performance.now() + 8000;
	while (!check() && performance.now() < deadline) await delay(20);
	assert.ok(check(), "timed out waiting for helper");
}

function fixture(t: TestContext, script: string) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-stop-deadline-"));
	const children: ChildProcessWithoutNullStreams[] = [];
	const bin = path.join(root, "bin");
	const env = {
		PATH: `${bin}:/usr/bin:/bin`, HOME: path.join(root, "home"),
		TMPDIR: path.join(root, "runtime"), XDG_RUNTIME_DIR: path.join(root, "runtime"),
		XDG_STATE_HOME: path.join(root, "state"), XDG_CONFIG_HOME: path.join(root, "config"),
		LC_ALL: "C",
	};
	for (const directory of [bin, env.HOME, env.TMPDIR, env.XDG_STATE_HOME, env.XDG_CONFIG_HOME]) {
		fs.mkdirSync(directory, { mode: 0o700 });
	}
	t.after(async () => {
		await Promise.all(children.map(async child => {
			const closed = child.exitCode !== null || child.signalCode !== null ? undefined : once(child, "close");
			try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Already reaped. */ }
			child.stdin.destroy();
			await closed;
		}));
		fs.rmSync(root, { recursive: true, force: true });
	});
	const fake = (name: string, source: string) => fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o700 });
	fake("mpv", `
const fs = require('fs'), net = require('net');
${nativeBinding}
const ipc = process.argv.find(a => a.startsWith('--input-ipc-server=')).split('=')[1];
const base = process.env.TMPDIR + '/player';

let quitting = false;
net.createServer(socket => socket.on('data', data => {
 const command = JSON.parse(String(data)).command;
 if (command[0] === 'quit' && !quitting) {
  quitting = true;
  fs.writeFileSync(base + '.quit', '');
  setTimeout(() => process.exit(0), 2000);
 }
 socket.end('{"data":0,"request_id":1}\\n');
})).listen(ipc);
`);
	fake("socat", `
const socket = require('net').createConnection(process.argv.at(-1).replace('UNIX-CONNECT:', ''));
socket.on('error', () => process.exit(1));
socket.on('connect', () => process.stdin.pipe(socket));
socket.pipe(process.stdout);
setTimeout(() => process.exit(0), 150);
`);
	function start(args = [path.resolve(script)]) {
		const child = spawn("/usr/bin/bash", args, { env, detached: true });
		children.push(child);
		let output = "", errors = "";
		child.stdout.on("data", chunk => output += chunk);
		child.stderr.on("data", chunk => errors += chunk);
		child.stdin.on("error", () => {});
		const done = once(child, "close");
		return { child, done, output: () => output, errors: () => errors };
	}
	const state = (id: string) => path.join(env.XDG_STATE_HOME, "pi-voice/playback", id);
	function committed() {
		const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		fs.mkdirSync(state(id), { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(state(id), "prepared"), "null\n", { mode: 0o600 });
		fs.writeFileSync(path.join(state(id), "committed"), "", { mode: 0o600 });
		return id;
	}
	async function lock(id: string) {
		// Hold the real kernel lock in the shell's main body, not a background
		// sleep whose inherited descriptor could outlive the intended holder.
		const holder = start(["-c", 'exec 9>"$1"; flock -x 9 || exit 1; echo locked; read -r release', "holder", path.join(state(id), "lock")]);
		await until(() => holder.output() === "locked\n");
		return holder;
	}
	function stop(id: string) {
		const request = start();
		request.child.stdin.end(`PI_VOICE_CONTROLstop ${id}\n`);
		return request;
	}
	return { root, env, start, state, committed, lock, stop };
}

for (const script of ["client/pi-voice-audio-session", "termux/pi-voice-audio-session"]) {
	test(`${script}: queued stop waits for lock and actual delayed player exit`, { timeout: 15000 }, async t => {
		const f = fixture(t, script);
		const guardian = f.start();
		guardian.child.stdin.write("PI_VOICE_CONTROLhello\nPI_VOICE_PREPARE 4\n");
		await until(() => guardian.output().includes('"type":"prepared"'));
		const prepared = guardian.output().trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "prepared");
		guardian.child.stdin.write(`PI_VOICE_COMMIT ${prepared.id} ${prepared.boot_id}\n`);
		await until(() => guardian.output().includes('"type":"session"'));
		const state = f.state(prepared.id);
		const holder = await f.lock(prepared.id);
		const began = performance.now();
		const stopped = f.stop(prepared.id);
		await delay(2000);
		assert.equal(stopped.output(), "", "queued lock is not stop proof");
		assert.equal(stopped.child.exitCode, null);
		assert.equal(fs.existsSync(path.join(state, "stopped")), false);
		holder.child.stdin.end("release\n");
		assert.equal((await holder.done)[0], 0);
		await until(() => fs.existsSync(path.join(f.env.TMPDIR, "player.quit")));
		assert.equal(stopped.output(), "", "quit dispatch is not child-wait proof");
		assert.equal(fs.existsSync(path.join(state, "exited")), false);
		assert.equal(guardian.child.exitCode, null);
		assert.equal((await stopped.done)[0], 0, stopped.errors());
		const elapsed = performance.now() - began;
		assert.ok(elapsed >= 3900 && elapsed < 12000, `lock plus exit wait took ${elapsed}ms`);
		assert.deepEqual(JSON.parse(stopped.output()), { type: "stopped", id: prepared.id, boot_id: prepared.boot_id, proof: "native-process-exit" });
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, "exited"), "utf8")), { id: prepared.id, boot_id: prepared.boot_id, proof: "native-process-exit" });
		assert.equal(fs.existsSync(path.join(state, "not-admitted")), false);
		assert.equal((await guardian.done)[0], 0, guardian.errors());
	});

	test(`${script}: committed scope without exited receipt times out without ACK`, { timeout: 12000 }, async t => {
		const f = fixture(t, script);
		const id = f.committed();
		const began = performance.now();
		const stopped = f.stop(id);
		assert.equal((await stopped.done)[0], 0, stopped.errors());
		const elapsed = performance.now() - began;
		assert.ok(elapsed >= 4900 && elapsed < 10000, `receipt polling took ${elapsed}ms`);
		assert.equal(stopped.output(), "", "missing player/socket must not manufacture ACK");
		assert.ok(fs.existsSync(path.join(f.state(id), "stopped")));
		for (const proof of ["exited", "not-admitted"]) assert.equal(fs.existsSync(path.join(f.state(id), proof)), false);
	});

	test(`${script}: scope lock held beyond flock deadline rejects without ACK`, { timeout: 12000 }, async t => {
		const f = fixture(t, script);
		const id = f.committed();
		const holder = await f.lock(id);
		const began = performance.now();
		const stopped = f.stop(id);
		const result = await stopped.done;
		const elapsed = performance.now() - began;
		assert.equal(result[0], 1, stopped.errors());
		assert.ok(elapsed >= 4900 && elapsed < 10000, `flock deadline took ${elapsed}ms`);
		await delay(Math.max(0, 5500 - elapsed));
		assert.equal(holder.child.exitCode, null, "lock must remain held throughout rejection");
		assert.equal(stopped.output(), "");
		for (const file of ["stopped", "exited", "not-admitted"]) assert.equal(fs.existsSync(path.join(f.state(id), file)), false);
		holder.child.stdin.end("release\n");
		assert.equal((await holder.done)[0], 0);
	});
}
