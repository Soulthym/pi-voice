import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const CLIENT_WRAPPER = path.resolve("client/pi-voice-ssh");
const TERMUX_WRAPPER = path.resolve("termux/pi-voice-ssh");

/** Tools the wrappers legitimately need; audio/SSH tooling is faked explicitly. */
const CORE_TOOLS = [
	"awk", "basename", "bash", "cat", "chmod", "cmp", "cut", "date", "dd", "dirname", "env", "head", "id", "kill",
	"mkdir", "mkfifo", "rmdir", "printf", "readlink", "rm", "sh", "sha256sum", "sleep", "sort", "stat", "tail", "touch",
	"tr", "base64", "setsid", "timeout", "uname",
];

function restrictedPath(root: string, fakes: Record<string, string>): string {
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin, { recursive: true });
	for (const [name, body] of Object.entries(fakes)) {
		const file = path.join(bin, name);
		fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
		fs.chmodSync(file, 0o755);
	}
	const core = path.join(root, "core");
	fs.mkdirSync(core, { recursive: true });
	for (const tool of [...CORE_TOOLS]) {
		try {
			fs.symlinkSync(`/usr/bin/${tool}`, path.join(core, tool));
		} catch {
			// Already linked.
		}
	}
	try {
		fs.symlinkSync(process.execPath, path.join(core, "node"));
	} catch {
		// Already linked.
	}
	return `${bin}:${core}`;
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runScript(script: string, args: string[], env: Record<string, string>, timeoutMs = 15_000): Promise<RunResult> {
	return new Promise(resolve => {
		const child = spawn("bash", [script, ...args], {
			env: { ...process.env, ...env },
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", chunk => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", chunk => {
			stderr += chunk.toString("utf8");
		});
		const timer = setTimeout(() => {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, timeoutMs);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({
				code: signal ? null : code,
				stdout,
				stderr: signal ? `${stderr}\nkilled by ${signal}` : stderr,
			});
		});
	});
}

/**
 * A scripted ssh that walks the wrapper through its full lifecycle without a
 * network: -G answers config queries, -O check reports no master, master start
 * succeeds, remote commands are recorded, and every argv line lands in a log.
 */
const FAKE_SSH = `
log=$FAKE_SSH_LOG
printf '%s\\0' "$*" >>"$log"
case $* in
  *" -O check"*)
    exit 255
    ;;
esac
case $1 in
  -G)
    printf 'hostname fakehost\\nuser fakeuser\\nport 22\\n'
    ;;
  *)
    # The interactive session stays open briefly so a concurrent wrapper can
    # observe bridge reuse while this one is still alive.
    if [[ $* == *" -t "* ]]; then
      sleep 2
      exit 0
    fi
    if [[ $* == *"printf %s"* ]]; then
      printf '/home/remote'
    fi
    # Consume piped registrations without touching the network.
    cat >/dev/null 2>&1 || true
    ;;
esac
exit 0`;

async function scenario(
	root: string,
	wrapper: string,
	args: string[],
	envOverrides: Record<string, string> = {},
): Promise<RunResult & { log(): string }> {
	const bin = restrictedPath(root, { ssh: FAKE_SSH });
	const runtime = path.join(root, "runtime");
	fs.mkdirSync(runtime, { recursive: true });
	const logFile = path.join(root, "ssh.log");
	// The wrapper supervises a shared client bridge; a sleeping fake stands in.
	const bridge = path.join(root, "fake-pi-voice-client");
	fs.writeFileSync(
		bridge,
		"#!/usr/bin/env bash\nexec node -e 'const n=require(\"net\");const s=n.createServer(c=>c.end());s.listen(Number(process.env.PI_VOICE_AUDIO_PORT)||8765,\"127.0.0.1\")'",
	);
	fs.chmodSync(bridge, 0o755);
	const result = await runScript(wrapper, args, {
		XDG_RUNTIME_DIR: runtime,
		PATH: bin,
		HOME: root,
		PI_VOICE_DEVICE_NAME: "testdev",
		PI_VOICE_CLIENT_COMMAND: bridge,
		FAKE_SSH_LOG: logFile,
		...envOverrides,
	});
	return {
		...result,
		log: () => fs.readFileSync(logFile, "utf8").replaceAll("\0", "\n"),
	};
}

