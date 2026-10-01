import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { nativeBinding } from "./helpers/native-binding.js";

const CLIENT_DIR = path.resolve("client");
const MIC_EPOCH = "0123456789abcdef0123456789abcdef";
const MIC_BOOT = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

test("both Termux clients migrate only old voice labels, once", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-keyboard-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const tools = restrictedPath(root, { "termux-reload-settings": 'printf "reload\\n" >> "$HOME/reloads"' });
	for (const script of [path.join(CLIENT_DIR, "pi-voice-client"), path.resolve("termux/pi-voice-phone")]) {
		const home = fs.mkdtempSync(path.join(root, "home-"));
		fs.mkdirSync(path.join(home, ".termux"));
		const file = path.join(home, ".termux/termux.properties");
		fs.writeFileSync(file, "custom = keep this\nextra-keys = [[{key:'F7',display:'↶10'},{key:'F9',display:'10↷'}]]\n");
		fs.renameSync(file, path.join(home, "properties"));
		fs.symlinkSync(path.join(home, "properties"), file);
		for (let repeat = 0; repeat < 2; repeat++) {
			const result = await runScript(script, [], "", { HOME: home, PREFIX: "/data/com.termux/files/usr", PATH: tools });
			assert.equal(result.code, 1, "fixture intentionally lacks audio commands; no bridge is launched");
		}
		assert.equal(fs.readFileSync(file, "utf8"), "custom = keep this\nextra-keys = [[{key:'F7',display:'↶'},{key:'F9',display:'↷'}]]\n");
		assert.equal(fs.readFileSync(path.join(home, "reloads"), "utf8"), "reload\n");
		assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
	}
});

interface RunResult {
	code: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** Runs a client script to completion; kills its whole process group on timeout. */
function runScript(
	script: string,
	args: string[],
	input: string,
	env: Record<string, string>,
	timeoutMs = 15_000,
	cwd = "/",
): Promise<RunResult> {
	return new Promise(resolve => {
		const child = spawn("bash", [script, ...args], {
			env,
			cwd,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		// Recording requests negotiate their ticket on the same connection.
		if (input === "record\n") child.stdin.write("ticket\n");
		else child.stdin.end(input);
		let awaitingTicket = input === "record\n";
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", chunk => {
			stdout += chunk.toString("utf8");
			const ticket = awaitingTicket && /^ticket ([0-9a-f]{32}\.[1-9][0-9]*) ([0-9a-f-]{36})\n/.exec(stdout);
			if (ticket) {
				awaitingTicket = false;
				child.stdin.write(`record ${ticket[1]} ${ticket[2]}\n`);
			}
		});
		child.stderr.on("data", chunk => {
			stderr += chunk.toString("utf8");
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, timeoutMs);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr, timedOut });
		});
	});
}

function decodeMessage(line: string): { status: string; message: string } {
	const parts = line.replace(/^ticket [0-9a-f]{32}\.[1-9][0-9]* [0-9a-f-]{36}\n/, "").trim().split(" ", 2);
	const status = parts[0] ?? "";
	const payload = parts[1] ?? "";
	return { status, message: Buffer.from(payload, "base64").toString("utf8") };
}

/** Creates a directory of fake commands that shadow the real audio tooling. */
function makeFakeBin(root: string, scripts: Record<string, string>): string {
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin, { recursive: true });
	for (const [name, body] of Object.entries(scripts)) {
		const file = path.join(bin, name);
		fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
		fs.chmodSync(file, 0o755);
	}
	return bin;
}

/** Coreutils the client scripts legitimately need; everything else stays absent. */
const RESTRICTED_TOOLS = [
	"bash", "sh", "basename", "cat", "chmod", "cmp", "dd", "dirname", "env", "grep", "sed", "head", "id", "kill", "sync",
	"wc", "mkdir", "mkfifo", "mv", "od", "printf", "python3", "readlink", "uname", "ls", "realpath", "rm", "rmdir", "flock", "sh", "sleep", "stat", "tail", "timeout", "touch", "tr", "base64", "setsid", "ps",
];

