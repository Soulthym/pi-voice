import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

// Run the real script, but never allow container, SSH, or transpiler work.
const PODMAN = `
case $1 in
  info) echo true; exit 0 ;;
  build) printf '%s' "$3" >"$FIXTURE/name"; printf '%s' "$PPID" >"$FIXTURE/owner"; exit 0 ;;
  container|image) exit 0 ;;
  exec)
    if [[ $2 == --user ]]; then
      case $RESULT in
        INT|TERM) kill -"$RESULT" "$PPID"; exit 0 ;;
        *) exit "$RESULT" ;;
      esac
    fi
    [[ $* == *'tail -c 4096'* ]] || exit 0
    ;;
  rm|rmi) ;;
  *) exit 0 ;;
esac
# Repeated terminal-style interrupts hit both the owner and its cleanup child.
# The test runner is outside this detached process group.
for sig in INT TERM INT TERM; do
  kill -"$sig" -- "-$(<"$FIXTURE/owner")"
  sleep 0.02
done
printf '%s\\n' "$*" >>"$FIXTURE/cleaned"
[[ $1 != exec ]] || exit 17
[[ $1 != rm || $FAIL_REMOVE != 1 ]] || exit 19
`;

for (const [result, failRemove, expected] of [
	["0", false, 0], ["23", false, 23], ["INT", false, 130], ["TERM", false, 143],
	["0", true, 1], ["23", true, 23],
] as const) {
	test(`desktop cleanup ignores repeated signals: result=${result}, removal failure=${failRemove}`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-desktop-cleanup-"));
		const bin = path.join(root, "bin");
		const tmp = path.join(root, "tmp");
		fs.mkdirSync(bin);
		fs.mkdirSync(tmp);
		for (const [name, body] of Object.entries({
			podman: PODMAN,
			"ssh-keygen": 'printf "fake public key\\n" >"${@: -1}.pub"',
			node: "exit 0",
		})) {
			fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
		}
		// A restricted PATH prevents accidentally reaching any real harness tools.
		for (const tool of ["bash", "dirname", "mktemp", "rm", "sleep", "timeout"]) {
			fs.symlinkSync(`/usr/bin/${tool}`, path.join(bin, tool));
		}
		const child = spawn("/bin/bash", [path.resolve("scripts/test-ssh-desktop.sh")], {
			detached: true,
			stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, PATH: bin, TMPDIR: tmp, FIXTURE: root, RESULT: result, FAIL_REMOVE: failRemove ? "1" : "0" },
		});
		let stderr = "";
		child.stderr.on("data", chunk => { stderr += chunk; });
		const killGroup = () => {
			try { process.kill(-child.pid!, "SIGKILL"); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		};
		const timer = setTimeout(killGroup, 10_000);
		try {
			const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
				child.on("error", reject);
				child.on("close", (code, signal) => resolve({ code, signal }));
			});
			assert.deepEqual(outcome, { code: expected, signal: null }, stderr);
			const name = fs.readFileSync(path.join(root, "name"), "utf8");
			assert.match(name, /^pi-voice-test-\d+-\d+$/);
			const cleaned = fs.readFileSync(path.join(root, "cleaned"), "utf8").trim().split("\n");
			assert.deepEqual(cleaned.slice(-3), [
				`rm --ignore -f -t 1 ${name}-client`, `rm --ignore -f -t 1 ${name}-server`, `rmi --ignore ${name}`,
			]);
			assert.equal(cleaned.length, result === "0" ? 3 : 5, "cleanup runs once, including failure diagnostics");
			if (result !== "0") {
				assert.ok(cleaned[0].startsWith(`exec ${name}-server tail -c 4096 `));
				assert.ok(cleaned[1].startsWith(`exec ${name}-client bash -c tail -c 4096 `));
				assert.match(stderr, new RegExp(`failed \\(exit ${expected}\\)`));
			}
			assert.deepEqual(fs.readdirSync(tmp), [], "owned temporary directory removed");
		} finally {
			clearTimeout(timer);
			killGroup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}
