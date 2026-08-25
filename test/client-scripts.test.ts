import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const CLIENT_DIR = path.resolve("client");

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
			env: { ...process.env, ...env },
			cwd,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdin.end(input);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", chunk => {
			stdout += chunk.toString("utf8");
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
	const parts = line.trim().split(" ", 2);
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
	"bash", "sh", "basename", "cat", "cmp", "dd", "dirname", "env", "head", "id", "kill",
	"mkdir", "mkfifo", "printf", "readlink", "rm", "sh", "sleep", "stat", "tail", "timeout", "touch", "tr", "base64", "setsid", "ps",
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

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		XDG_RUNTIME_DIR: "",
		TMPDIR: "",
		PI_VOICE_MAX_RECORD_SECONDS: "2",
		...overrides,
	};
}

test("local STT session reports stop errors, missing ffmpeg, and honors XDG_RUNTIME_DIR", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-stt-errors-"));
	{
		try {
			const runtime = path.join(root, "runtime");
			fs.mkdirSync(runtime);
			const env = baseEnv({ XDG_RUNTIME_DIR: runtime });

			const stopped = await runScript(path.join(CLIENT_DIR, "pi-voice-stt-session"), [], "stop\n", env);
			assert.equal(stopped.code, 0);
			assert.match(stopped.stdout, /^error /);
			assert.match(decodeMessage(stopped.stdout.trim()).message, /not recording/);

			const badCommand = await runScript(path.join(CLIENT_DIR, "pi-voice-stt-session"), [], "dance\n", env);
			assert.equal(badCommand.code, 0);
			assert.match(decodeMessage(badCommand.stdout.trim()).message, /Unsupported local voice command/);

			const bin = restrictedPath(`${root}-missing`, {});
			const missingFfmpeg = await runScript(
				path.join(CLIENT_DIR, "pi-voice-stt-session"),
				[],
				"record\n",
				baseEnv({ XDG_RUNTIME_DIR: runtime, PATH: bin }),
			);
			assert.equal(missingFfmpeg.code, 0);
			assert.match(decodeMessage(missingFfmpeg.stdout.trim()).message, /ffmpeg is required/);

			assert.ok(fs.existsSync(path.join(runtime, `pi-voice-client-${process.getuid!()}`)), "state dir must live under XDG_RUNTIME_DIR");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
});

test("microphone sessions reject a second concurrent recorder", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-stt-lock-"));
	const owner = spawn("bash", ["-c", "exec -a pi-voice-stt-session sleep 30"], { stdio: "ignore" });
	try {
		await new Promise(resolve => setTimeout(resolve, 30));
		const linuxRuntime = path.join(root, "linux-runtime");
		const linuxState = path.join(linuxRuntime, `pi-voice-client-${process.getuid!()}`);
		fs.mkdirSync(path.join(linuxState, "recording-lock"), { recursive: true });
		fs.writeFileSync(path.join(linuxState, "recording-active"), `${owner.pid}\n`);
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
		assert.match(decodeMessage(linux.stdout.trim()).message, /already recording/);

		const termuxRuntime = path.join(root, "termux-runtime");
		fs.mkdirSync(path.join(termuxRuntime, "pi-voice-recording-lock"), { recursive: true });
		fs.writeFileSync(path.join(termuxRuntime, "pi-voice-recording-active"), `${owner.pid}\n`);
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
		const uid = process.getuid!();
		const bin = restrictedPath(root, {
			wpctl: `exit 0`,
			pactl: `exit 1`,
			"pw-record": `cat "${pcm}"`,
			ffmpeg: `cat`,
		});
		const stateDir = path.join(runtime, `pi-voice-client-${uid}`);
		const result = await runScript(
			path.join(CLIENT_DIR, "pi-voice-stt-session"),
			["record"],
			"record\n",
			baseEnv({ XDG_RUNTIME_DIR: runtime, PATH: bin, PI_VOICE_MAX_RECORD_SECONDS: "1" }),
			8_000,
			root,
		);

		assert.equal(result.timedOut, false, `script hung; stderr: ${result.stderr}`);
				assert.match(result.stdout, /^stream\n/s, "the Ogg stream header must arrive before audio");
		const [, audio = ""] = result.stdout.split("stream\n");
		assert.ok(audio.length > 0, "recorded audio must be forwarded after the header");
		assert.equal(fs.existsSync(path.join(stateDir, "recording-active")), false, "active marker must be cleaned up");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("stop terminates an active local recording", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-stt-stop-"));
	try {
		const runtime = path.join(root, "runtime");
		fs.mkdirSync(runtime);
		const uid = process.getuid!();
		const stateDir = path.join(runtime, `pi-voice-client-${uid}`);
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "recording-active"), `${process.pid}\n`);

		const stopped = await runScript(path.join(CLIENT_DIR, "pi-voice-stt-session"), [], "stop\n", baseEnv({ XDG_RUNTIME_DIR: runtime }));
		assert.equal(stopped.code, 0);
		assert.match(stopped.stdout, /^ok /);
		assert.equal(decodeMessage(stopped.stdout.trim()).message, "stopping");
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
		const recording = path.join(root, "recording.ogg");
		const bin = restrictedPath(root, {
			"termux-microphone-record": `
if [[ "$1" == "-q" ]]; then
  [[ -f "${root}/producer.pid" ]] && kill "$(cat "${root}/producer.pid")" 2>/dev/null || true
  rm -f "${root}/producer.pid"
  exit 0
fi
file=
prev=
for arg in "$@"; do
  [[ $prev == "-f" ]] && file=$arg
  prev=$arg
done
( while :; do printf 'x' >> "$file"; sleep 0.05; done ) &
echo $! > "${root}/producer.pid"
sleep 0.4
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
		assert.match(result.stdout, /^stream\n/s);
		assert.ok(fs.existsSync(path.join(runtime, "pi-voice-recording-active")) === false, "termux active marker must be cleaned up");
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

		const idleStop = await runScript(script, [], "stop\n", env);
		assert.equal(idleStop.code, 0);
		assert.match(decodeMessage(idleStop.stdout.trim()).message, /not recording/);

		const unsupported = await runScript(script, [], "rewind\n", env);
		assert.match(decodeMessage(unsupported.stdout.trim()).message, /Unsupported phone voice command/);

		const missingTool = await runScript(
			script,
			["record"],
			"record\n",
			baseEnv({ TMPDIR: runtime, PATH: restrictedPath(root, {}) }),
		);
		assert.match(decodeMessage(missingTool.stdout.trim()).message, /termux-microphone-record is unavailable/);

		const recording = path.join(root, "call.ogg");
		const bin = restrictedPath(root, {
			"termux-microphone-record": `
if [[ "$1" == "-q" ]]; then
  [[ -f "${root}/producer.pid" ]] && kill "$(cat "${root}/producer.pid")" 2>/dev/null || true
  rm -f "${root}/producer.pid"
  exit 0
fi
file=
prev=
for arg in "$@"; do
  [[ $prev == "-f" ]] && file=$arg
  prev=$arg
done
( while :; do printf 'x' >> "$file"; sleep 0.05; done ) &
echo $! > "${root}/producer.pid"
sleep 0.3
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
		assert.match(recorded.stdout, /^stream\n/s);
		const [, audio = ""] = recorded.stdout.split("stream\n");
		assert.ok(audio.length > 0, "followed recording bytes must be forwarded");
		assert.equal(fs.existsSync(path.join(runtime, "pi-voice-recording-active")), false);
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
node -e 'const n=require("net");const s=n.createServer();s.listen(process.argv[1]);setTimeout(()=>process.exit(0),Number(process.argv[2]))' "$ipc" "$MPV_LIFETIME" >/dev/null 2>&1 &
wait $!`,
			socat: `cat >> "${root}/socat.log"; printf '{"data":1.25,"request_id":1}\\n'`,
		});

		const { spawn } = await import("node:child_process");
		const child = spawn("bash", [path.join(CLIENT_DIR, "pi-voice-audio-session")], {
			cwd: root,
			env: {
				...process.env,
				XDG_RUNTIME_DIR: runtime,
				PATH: bin,
				MPV_LIFETIME: "500",
			},
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		child.stdin.write(Buffer.alloc(64, 3));
		let stdout = "";
		child.stdout.on("data", chunk => {
			stdout += chunk.toString("utf8");
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

		assert.match(stdout, /"type":"session","id":"\d+"/);
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
	const targetPath = path.join(runtime, "pi-voice-mpv-4242.sock");
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
			"PI_VOICE_CONTROLpause 4242\n",
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
			"PI_VOICE_CONTROLstop 4242\n",
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

test("playback session exits with an error when mpv is unavailable", async () => {
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
		assert.notEqual(result.code, 0, "a missing player must fail loudly");
		assert.equal(result.stdout, "");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