/** Builds a deterministic PATH: whitelisted coreutils plus explicit fakes only. */
function restrictedPath(root: string, fakes: Record<string, string>): string {
	const bin = makeFakeBin(root, fakes);
	const core = path.join(root, "core");
	fs.mkdirSync(core, { recursive: true });
	for (const tool of RESTRICTED_TOOLS) {
		try {
			fs.symlinkSync(`/usr/bin/${tool}`, path.join(core, tool));
		} catch {
			// Already linked or unavailable on this host.
		}
	}
	try {
		fs.symlinkSync(process.execPath, path.join(core, "node"));
	} catch {
		// Already linked.
	}
	return `${bin}:${core}`;
}

function baseEnv(overrides: Record<string, string>): Record<string, string> {
	const root = overrides.XDG_RUNTIME_DIR || overrides.TMPDIR;
	assert.ok(root, "fixtures require a temporary runtime directory");
	return {
		PATH: "/usr/bin:/bin",
		HOME: root,
		XDG_STATE_HOME: path.join(root, "state"),
		XDG_RUNTIME_DIR: root,
		TMPDIR: root,
		PREFIX: "",
		PI_VOICE_MAX_RECORD_SECONDS: "2",
		...overrides,
	};
}

test("local STT session reports idle stop, missing ffmpeg, and honors XDG_RUNTIME_DIR", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-stt-errors-"));
	{
		try {
			const runtime = path.join(root, "runtime");
			fs.mkdirSync(runtime);
			const env = baseEnv({ XDG_RUNTIME_DIR: runtime });

			const ticket = await runScript(path.join(CLIENT_DIR, "pi-voice-stt-session"), [], "ticket\n", env);
			assert.match(ticket.stdout, /^ticket [0-9a-f]{32}\.1 [0-9a-f-]{36}\n$/);
			assert.equal(ticket.stdout.trim().split(" ")[2], MIC_BOOT);
			const stopped = await runScript(path.join(CLIENT_DIR, "pi-voice-stt-session"), [], `stop ${ticket.stdout.split(" ")[1]}\n`, env);
			assert.equal(stopped.code, 0);
			assert.match(stopped.stdout, /^ok /);
			assert.equal(decodeMessage(stopped.stdout.trim()).message, `stopped ${ticket.stdout.split(" ")[1]}`);

			const badCommand = await runScript(path.join(CLIENT_DIR, "pi-voice-stt-session"), [], "dance\n", env);
			assert.equal(badCommand.code, 1);
			assert.match(decodeMessage(badCommand.stdout.trim()).message, /Unsupported local voice command/);

			const bin = restrictedPath(path.join(root, "missing"), {});
			const missingFfmpeg = await runScript(
				path.join(CLIENT_DIR, "pi-voice-stt-session"),
				[],
				"record\n",
				baseEnv({ XDG_RUNTIME_DIR: runtime, PATH: bin }),
			);
			assert.equal(missingFfmpeg.code, 1);
			assert.match(decodeMessage(missingFfmpeg.stdout.trim()).message, /ffmpeg is required/);

			assert.ok(fs.existsSync(path.join(runtime, `pi-voice-client-${process.getuid!()}`)), "state dir must live under XDG_RUNTIME_DIR");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
});

test("microphone sessions reject a second concurrent recorder", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-stt-lock-"));
	const owner = spawn("bash", ["-c", "exec -a pi-voice-stt-session sleep 30"], { env: baseEnv({ TMPDIR: root }), stdio: "ignore" });
	try {
		await new Promise(resolve => setTimeout(resolve, 30));
		const linuxRuntime = path.join(root, "linux-runtime");
		const linuxState = path.join(linuxRuntime, "state/pi-voice/microphone-desktop");
		fs.mkdirSync(linuxState, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(linuxState, "tickets"), `${MIC_BOOT} ${MIC_EPOCH} 1 0 1 ${MIC_EPOCH} admitted\n`);
		const linuxBin = restrictedPath(path.join(root, "linux-tools"), {
			ffmpeg: "exit 0",
			"pw-record": "exit 0",
			wpctl: "exit 0",
		});
		const linux = await runScript(
			path.join(CLIENT_DIR, "pi-voice-stt-session"),
			[],
			"record\n",
			baseEnv({ XDG_RUNTIME_DIR: linuxRuntime, PATH: linuxBin }),
			8_000,
			root,
		);
		assert.match(decodeMessage(linux.stdout.trim()).message, /unresolved recording/);
		assert.match(fs.readFileSync(path.join(linuxState, "tickets"), "utf8"), / 1 0123456789abcdef0123456789abcdef admitted\n$/);

		const termuxRuntime = path.join(root, "termux-runtime");
		const termuxState = path.join(termuxRuntime, "state/pi-voice/microphone/termux");
		fs.mkdirSync(path.join(termuxState, "recording"), { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(termuxState, "active"), `${MIC_EPOCH}.1:${owner.pid}\n`);
		fs.writeFileSync(path.join(termuxState, "recording.tickets"), `${MIC_EPOCH} 1 0 ${MIC_BOOT} ${MIC_EPOCH}.1:${owner.pid}\n`);
		const termuxBin = restrictedPath(path.join(root, "termux-tools"), {
			"termux-microphone-record": "exit 0",
		});
		const termux = await runScript(
			path.resolve("termux/pi-voice-stt-session"),
			[],
			"record\n",
			baseEnv({ TMPDIR: termuxRuntime, PATH: termuxBin }),
			8_000,
			root,
		);
		assert.match(decodeMessage(termux.stdout.trim()).message, /already recording/);
		const installedTermux = await runScript(
			path.join(CLIENT_DIR, "pi-voice-termux-stt-session"),
			[],
			"record\n",
			baseEnv({ TMPDIR: termuxRuntime, PATH: termuxBin }),
			8_000,
			root,
		);
		assert.match(decodeMessage(installedTermux.stdout.trim()).message, /already recording/);
	} finally {
		owner.kill("SIGKILL");
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("local STT session records through PipeWire, forwards audio, and stops cleanly", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-stt-record-"));
	try {
		const runtime = path.join(root, "runtime");
		fs.mkdirSync(runtime);
		const pcm = path.join(root, "input.pcm");
		fs.writeFileSync(pcm, Buffer.alloc(4096, 7));
		const bin = restrictedPath(root, {
			wpctl: `exit 0`,
			pactl: `exit 1`,
			"pw-record": `cat "${pcm}"`,
			ffmpeg: `cat`,
		});
		const result = await runScript(
			path.join(CLIENT_DIR, "pi-voice-stt-session"),
			["record"],
			"record\n",
			baseEnv({ XDG_RUNTIME_DIR: runtime, PATH: bin, PI_VOICE_MAX_RECORD_SECONDS: "1" }),
			8_000,
			root,
		);

		assert.equal(result.timedOut, false, `script hung; stderr: ${result.stderr}`);
		assert.match(result.stdout, /^ticket [0-9a-f]{32}\.1 [0-9a-f-]{36}\nstream\n/s, "the ticket and Ogg stream header must arrive before audio");
		const [, audio = ""] = result.stdout.split("stream\n");
		assert.ok(audio.length > 0, "recorded audio must be forwarded after the header");
		assert.match(fs.readFileSync(path.join(runtime, "state/pi-voice/microphone-desktop/tickets"), "utf8"), / 0 - idle\n$/, "owned children must retire before durable ownership is cleared");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("stop cannot acknowledge until the active recording generation is durably retired", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-stt-stop-"));
	try {
		const runtime = path.join(root, "runtime");
		fs.mkdirSync(runtime);
		const stateDir = path.join(runtime, "state/pi-voice/microphone-desktop");
		fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(stateDir, "tickets"), `${MIC_BOOT} ${MIC_EPOCH} 1 0 1 ${MIC_EPOCH} admitted\n`);

		let acknowledged = false;
		const pending = runScript(path.join(CLIENT_DIR, "pi-voice-stt-session"), [], `stop ${MIC_EPOCH}.1\n`, baseEnv({ XDG_RUNTIME_DIR: runtime })).then(result => { acknowledged = true; return result; });
		await new Promise(resolve => setTimeout(resolve, 200));
		assert.equal(acknowledged, false);
		// Simulate the owner's atomic durable retirement, not mere PID/marker loss.
		fs.writeFileSync(path.join(stateDir, "tickets.tmp"), `${MIC_BOOT} ${MIC_EPOCH} 1 1 0 - idle\n`);
		fs.renameSync(path.join(stateDir, "tickets.tmp"), path.join(stateDir, "tickets"));
		const stopped = await pending;
		assert.equal(stopped.code, 0);
		assert.match(stopped.stdout, /^ok /);
		assert.equal(decodeMessage(stopped.stdout.trim()).message, `stopped ${MIC_EPOCH}.1`);
		assert.ok(fs.existsSync(path.join(stateDir, "stop-recording")), "the stop flag must be created");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("dispatcher prefers the Termux backend when Termux is detected", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-stt-dispatch-"));
	try {
		// Copy both scripts so SCRIPT_DIR resolution stays inside the sandbox.
		for (const name of ["pi-voice-stt-session", "pi-voice-termux-stt-session"]) {
			fs.copyFileSync(path.join(CLIENT_DIR, name), path.join(root, name));
		}
		const runtime = path.join(root, "runtime");
		fs.mkdirSync(runtime);
		const bin = restrictedPath(root, {
			"termux-microphone-record": `
if [[ "$1" == "-i" ]]; then printf '{"isRecording":false}'; exit 0; fi
if [[ "$1" == "-q" ]]; then
  [[ -f "${root}/producer.pid" ]] && kill "$(cat "${root}/producer.pid")" 2>/dev/null || true
  rm -f "${root}/producer.pid"
  printf 'Recording finished: %s\\n' "$(cat "${root}/recording-path")"
  exit 0
fi
file=
prev=
for arg in "$@"; do
  [[ $prev == "-f" ]] && file=$arg
  prev=$arg
done
printf '%s' "$file" > "${root}/recording-path"
( while :; do printf 'x' >> "$file"; sleep 0.05; done ) </dev/null >/dev/null 2>&1 &
echo $! > "${root}/producer.pid"
sleep 0.4
printf 'Recording started: %s\nMax Duration: 00:02:00\n' "$file"
exit 0`,
		});
		// A com.termux PREFIX forces the Termux branch regardless of host tools.
		const result = await runScript(
			path.join(root, "pi-voice-stt-session"),
			["record"],
			"record\n",
			baseEnv({
				PATH: bin,
				PREFIX: path.join(root, "com.termux"),
				TMPDIR: runtime,
				PI_VOICE_MAX_RECORD_SECONDS: "1",
			}),
			8_000,
			root,
		);

		assert.equal(result.timedOut, false, `termux dispatch hung; stderr: ${result.stderr}`);
		assert.match(result.stdout, /^ticket [0-9a-f]{32}\.1 [0-9a-f-]{36}\nstream\n/s);
		assert.ok(fs.existsSync(path.join(runtime, "state/pi-voice/microphone/termux/active")) === false, "termux active marker must be cleaned up");
		assert.ok(!fs.existsSync(path.join(runtime, `pi-voice-client-${process.getuid!()}`)), "the Linux state dir must not be created");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("Termux STT session validates commands, streams the recording, and stops", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-termux-stt-"));
	try {
		const runtime = path.join(root, "runtime");
		fs.mkdirSync(runtime);
		const script = path.join(CLIENT_DIR, "pi-voice-termux-stt-session");
		const env = baseEnv({ TMPDIR: runtime });

		const ticket = await runScript(script, [], "ticket\n", env);
		assert.match(ticket.stdout, /^ticket [0-9a-f]{32}\.1 [0-9a-f-]{36}\n$/);
		assert.equal(ticket.stdout.trim().split(" ")[2], MIC_BOOT);
		const idleStop = await runScript(script, [], `stop ${ticket.stdout.split(" ")[1]}\n`, env);
		assert.equal(idleStop.code, 0);
		assert.equal(decodeMessage(idleStop.stdout.trim()).message, `stopped ${ticket.stdout.split(" ")[1]}`);

		const unsupported = await runScript(script, [], "rewind\n", env);
		assert.match(decodeMessage(unsupported.stdout.trim()).message, /Unsupported phone voice command/);

		const missingTool = await runScript(
			script,
			["record"],
			"record\n",
			baseEnv({ TMPDIR: runtime, PATH: restrictedPath(root, {}) }),
		);
		assert.match(decodeMessage(missingTool.stdout.trim()).message, /termux-microphone-record is unavailable/);

		const bin = restrictedPath(root, {
			"termux-microphone-record": `
if [[ "$1" == "-i" ]]; then printf '{"isRecording":false}'; exit 0; fi
if [[ "$1" == "-q" ]]; then
  [[ -f "${root}/producer.pid" ]] && kill "$(cat "${root}/producer.pid")" 2>/dev/null || true
  rm -f "${root}/producer.pid"
  printf 'Recording finished: %s\\n' "$(cat "${root}/recording-path")"
  exit 0
fi
file=
prev=
for arg in "$@"; do
  [[ $prev == "-f" ]] && file=$arg
  prev=$arg
done
printf '%s' "$file" > "${root}/recording-path"
( while :; do printf 'x' >> "$file"; sleep 0.05; done ) </dev/null >/dev/null 2>&1 &
echo $! > "${root}/producer.pid"
sleep 0.3
printf 'Recording started: %s\nMax Duration: 00:02:00\n' "$file"
exit 0`,
		});
		const recorded = await runScript(
			script,
			["record"],
			"record\n",
			baseEnv({ TMPDIR: runtime, PATH: bin, PI_VOICE_MAX_RECORD_SECONDS: "1" }),
			8_000,
			root,
		);
		assert.equal(recorded.timedOut, false, `termux recording hung; stderr: ${recorded.stderr}`);
		assert.match(recorded.stdout, /^ticket [0-9a-f]{32}\.3 [0-9a-f-]{36}\nstream\n/s);
		const [, audio = ""] = recorded.stdout.split("stream\n");
		assert.ok(audio.length > 0, "followed recording bytes must be forwarded");
		assert.equal(fs.existsSync(path.join(runtime, "state/pi-voice/microphone/termux/active")), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/** Starts a listening Unix socket at a path so `[[ -S ]]` checks pass. */
function listenUnix(socketPath: string, onLine?: (line: string) => void): Promise<net.Server> {
	return new Promise(resolve => {
		const server = net.createServer(socket => {
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString("utf8");
				for (const line of buffer.split("\n").slice(0, -1)) onLine?.(line);
				buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
			});
		});
		server.unref();
		server.listen(socketPath, () => resolve(server));
	});
}

test("playback session announces itself and reports player positions", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-audio-play-"));
	let server: net.Server | undefined;
	try {
		const runtime = path.join(root, "runtime");
		fs.mkdirSync(runtime);
		const ipcPath = path.join(runtime, "player.sock");
		const requests: string[] = [];
		server = await listenUnix(ipcPath, line => requests.push(line));

		const bin = restrictedPath(root, {
			mpv: `
ipc=
for arg in "$@"; do
  case $arg in
    --input-ipc-server=*) ipc=\${arg#--input-ipc-server=} ;;
  esac
done
exec node - "$ipc" "$MPV_LIFETIME" <<'JS'
const fs = require('fs');
${nativeBinding}
const s = require('net').createServer();
s.listen(process.argv[2]);
setTimeout(() => process.exit(0), Number(process.argv[3]));
JS`,
			socat: `cat >> "${root}/socat.log"; printf '{"data":1.25,"request_id":1}\\n'`,
		});

		const { spawn } = await import("node:child_process");
		const child = spawn("bash", [path.join(CLIENT_DIR, "pi-voice-audio-session")], {
			cwd: root,
			env: {
				...baseEnv({ XDG_RUNTIME_DIR: runtime }),
				HOME: root,
				XDG_STATE_HOME: path.join(root, "state"),
				XDG_RUNTIME_DIR: runtime,
				PATH: bin,
				MPV_LIFETIME: "500",
			},
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		child.stdin.write("PI_VOICE_CONTROLhello\nPI_VOICE_PREPARE 4\n");
		let stdout = "";
		let committed = false;
		child.stdin.on("error", () => {});
		child.stdout.on("data", chunk => {
			stdout += chunk.toString("utf8");
			const prepared = stdout.split("\n").find(line => line.includes('"type":"prepared"'));
			if (prepared && !committed) {
				const scope = JSON.parse(prepared);
				committed = true;
				child.stdin.write(`PI_VOICE_COMMIT ${scope.id} ${scope.boot_id}\n`);
			}
		});
		let stderr = "";
		child.stderr.on("data", chunk => {
			stderr += chunk.toString("utf8");
		});

		await new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 6_000;
			const poll = (): void => {
				if (stdout.includes('"type":"session"') && stdout.includes('"type":"playback"')) return resolve();
				if (Date.now() > deadline) {
					reject(new Error(`playback feedback missing. stdout=${stdout} stderr=${stderr}`));
					return;
				}
				setTimeout(poll, 50);
			};
			poll();
		});

		assert.match(stdout, /"type":"session","version":4,"id":"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"/);
		assert.match(stdout, /"type":"playback","position":1\.25/);
		const socatLog = fs.readFileSync(path.join(root, "socat.log"), "utf8");
		assert.match(socatLog, /get_property.*time-pos/);

		try {
			process.kill(-child.pid!, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
		child.stdin?.destroy();
		child.stdout?.destroy();
		child.stderr?.destroy();
	} finally {
		server?.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("control connections forward pause, resume, and stop to the targeted player", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-audio-control-"));
	const runtime = path.join(root, "runtime");
	fs.mkdirSync(runtime);
	const targetPath = path.join(runtime, "pi-voice-mpv-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.sock");
	const received: string[] = [];
	let targetServer: net.Server | undefined;
	try {
		targetServer = await listenUnix(targetPath, line => received.push(line));

		const bin = restrictedPath(root, {
			socat: `{ printf 'ARGS %s\n' "$*"; cat; } >> "${root}/socat.log"`,
		});

		const result = await runScript(
			path.join(CLIENT_DIR, "pi-voice-audio-session"),
			[],
			"PI_VOICE_CONTROLpause aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n",
			baseEnv({ XDG_RUNTIME_DIR: runtime, PATH: bin }),
			8_000,
			root,
		);
		assert.equal(result.code, 0, `control session failed: ${result.stderr}`);
		const log = fs.readFileSync(path.join(root, "socat.log"), "utf8");
		assert.match(log, /"set_property","pause",true/);
		assert.match(log, new RegExp(`UNIX-CONNECT:${targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

		const stopped = await runScript(
			path.join(CLIENT_DIR, "pi-voice-audio-session"),
			[],
			"PI_VOICE_CONTROLstop aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n",
			baseEnv({ XDG_RUNTIME_DIR: runtime, PATH: bin }),
			8_000,
			root,
		);
		assert.equal(stopped.code, 0, `stop control failed: ${stopped.stderr}`);
		const stoppedLog = fs.readFileSync(path.join(root, "socat.log"), "utf8");
		assert.match(stoppedLog, /"command":\["quit"\]/);
	} finally {
		targetServer?.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("raw PCM is rejected before attempting player startup", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-audio-nompv-"));
	try {
		const runtime = path.join(root, "runtime");
		fs.mkdirSync(runtime);
		const bin = restrictedPath(root, {});
		const result = await runScript(
			path.join(CLIENT_DIR, "pi-voice-audio-session"),
			[],
			Buffer.alloc(32, 1).toString("binary"),
			baseEnv({ XDG_RUNTIME_DIR: runtime, PATH: bin }),
			8_000,
			root,
		);
		assert.notEqual(result.code, 0, "unnegotiated PCM must fail closed");
		assert.match(result.stdout, /"type":"error"/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});


test("client bridge terminates on TERM instead of restarting its listeners", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-bridge-term-"));
	const tools = restrictedPath(root, {
		mpv: "exit 1", ffmpeg: "exit 1",
		socat: 'echo "$$" >> "$HOME/listeners"; exec sleep 30',
	});
	const child = spawn("bash", [path.join(CLIENT_DIR, "pi-voice-client")], {
		env: { ...baseEnv({ TMPDIR: root }), HOME: root, PATH: tools }, detached: true, stdio: "ignore",
	});
	const closed = new Promise(resolve => child.once("close", resolve));
	t.after(() => {
		try { process.kill(-child.pid!, "SIGKILL"); } catch {}
		fs.rmSync(root, { recursive: true, force: true });
	});
	for (let i = 0; i < 100; i++) {
		if (fs.existsSync(path.join(root, "listeners")) && fs.readFileSync(path.join(root, "listeners"), "utf8").trim().split("\n").length === 2) break;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	const listeners = fs.readFileSync(path.join(root, "listeners"), "utf8").trim().split("\n");
	assert.equal(listeners.length, 2);
	child.kill("SIGTERM");
	let timer: ReturnType<typeof setTimeout>;
	try {
		assert.equal(await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve("timeout"), 2000); })]), 0);
	} finally { clearTimeout(timer!); }
	for (const pid of listeners) assert.throws(() => process.kill(Number(pid), 0), /ESRCH/);
});
