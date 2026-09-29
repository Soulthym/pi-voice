import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import * as net from "node:net";
import { once } from "node:events";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
	for (let i = 0; i < 300; i++) {
		if (check()) return;
		await delay(20);
	}
	assert.ok(check(), "timed out");
}

for (const script of ["client/pi-voice-audio-session", "termux/pi-voice-audio-session"]) {
	test(`${script}: negotiated drain, scoped stop receipts, and lost host/ACK`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-v2-"));
		const children: ChildProcess[] = [];
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin);
		const fake = (name: string, source: string) => {
			fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
		};
		fake("mpv", `
const fs = require('fs'), net = require('net');
const ipc = process.argv.find(a => a.startsWith('--input-ipc-server=')).split('=')[1];
const id = /mpv-([0-9a-f-]+)\\.sock/.exec(ipc)[1], base = process.env.TMPDIR + '/fake-' + id;
fs.writeFileSync(base + '.pid', String(process.pid));
process.on('SIGTERM', () => {
 if (fs.existsSync(base + '.hold')) fs.writeFileSync(base + '.term', '');
 else process.exit(0);
});
let eof = false, paused = false, quitting = false;
const server = net.createServer(s => s.on('data', b => {
 const c = JSON.parse(String(b)).command;
 if (c[0] === 'quit' && !quitting) { quitting = true; setTimeout(() => { fs.writeFileSync(base + '.exit', 'stop'); process.exit(0); }, 250); }
 if (c[0] === 'set_property') { paused = c[2]; fs.appendFileSync(base + '.pause', String(paused) + '\\n'); }
 s.end('{"data":1.25,"request_id":1}\\n');
}));
server.listen(ipc);
const fd = fs.openSync(process.argv.at(-1), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
let bytes = 0;
setInterval(() => {
 try {
  const count = fs.readSync(fd, Buffer.alloc(4096));
  bytes += count;
  if (!count && bytes) { eof = true; fs.writeFileSync(base + '.eof', String(bytes)); }
 } catch (error) { if (error.code !== 'EAGAIN') throw error; }
 if (fs.existsSync(base + '.fail')) process.exit(1);
 if (fs.existsSync(base + '.early')) process.exit(0);
 if (eof && !paused && fs.existsSync(base + '.release')) { fs.writeFileSync(base + '.exit', 'natural'); process.exit(0); }
}, 20);
`);
		fake("socat", `
const net = require('net');
const socket = net.createConnection(process.argv.at(-1).replace('UNIX-CONNECT:', ''));
socket.on('error', () => process.exit(1));
socket.on('connect', () => process.stdin.pipe(socket));
socket.pipe(process.stdout);
setTimeout(() => process.exit(0), 150);
`);
		const home = path.join(root, "home");
		const stateHome = script.startsWith("client/") ? path.join(root, "state") : "";
		const playback = path.join(stateHome || path.join(home, ".local/state"), "pi-voice/playback");
		const receipt = (id: string) => path.join(playback, id, "exited");
		fs.mkdirSync(home);
		fs.writeFileSync(path.join(bin, "sync"), `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "$HOME/sync.log"
[[ ! -f "$HOME/fail-sync" ]] || exit 1
for target in "$@"; do
  [[ ! -f "$HOME/fail-directory-sync" || ! -d $target ]] || exit 1
done
exec /usr/bin/sync "$@"
`, { mode: 0o755 });
		const env = { ...process.env, HOME: home, XDG_STATE_HOME: stateHome, TMPDIR: root, XDG_RUNTIME_DIR: root, PATH: `${bin}:${process.env.PATH}` };
		function start(scriptPath = script, reusePid = false) {
			// Simulate PID reuse without touching any real process namespace.
			const args = reusePid ? ["-c", 'unset BASHPID; BASHPID=424242; source "$1"', "bash", path.resolve(scriptPath)] : [path.resolve(scriptPath)];
			const child = spawn("bash", args, { env, detached: true });
			children.push(child);
			let output = "";
			child.stdout.on("data", b => output += b);
			child.stderr.resume();
			child.stdin.on("error", () => {});
			return { child, output: () => output };
		}
		async function control(command: string, loseAck = false) {
			const session = start();
			if (loseAck) session.child.stdout.destroy();
			session.child.stdin.end(`PI_VOICE_CONTROL${command}\n`);
			await until(() => session.child.exitCode !== null);
			return session.output().replace(/,"boot_id":"[0-9a-f-]+"/g, "");
		}
		async function audio(scriptPath = script) {
			const session = start(scriptPath, true);
			session.child.stdin.write("PI_VOICE_CONTROLhello\n");
			await until(() => session.output().includes('"type":"protocol"'));
			assert.deepEqual(JSON.parse(session.output().trim()), { type: "protocol", version: 3 });
			assert.equal(fs.readdirSync(root).some(f => f === `fake-${session.child.pid}.pid`), false);
			session.child.stdin.write("PI_VOICE_PREPARE\n");
			await until(() => session.output().includes('"type":"prepared"'));
			const prepared = session.output().trim().split("\n").map(l => JSON.parse(l)).find(e => e.type === "prepared");
			assert.equal(prepared.boot_fenced, true);
			assert.equal(fs.existsSync(path.join(root, `fake-${prepared.id}.pid`)), false, "prepare must not open physical output");
			session.child.stdin.write(`PI_VOICE_COMMIT ${prepared.id} ${prepared.boot_id}\n`);
			await until(() => session.output().includes('"type":"session"'));
			const event = session.output().trim().split("\n").map(l => JSON.parse(l)).find(e => e.type === "session");
			assert.equal(event.version, 3);
			assert.ok(event.boot_id === null || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(event.boot_id));
			assert.match(event.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			return { ...session, id: event.id as string, base: path.join(root, `fake-${event.id}`) };
		}
		try {
			// Frozen pre-v2 script: the safe hello must close without launching mpv.
			const legacy = start("test/helpers/audio-session-v1.sh");
			legacy.child.stdin.end("PI_VOICE_CONTROLhello\n");
			await until(() => legacy.child.exitCode !== null);
			assert.equal(legacy.child.exitCode, 0);
			assert.equal(legacy.output(), "");
			assert.equal(fs.readdirSync(root).some(f => f.endsWith(".pid")), false);
			// The production TCP helper against the actual shell script over loopback.
			for (const scriptPath of ["test/helpers/audio-session-v1.sh", script]) {
				let connected: ReturnType<typeof start> | undefined;
				const sockets: net.Socket[] = [];
				const server = net.createServer({ allowHalfOpen: true }, socket => {
					sockets.push(socket);
					const session = start(scriptPath);
					connected ??= session;
					socket.pipe(session.child.stdin);
					session.child.stdout.pipe(socket);
					socket.on("error", () => {});
				});
				server.listen(0, "127.0.0.1");
				await once(server, "listening");
				const port = (server.address() as net.AddressInfo).port;
				const helper = spawn(process.execPath, [path.resolve("src/tcp-playback.mjs"), `tcp://127.0.0.1:${port}`, "24000", "1"], {
					stdio: ["pipe", "pipe", "pipe", "pipe"], detached: true, env,
				});
				children.push(helper);
				helper.stdout.resume(); helper.stderr.resume();
				let preparation = "";
				(helper.stdio[3] as net.Socket).on("data", chunk => {
					preparation += chunk;
					const match = /^prepared ([0-9a-f-]+) (null|[0-9a-f-]+)(?: fenced [a-zA-Z0-9._:-]+)?$/m.exec(preparation);
					if (match) {
						(helper.stdio[3] as net.Socket).write(`grant ${match[1]} ${match[2]}\n`);
						preparation = "";
					}
				});
				const exit = once(helper, "exit");
				try {
					if (scriptPath === script) (helper.stdio[3] as net.Socket).write("pause\n");
					helper.stdin.end(Buffer.alloc(64));
					if (scriptPath === script) {
						await until(() => !!connected?.output().includes('"type":"session"'));
						const id = connected!.output().split("\n").filter(Boolean).map(l => JSON.parse(l)).find(e => e.type === "session").id;
						await until(() => fs.existsSync(path.join(root, `fake-${id}.eof`)));
						assert.equal(fs.readFileSync(path.join(root, `fake-${id}.pause`), "utf8"), "true\n", "startup pause must precede PCM admission");
						fs.writeFileSync(path.join(root, `fake-${id}.release`), "");
						await delay(100);
						assert.equal(helper.exitCode, null, "paused sink cannot complete");
						(helper.stdio[3] as net.Socket).write("resume\n");
					}
					assert.equal((await exit)[0], scriptPath === script ? 0 : 2);
				} finally {
					helper.kill("SIGKILL");
					for (const socket of sockets) socket.destroy();
					server.close();
				}
			}
			// Reservation crash boundaries: no grant means no physical dispatch, and a
			// durable stop tombstone wins over a later commit on the original socket.
			for (const boundary of ["host-death", "stop-before-commit", "wrong-boot", "commit-crash"]) {
				let scriptPath = script;
				if (boundary === "commit-crash") {
					scriptPath = path.join(root, "pi-voice-audio-session-commit-crash");
					fs.writeFileSync(scriptPath, fs.readFileSync(script, "utf8").replace(
						'# Starting a new stream atomically', () => 'kill -KILL "$$"\n# Starting a new stream atomically'));
				}
				const reserved = start(scriptPath);
				reserved.child.stdin.write("PI_VOICE_CONTROLhello\nPI_VOICE_PREPARE\n");
				await until(() => reserved.output().includes('"prepared"'));
				const scope = reserved.output().split("\n").filter(Boolean).map(l => JSON.parse(l)).find(e => e.type === "prepared");
				assert.equal(fs.existsSync(path.join(root, `fake-${scope.id}.pid`)), false);
				if (boundary === "host-death") {
					reserved.child.kill("SIGKILL");
					await until(() => reserved.child.signalCode !== null);
					assert.match(await control(`stop ${scope.id}`), /stopped/);
				} else {
					if (boundary === "stop-before-commit") assert.match(await control(`stop ${scope.id}`), /stopped/);
					reserved.child.stdin.end(`PI_VOICE_COMMIT ${scope.id} ${boundary === "wrong-boot" ? scope.id : scope.boot_id}\n`);
					await until(() => reserved.child.exitCode !== null || reserved.child.signalCode !== null).catch(error => { throw new Error(`${boundary}: ${reserved.output()}`, { cause: error }); });
					if (boundary === "commit-crash") assert.equal(await control(`stop ${scope.id}`), "", "persisted possible spawn without own-child wait remains fenced");
				}
				assert.equal(fs.existsSync(path.join(root, `fake-${scope.id}.pid`)), false, boundary);
				assert.equal(fs.existsSync(receipt(scope.id)), false, "non-admission must never fabricate child-wait proof");
				if (["host-death", "stop-before-commit"].includes(boundary)) {
					assert.ok(fs.existsSync(path.join(playback, scope.id, "not-admitted")));
				}
			}
			assert.equal(await control("unknown"), "");
			const statesBeforeAdmission = fs.readdirSync(playback);
			for (const header of ["PI_VOICE_CONTROLhello\nnot audio\n", "PI_VOICE_CONTROLhello\nPI_VOICE_AUDIO\n", "legacy raw PCM must never start a player"]) {
				const playersBefore = fs.readdirSync(root).filter(file => file.startsWith("fake-") && file.endsWith(".pid"));
				const bad = start();
				bad.child.stdin.end(header);
				await until(() => bad.child.exitCode !== null);
				assert.equal(bad.output().includes('"session"'), false);
				assert.deepEqual(fs.readdirSync(root).filter(file => file.startsWith("fake-") && file.endsWith(".pid")), playersBefore);
			}
			assert.equal(await control("stop 99999999"), "", "absence is not a receipt");
			assert.equal(await control("stop aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "", "unknown UUID is not exit proof");
			assert.deepEqual(fs.readdirSync(playback), statesBeforeAdmission,
				"rejected admission without a player must not create exit proof");

			const natural = await audio();
			const playerFile = path.join(root, "pi-voice-active-player.pid");
			const playingPid = fs.readFileSync(playerFile, "utf8");
			for (const request of ["", "PI_VOICE_CONTROLhello\n"]) {
				const probe = start();
				probe.child.stdin.end(request);
				await until(() => probe.child.exitCode !== null);
				assert.equal(probe.output(), request ? '{"type":"protocol","version":3}\n' : "");
				assert.equal(fs.existsSync(path.join(root, `fake-${probe.child.pid}.pid`)), false, "probe must not spawn a player");
				assert.equal(fs.readFileSync(playerFile, "utf8"), playingPid);
				process.kill(Number(playingPid.trim().split(" ")[1]), 0);
				assert.equal(natural.child.exitCode, null, "probe must not stop existing playback");
			}
			natural.child.stdin.end(Buffer.alloc(128));
			await until(() => fs.existsSync(natural.base + ".eof"));
			assert.equal(fs.readFileSync(natural.base + ".eof", "utf8"), "128", "headers must not reach mpv");
			assert.equal(natural.output().includes('"complete"'), false);
			natural.child.kill("SIGHUP");
			await delay(100);
			assert.equal(natural.child.exitCode, null, "HUP must not truncate draining playback");
			assert.equal(fs.existsSync(receipt(natural.id)), false, "EOF is not exit proof");
			fs.writeFileSync(natural.base + ".release", "");
			await until(() => natural.child.exitCode !== null);
			assert.ok(natural.output().includes(`{"type":"complete","id":"${natural.id}","boot_id":`));
			assert.equal(await control(`stop ${natural.id}`), `{"type":"stopped","id":"${natural.id}"}\n`);

			const kernelBoot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			assert.deepEqual(JSON.parse(fs.readFileSync(receipt(natural.id), "utf8")), { id: natural.id, boot_id: kernelBoot });
			for (const directory of [path.dirname(playback), playback, path.dirname(receipt(natural.id))]) {
				assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
			}
			assert.equal(fs.statSync(receipt(natural.id)).mode & 0o777, 0o600);
			const synced = fs.readFileSync(path.join(home, "sync.log"), "utf8").split("\n");
			assert.ok(synced.filter(Boolean).every(file => file.startsWith(root)), "do not fsync inaccessible ancestors above the existing state root");
			const fileSync = synced.indexOf(receipt(natural.id) + ".tmp");
			assert.ok(fileSync >= 0);
			assert.equal(synced[fileSync + 1], path.dirname(receipt(natural.id)), "rename must be followed by directory fsync");
			assert.equal(fs.existsSync(receipt(natural.id) + ".tmp"), false);
			// A fresh runtime cannot erase a durable receipt, nor invent one.
			const freshRuntime = path.join(root, "fresh-runtime");
			fs.mkdirSync(freshRuntime);
			env.TMPDIR = env.XDG_RUNTIME_DIR = freshRuntime;
			assert.equal(await control(`stop ${natural.id}`), `{"type":"stopped","id":"${natural.id}"}\n`);
			assert.equal(await control("stop bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), "");
			env.TMPDIR = env.XDG_RUNTIME_DIR = root;
			const legacyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
			const legacyState = path.join(root, `pi-voice-session-${legacyId}`);
			fs.mkdirSync(legacyState);
			fs.writeFileSync(path.join(legacyState, "exited"), "");
			assert.equal(await control(`stop ${legacyId}`), `{"type":"stopped","id":"${legacyId}"}\n`);

			// Inject at the exact lost-receipt boundary in an isolated copy, not by timing a signal.
			const source = fs.readFileSync(script, "utf8");
			const boundary = 'mpv_pid=\npublish_exit || exit 1';
			assert.equal(source.split(boundary).length, 2);
			for (const signal of ["INT", "TERM"]) {
				const injected = path.join(root, `pi-voice-audio-session-${signal}`);
				fs.writeFileSync(injected, source.replace(boundary, () => `mpv_pid=\nkill -${signal} "$$"\npublish_exit || exit 1`));
				const interrupted = await audio(injected);
				interrupted.child.stdin.end(Buffer.alloc(32));
				await until(() => fs.existsSync(interrupted.base + ".eof"));
				fs.writeFileSync(interrupted.base + ".release", "");
				await until(() => interrupted.child.exitCode !== null);
				assert.equal(interrupted.child.exitCode, 1, `${signal} must run EXIT cleanup`);
				assert.equal(interrupted.output().includes('"complete"'), false);
				assert.equal(await control(`stop ${interrupted.id}`), `{"type":"stopped","id":"${interrupted.id}"}\n`);
			}

			for (const value of [undefined, "not-a-boot-id", "12345678-1234-5678-9abc-123456789abc"]) {
				const bootFile = path.join(root, "kernel-boot");
				if (value !== undefined) fs.writeFileSync(bootFile, value);
				const injected = path.join(root, "pi-voice-audio-session-boot");
				fs.writeFileSync(injected, source.replace("/proc/sys/kernel/random/boot_id", bootFile));
				const session = await audio(injected);
				session.child.stdin.end(Buffer.alloc(32));
				await until(() => fs.existsSync(session.base + ".eof"));
				fs.writeFileSync(session.base + ".release", "");
				await until(() => session.child.exitCode !== null);
				const expected = value?.startsWith("1234") ? value : null;
				assert.equal(JSON.parse(fs.readFileSync(receipt(session.id), "utf8")).boot_id, expected);
				const event = session.output().split("\n").filter(Boolean).map(l => JSON.parse(l)).find(e => e.type === "session");
				assert.equal(event.boot_id, expected);
				{
					const stopped = start(injected);
					stopped.child.stdin.end(`PI_VOICE_CONTROLstop ${session.id} ${expected}\n`);
					await until(() => stopped.child.exitCode !== null);
					assert.deepEqual(JSON.parse(stopped.output()), { type: "stopped", id: session.id, boot_id: expected });
					if (expected === null) {
						const pending = start(injected);
						pending.child.stdin.write("PI_VOICE_CONTROLhello\nPI_VOICE_PREPARE\n");
						await until(() => pending.output().includes('"prepared"'));
						const scope = pending.output().split("\n").filter(Boolean).map(l => JSON.parse(l)).find(e => e.type === "prepared");
						assert.equal(scope.boot_id, null);
						const cancel = start(injected);
						cancel.child.stdin.end(`PI_VOICE_CONTROLstop ${scope.id} null\n`);
						await until(() => cancel.child.exitCode !== null);
						assert.deepEqual(JSON.parse(cancel.output()), { type: "stopped", id: scope.id, boot_id: null });
						pending.child.stdin.end(`PI_VOICE_COMMIT ${scope.id} null\n`);
						await until(() => pending.child.exitCode !== null);
						assert.equal(fs.existsSync(path.join(root, `fake-${scope.id}.pid`)), false);
						assert.equal(fs.existsSync(receipt(scope.id)), false, "null-boot cancellation is non-admission, not child-wait proof");
					}
				}
			}

			{
				for (const changed of [null, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]) {
					const bootFile = path.join(root, "kernel-boot");
					fs.writeFileSync(bootFile, kernelBoot);
					const injected = path.join(root, "pi-voice-audio-session-changed-boot");
					fs.writeFileSync(injected, source.replace("/proc/sys/kernel/random/boot_id", bootFile));
					const reserved = start(injected);
					reserved.child.stdin.write("PI_VOICE_CONTROLhello\nPI_VOICE_PREPARE\n");
					await until(() => reserved.output().includes('"prepared"'));
					const scope = reserved.output().split("\n").filter(Boolean).map(l => JSON.parse(l)).find(e => e.type === "prepared");
					fs.writeFileSync(bootFile, changed ?? "unknown");
					reserved.child.stdin.end(`PI_VOICE_COMMIT ${scope.id} ${scope.boot_id}\n`);
					await until(() => reserved.child.exitCode !== null);
					assert.equal(reserved.child.exitCode, 1);
					assert.equal(fs.existsSync(path.join(root, `fake-${scope.id}.pid`)), false, "changed or unreadable known boot must prevent spawn");
					assert.equal(fs.existsSync(receipt(scope.id)), false);
				}
			}

			const failedSyncScript = path.join(root, "pi-voice-audio-session-fsync");
			fs.writeFileSync(failedSyncScript, source.replace(boundary, 'mpv_pid=\ntouch "$HOME/fail-sync"\npublish_exit || exit 1'));
			const failedSync = await audio(failedSyncScript);
			failedSync.child.stdin.end(Buffer.alloc(32));
			await until(() => fs.existsSync(failedSync.base + ".eof"));
			fs.writeFileSync(failedSync.base + ".release", "");
			await until(() => failedSync.child.exitCode !== null);
			assert.equal(failedSync.output().includes('"complete"'), false);
			assert.equal(fs.existsSync(receipt(failedSync.id)), false, "failed file fsync must not publish exit proof");
			fs.unlinkSync(path.join(home, "fail-sync"));

			fs.writeFileSync(failedSyncScript, source.replace(boundary, 'mpv_pid=\ntouch "$HOME/fail-directory-sync"\npublish_exit || exit 1'));
			const failedDirectory = await audio(failedSyncScript);
			failedDirectory.child.stdin.end(Buffer.alloc(32));
			await until(() => fs.existsSync(failedDirectory.base + ".eof"));
			fs.writeFileSync(failedDirectory.base + ".release", "");
			await until(() => failedDirectory.child.exitCode !== null);
			assert.equal(failedDirectory.output().includes('"complete"'), false);
			assert.equal(await control(`stop ${failedDirectory.id}`), "", "failed directory fsync cannot acknowledge durable proof");
			fs.unlinkSync(path.join(home, "fail-directory-sync"));
			assert.equal(await control(`stop ${failedDirectory.id}`), `{"type":"stopped","id":"${failedDirectory.id}"}\n`);

			const orphan = await audio();
			assert.notEqual(orphan.id, natural.id);
			// A persisted numeric receipt (even the current owner's PID) is never proof.
			const numericState = path.join(root, `pi-voice-session-424242`);
			fs.mkdirSync(numericState);
			fs.writeFileSync(path.join(numericState, "exited"), "");
			for (const id of ["424242", "../" + path.basename(numericState), orphan.id + "/../" + natural.id, orphan.id.toUpperCase()]) {
				for (const command of ["pause", "resume", "stop"]) assert.equal(await control(`${command} ${id}`), "");
			}
			assert.equal(fs.existsSync(orphan.base + ".pause"), false);
			assert.equal(fs.existsSync(orphan.base + ".exit"), false);
			assert.equal(await control(`stop ${natural.id}`), `{"type":"stopped","id":"${natural.id}"}\n`);
			assert.equal(fs.existsSync(orphan.base + ".exit"), false, "old opaque receipt cannot control new stream");
			// A real, owned host producer dies while the player still has buffered audio.
			const host = spawn(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(256)); setInterval(()=>{},1000)"], { detached: true, env });
			children.push(host);
			host.stdout!.pipe(orphan.child.stdin);
			await delay(100);
			host.kill("SIGKILL");
			orphan.child.stdout.destroy();
			await until(() => fs.existsSync(orphan.base + ".eof"));
			await delay(250);
			assert.equal(orphan.child.exitCode, null, "feedback disconnect must not kill buffered playback");
			await control(`pause ${orphan.id}`);
			await control(`resume ${orphan.id}`);
			assert.equal(fs.readFileSync(orphan.base + ".pause", "utf8"), "true\nfalse\n");
			assert.equal(await control("stop 99999998"), "");
			assert.equal(fs.existsSync(orphan.base + ".exit"), false, "stop must be scoped");
			await control(`stop ${orphan.id}`, true);
			assert.ok(fs.existsSync(orphan.base + ".exit"));
			assert.equal(await control(`stop ${orphan.id}`), `{"type":"stopped","id":"${orphan.id}"}\n`);
			await until(() => orphan.child.exitCode !== null);

			const held = await audio();
			fs.writeFileSync(held.base + ".hold", "");
			held.child.kill("SIGTERM");
			await until(() => fs.existsSync(held.base + ".term"));
			for (const signal of ["SIGINT", "SIGTERM"] as const) held.child.kill(signal);
			await delay(100);
			assert.equal(held.child.exitCode, null, "cleanup must keep waiting for its actual child despite repeated signals");
			assert.equal(fs.existsSync(receipt(held.id)), false);
			fs.writeFileSync(held.base + ".fail", "");
			await until(() => held.child.exitCode !== null);
			assert.equal(await control(`stop ${held.id}`), `{"type":"stopped","id":"${held.id}"}\n`);

			const replaced = await audio();
			const replacement = await audio();
			await until(() => replaced.child.exitCode !== null);
			assert.equal(await control(`stop ${replaced.id}`), `{"type":"stopped","id":"${replaced.id}"}\n`);
			assert.equal(fs.existsSync(receipt(replacement.id)), false);
			assert.equal(await control(`stop ${replacement.id}`), `{"type":"stopped","id":"${replacement.id}"}\n`);
			await until(() => replacement.child.exitCode !== null);

			const interrupted = await audio();
			interrupted.child.kill("SIGTERM");
			await until(() => interrupted.child.exitCode !== null);
			assert.equal(await control(`stop ${interrupted.id}`), `{"type":"stopped","id":"${interrupted.id}"}\n`);
			assert.equal(interrupted.output().includes('"complete"'), false);
			assert.equal(fs.existsSync(playerFile), false, "unexpected owner exit cleans up its active identity");
			const aliased = await audio();
			const aliasedPid = fs.readFileSync(playerFile, "utf8").trim().split(" ")[1];
			const otherOwner = `${natural.id} ${aliasedPid}\n`;
			fs.writeFileSync(playerFile, otherOwner);
			aliased.child.kill("SIGTERM");
			await until(() => aliased.child.exitCode !== null);
			assert.equal(fs.readFileSync(playerFile, "utf8"), otherOwner, "same PID with another stream ID is not owned cleanup");
			fs.unlinkSync(playerFile);

			for (const mode of ["fail", "early"]) {
				const failed = await audio();
				if (mode === "fail") failed.child.stdin.end(Buffer.alloc(32));
				fs.writeFileSync(failed.base + `.${mode}`, "");
				await until(() => failed.child.exitCode !== null);
				assert.equal(failed.output().includes('"complete"'), false, `${mode} is not natural completion`);
				assert.equal(await control(`stop ${failed.id}`), `{"type":"stopped","id":"${failed.id}"}\n`);
			}
			const lostOwner = await audio();
			lostOwner.child.kill("SIGKILL");
			await until(() => lostOwner.child.signalCode !== null);
			assert.equal(await control(`stop ${lostOwner.id}`), "", "even a successful quit is not the owner's child-wait receipt");
			assert.equal(fs.existsSync(lostOwner.base + ".exit"), true);
			assert.equal(fs.existsSync(receipt(lostOwner.id)), false);
		} finally {
			for (const child of children) {
				try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
				child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
			}
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}