test("dry run resolves device-dir precedence and rejects invalid values", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-ssh-dry-"));
	try {
		const dry = (wrapper: string, args: string[], extra: Record<string, string> = {}) =>
			runScript(wrapper, args, {
				PI_VOICE_SSH_DRY_RUN: "1",
				XDG_RUNTIME_DIR: path.join(root, "rt"),
				HOME: root,
				PI_VOICE_DEVICE_NAME: "testdev",
				...extra,
			});

		const clientDefault = await dry(CLIENT_WRAPPER, ["u@h"]);
		assert.match(clientDefault.stdout, /deviceDir=default/);

		const flag = await dry(CLIENT_WRAPPER, ["--device-dir", "/srv/pv", "u@h"]);
		assert.match(flag.stdout, /deviceDir=\/srv\/pv/);

		const eqForm = await dry(CLIENT_WRAPPER, ["--device-dir=/srv/eq", "u@h"]);
		assert.match(eqForm.stdout, /deviceDir=\/srv\/eq/);

		const envFallback = await dry(CLIENT_WRAPPER, ["u@h"], { PI_VOICE_DEVICE_DIR: "/from/env" });
		assert.match(envFallback.stdout, /deviceDir=\/from\/env/);

		const flagWins = await dry(CLIENT_WRAPPER, ["--device-dir", "/wins", "u@h"], { PI_VOICE_DEVICE_DIR: "/from/env" });
		assert.match(flagWins.stdout, /deviceDir=\/wins/);

		const relative = await dry(CLIENT_WRAPPER, ["--device-dir", "rel/path", "u@h"]);
		assert.equal(relative.code, 2);
		assert.match(relative.stderr, /must be absolute/);

		const tilde = await dry(TERMUX_WRAPPER, ["--device-dir", "~/pv", "u@t"], { PREFIX: "/data/data/com.termux/files/usr" });
		assert.equal(tilde.code, 2);

		const missingValue = await dry(CLIENT_WRAPPER, ["--device-dir"]);
		assert.equal(missingValue.code, 2);
		assert.match(missingValue.stderr, /requires an absolute remote path/);

		const termuxFlag = await dry(
			TERMUX_WRAPPER,
			["--device-dir=/sd/pi", "u@t"],
			{ PREFIX: "/data/data/com.termux/files/usr" },
		);
		assert.match(termuxFlag.stdout, /platform=termux/);
		assert.match(termuxFlag.stdout, /deviceDir=\/sd\/pi/);

		const optionsPreserved = await dry(CLIENT_WRAPPER, ["-p", "2222", "u@h", "echo", "hi"]);
		assert.match(optionsPreserved.stdout, /deviceDir=default/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("stale bridge pid files are replaced; live bridges are reused", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-ssh-bridge-"));
	const runtime = path.join(root, "runtime");
	fs.mkdirSync(runtime, { recursive: true });
	const bin = restrictedPath(root, { ssh: FAKE_SSH });
	const audioPort = 20000 + (process.pid % 20000);
	const env = {
		XDG_RUNTIME_DIR: runtime,
		PATH: bin,
		HOME: root,
		PI_VOICE_DEVICE_NAME: "t",
		FAKE_SSH_LOG: path.join(root, "ssh.log"),
	};

	const bridgePath = path.join(root, "counting-bridge");
	fs.writeFileSync(
		bridgePath,
		"#!/usr/bin/env bash\necho started >> " + JSON.stringify(path.join(root, "bridge-starts.log")) +
			"\nexec node -e 'const n=require(\"net\");const s=n.createServer(c=>c.end());s.listen(Number(process.env.PI_VOICE_AUDIO_PORT)||8765,\"127.0.0.1\")'",
	);
	fs.chmodSync(bridgePath, 0o755);

	// A stale pid file pointing at an unrelated live process must not satisfy
	// the liveness probe.
	const stalePidFile = path.join(runtime, `pi-voice-ssh-${process.getuid!()!}`, "client-bridge.pid");
	fs.mkdirSync(path.dirname(stalePidFile), { recursive: true });
	fs.writeFileSync(stalePidFile, `${process.pid}\n`);

	const startsLog = () => (fs.existsSync(path.join(root, "bridge-starts.log"))
		? fs.readFileSync(path.join(root, "bridge-starts.log"), "utf8").split("\n").filter(Boolean).length
		: 0);

	const { spawn } = await import("node:child_process");
	const background = spawn("bash", [CLIENT_WRAPPER, "--device-dir", "/srv/d", "u@h"], {
		env: { ...process.env, ...env, PI_VOICE_CLIENT_COMMAND: bridgePath, PI_VOICE_AUDIO_PORT: String(audioPort) },
		detached: true,
		stdio: "ignore",
	});
	try {
		const deadline = Date.now() + 8_000;
		while (startsLog() < 1 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
		assert.ok(startsLog() >= 1, "a dead bridge must be restarted");
		// Wait until the first session finished its locked setup so the second
		// runner does not spin behind the target lock.
		while (Date.now() < deadline) {
			const targetsDir = path.join(runtime, `pi-voice-ssh-${process.getuid!()}`, "targets");
			const locks = fs.existsSync(targetsDir) ? (fs.readdirSync(targetsDir, { recursive: true }) as string[]).filter(e => e.endsWith("lock")) : [];
			if (locks.length === 0) break;
			await new Promise(r => setTimeout(r, 50));
		}

		// While that bridge is alive, another wrapper session must reuse it.
		const second = await runScript(CLIENT_WRAPPER, ["--device-dir", "/srv/d", "u@h"], {
			...env,
			PI_VOICE_CLIENT_COMMAND: bridgePath,
			PI_VOICE_AUDIO_PORT: String(audioPort),
		});
		assert.equal(second.code, 0, `run2 stderr: ${second.stderr}`);
		assert.equal(startsLog(), 1, "a live bridge must not be restarted");
	} finally {
		try {
			process.kill(-background.pid!, "SIGKILL");
		} catch {
			background.kill("SIGKILL");
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("managed sessions register inside the override and export it remotely", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-ssh-live-"));
	try {
		const overrideDir = "/srv/custom-devices";
		const result = await scenario(root, CLIENT_WRAPPER, ["--device-dir", overrideDir, "u@h"]);
		assert.equal(result.code, 0, `wrapper failed: ${result.stderr}`);
		const log = result.log();

		// Registration directory, sockets, and registration file live under the override.
		assert.ok(log.includes(`mkdir -p '${overrideDir}'`), `mkdir missing:\n${log}`);
		assert.match(log, new RegExp(`-R ${overrideDir}/[a-z0-9._-]+\\.audio\\.sock:`));
		assert.match(log, new RegExp(`-R ${overrideDir}/[a-z0-9._-]+\\.input\\.sock:`));

		// The final interactive environment exports the override for remote Pi.
		const finalLine = log.split("\n").find(line => line.includes("-t u@h env PI_VOICE_DEVICE_ID="));
		assert.ok(finalLine, `interactive env command missing:\n${log}`);
		assert.match(finalLine, new RegExp(`PI_VOICE_DEVICE_DIR='${overrideDir}'`));
		assert.doesNotMatch(log, new RegExp(`'${"/home/remote"}/\\.cache/pi-voice/devices'`));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("without an override the managed session keeps the historical default", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-ssh-default-"));
	try {
		const result = await scenario(root, CLIENT_WRAPPER, ["u@h"]);
		assert.equal(result.code, 0, `wrapper failed: ${result.stderr}`);
		const log = result.log();
		assert.ok(log.includes("'/home/remote/.cache/pi-voice/devices'"), `default dir missing:\n${log}`);
		assert.doesNotMatch(log, /PI_VOICE_DEVICE_DIR='\/srv|PI_VOICE_DEVICE_DIR='\/home\/remote/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
