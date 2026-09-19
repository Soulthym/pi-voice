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
const id = /mpv-(\\d+)/.exec(ipc)[1], base = process.env.TMPDIR + '/fake-' + id;
fs.writeFileSync(base + '.pid', String(process.pid));
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
		const env = { ...process.env, TMPDIR: root, XDG_RUNTIME_DIR: root, PATH: `${bin}:${process.env.PATH}` };
		function start(scriptPath = script) {
			const child = spawn("bash", [path.resolve(scriptPath)], { env, detached: true });
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
			return session.output();
		}
		async function audio() {
			const session = start();
			session.child.stdin.write("PI_VOICE_CONTROLhello\n");
			await until(() => session.output().includes('"type":"protocol"'));
			assert.deepEqual(JSON.parse(session.output().trim()), { type: "protocol", version: 2 });
			assert.equal(fs.readdirSync(root).some(f => f === `fake-${session.child.pid}.pid`), false);
			session.child.stdin.write("PI_VOICE_AUDIO\n");
			await until(() => session.output().includes('"type":"session"'));
			const event = session.output().trim().split("\n").map(l => JSON.parse(l)).find(e => e.type === "session");
			assert.equal(event.version, 2);
			assert.equal(typeof event.id, "number");
			return { ...session, id: event.id as number, base: path.join(root, `fake-${event.id}`) };
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
					stdio: ["pipe", "pipe", "pipe", "pipe"], detached: true,
				});
				children.push(helper);
				helper.stdout.resume(); helper.stderr.resume();
				const exit = once(helper, "exit");
				try {
					if (scriptPath === script) (helper.stdio[3] as net.Socket).write("pause\n");
					helper.stdin.end(Buffer.alloc(64));
					if (scriptPath === script) {
						await until(() => !!connected?.output().includes('"type":"session"'));
						const id = connected!.child.pid;
						await until(() => fs.existsSync(path.join(root, `fake-${id}.eof`)));
						assert.equal(fs.readFileSync(path.join(root, `fake-${id}.pause`), "utf8"), "true\n", "startup pause must precede PCM admission");
						fs.writeFileSync(path.join(root, `fake-${id}.release`), "");
						await delay(100);
						assert.equal(helper.exitCode, null, "paused sink cannot complete");
						(helper.stdio[3] as net.Socket).write("resume\n");
					}
					assert.equal((await exit)[0], scriptPath === script ? 0 : 1);
				} finally {
					helper.kill("SIGKILL");
					for (const socket of sockets) socket.destroy();
					server.close();
				}
			}
			assert.equal(await control("unknown"), "");
			const bad = start();
			bad.child.stdin.end("PI_VOICE_CONTROLhello\nnot audio\n");
			await until(() => bad.child.exitCode !== null);
			assert.equal(bad.output().includes('"session"'), false);
			assert.equal(fs.existsSync(path.join(root, `fake-${bad.child.pid}.pid`)), false);
			assert.equal(await control("stop 99999999"), "", "absence is not a receipt");

			const natural = await audio();
			const playerFile = path.join(root, "pi-voice-active-player.pid");
			const playingPid = fs.readFileSync(playerFile, "utf8");
			for (const request of ["", "PI_VOICE_CONTROLhello\n"]) {
				const probe = start();
				probe.child.stdin.end(request);
				await until(() => probe.child.exitCode !== null);
				assert.equal(probe.output(), request ? '{"type":"protocol","version":2}\n' : "");
				assert.equal(fs.existsSync(path.join(root, `fake-${probe.child.pid}.pid`)), false, "probe must not spawn a player");
				assert.equal(fs.readFileSync(playerFile, "utf8"), playingPid);
				process.kill(Number(playingPid), 0);
				assert.equal(natural.child.exitCode, null, "probe must not stop existing playback");
			}
			natural.child.stdin.end(Buffer.alloc(128));
			await until(() => fs.existsSync(natural.base + ".eof"));
			assert.equal(fs.readFileSync(natural.base + ".eof", "utf8"), "128", "headers must not reach mpv");
			assert.equal(natural.output().includes('"complete"'), false);
			fs.writeFileSync(natural.base + ".release", "");
			await until(() => natural.child.exitCode !== null);
			assert.ok(natural.output().includes(`{"type":"complete","id":${natural.id}}`));
			assert.equal(await control(`stop ${natural.id}`), `{"type":"stopped","id":${natural.id}}\n`);

			const orphan = await audio();
			// A real, owned host producer dies while the player still has buffered audio.
			const host = spawn(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(256)); setInterval(()=>{},1000)"], { detached: true });
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
			assert.equal(await control(`stop ${orphan.id}`), `{"type":"stopped","id":${orphan.id}}\n`);
			await until(() => orphan.child.exitCode !== null);

			for (const mode of ["fail", "early"]) {
				const failed = await audio();
				if (mode === "fail") failed.child.stdin.end(Buffer.alloc(32));
				fs.writeFileSync(failed.base + `.${mode}`, "");
				await until(() => failed.child.exitCode !== null);
				assert.equal(failed.output().includes('"complete"'), false, `${mode} is not natural completion`);
			}
		} finally {
			for (const child of children) {
				try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
				child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
			}
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}
