import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

const helper = path.resolve("client/pi-voice-stt-session");
const boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(check: () => Promise<boolean>, message: string) {
	for (let i = 0; i < 250; i++) { if (await check()) return; await pause(); }
	assert.fail(message);
}
async function fixture(t: TestContext) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "mic-durable-"));
	for (const dir of ["bin", "home", "runtime", "state"]) await fs.mkdir(path.join(root, dir));
	const env: NodeJS.ProcessEnv = { PATH: `${root}/bin:/usr/bin:/bin`, HOME: `${root}/home`, XDG_STATE_HOME: `${root}/state`, XDG_RUNTIME_DIR: `${root}/runtime`, TMPDIR: root, PI_VOICE_MAX_RECORD_SECONDS: "1" };
	const children: ChildProcessWithoutNullStreams[] = [];
	const state = `${root}/state/pi-voice/microphone-desktop`;
	async function mock(name: string, body: string) { await fs.writeFile(`${root}/bin/${name}`, `#!/bin/bash\n${body}\n`, { mode: 0o755 }); }
	await mock("pactl", "exit 1"); await mock("wpctl", "exit 0");
	await mock("pw-record", '[[ $1 == --help ]] && { echo Usage; exit; }; touch "$TMPDIR/spawned"; printf pcm');
	await mock("ffmpeg", "cat");
	function start(command = "ticket\n") {
		const child = spawn("bash", [helper], { env }); children.push(child);
		const chunks: Buffer[] = []; child.stdout.on("data", chunk => { chunks.push(chunk); }); child.stderr.resume(); child.stdin.on("error", () => {});
		const done = new Promise<void>(resolve => child.once("close", () => resolve()));
		child.stdin.write(command);
		return { child, done, output: () => Buffer.concat(chunks).toString(), bytes: () => Buffer.concat(chunks) };
	}
	async function exchange(command: string) { const session = start(`${command}\n`); session.child.stdin.end(); await session.done; return session.output(); }
	async function ticket() {
		const session = start(); await until(async () => session.output().includes("\n"), "ticket reply");
		const match = /^ticket ([0-9a-f]{32}\.[1-9][0-9]*) ([0-9a-f-]{36})\n$/.exec(session.output()); assert.ok(match, session.output()); assert.equal(match[2], boot);
		return { ...session, id: match[1], boot: match[2], record: () => session.child.stdin.write(`record ${match[1]} ${match[2]}\n`) };
	}
	t.after(async () => {
		await fs.writeFile(`${root}/release`, "");
		for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once("close", () => resolve()))));
		await fs.rm(root, { recursive: true, force: true });
	});
	return { root, state, env, mock, start, exchange, ticket };
}

test("desktop durable microphone: boot ticket, cancellation, replay, private state and restart", async t => {
	const f = await fixture(t); const first = await f.ticket();
	assert.equal((await fs.stat(f.state)).mode & 0o777, 0o700);
	assert.equal((await fs.stat(`${f.state}/tickets`)).mode & 0o777, 0o600);
	assert.equal(await f.exchange(`stop ${first.id}`), `ok ${Buffer.from(`stopped ${first.id}`).toString("base64")}\n`);
	first.record(); await first.done; assert.ok(!first.output().includes("stream"));
	const next = await f.ticket(); assert.equal(next.id, first.id.replace(/\.1$/, ".2"));
	next.child.stdin.end(`record ${next.id} 00000000-0000-0000-0000-000000000000\n`); await next.done;
	assert.ok(!next.output().includes("stream"));
	assert.match(await f.exchange(`record ${next.id} ${boot}`), /^error /);
	assert.equal(await fs.stat(`${f.root}/spawned`).catch(() => false), false);
});

for (const nested of [false, true]) test(`desktop durable microphone: publication sync stops at first existing parent (${nested ? "missing state home" : "existing pi-voice"})`, async t => {
	const f = await fixture(t);
	if (nested) f.env.XDG_STATE_HOME = `${f.root}/missing/nested/state`;
	else await fs.mkdir(`${f.root}/state/pi-voice`);
	const state = `${f.env.XDG_STATE_HOME}/pi-voice/microphone-desktop`;
	const boundary = nested ? f.root : `${f.root}/state/pi-voice`;
	await f.mock("sync", `for target in "$@"; do
  [[ $target == "${boundary}" || $target == "${boundary}/"* || $target == "$TMPDIR/runtime/"* ]] || exit 1
  [[ -d $target && $target != "$TMPDIR/runtime/"* ]] && printf '%s\\n' "$target" >>"$TMPDIR/synced"
done
exec /bin/sync "$@"`);
	assert.match(await f.exchange("ticket"), /^ticket /);
	const expected = [state];
	while (expected.at(-1) !== boundary) expected.push(path.dirname(expected.at(-1)!));
	assert.deepEqual([...new Set((await fs.readFile(`${f.root}/synced`, "utf8")).trim().split("\n"))], expected);
});

test("desktop durable microphone: immediate cancellation before encoder spawn cannot strand its FIFO reader", async t => {
	const f = await fixture(t);
	// Deterministically schedule recorder death and cancellation before the reader
	// starts, rather than hoping the asynchronous FIFO opens race in our favour.
	f.env.BASH_ENV = `${f.root}/early-cancel`;
	await fs.writeFile(f.env.BASH_ENV, `trap 'if [[ $BASH_COMMAND == "ffmpeg -hide_banner"* && $BASHPID == $$ ]]; then
  kill "$recorder_pid" 2>/dev/null || true
  wait "$recorder_pid" 2>/dev/null || true
  touch "$TMPDIR/cancelled"
  kill -TERM "$$"
fi' DEBUG\n`);
	const session = await f.ticket();
	let closed = false; void session.done.then(() => { closed = true; });
	session.record();
	try {
		await until(async () => closed, "cancelled owner must wait for both children and exit");
		assert.ok(await fs.stat(`${f.root}/cancelled`));
		assert.match(await fs.readFile(`${f.state}/tickets`, "utf8"), / 0 - idle\n$/);
		assert.match(await f.exchange(`stop ${session.id}`), /^ok /);
	} finally {
		// Unstrand the old implementation too, so a regression fails without
		// leaving an isolated test child behind or hanging fixture teardown.
		for (const name of await fs.readdir(f.state)) if (name.startsWith("pcm-")) {
			const fd = await fs.open(`${f.state}/${name}`, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
			await fd.close();
		}
	}
});

test("desktop durable microphone: own child exit publishes retirement across runtime loss", async t => {
	const f = await fixture(t); const session = await f.ticket(); session.record(); await session.done;
	assert.ok(session.output().includes("stream\npcm"));
	assert.match(await fs.readFile(`${f.state}/tickets`, "utf8"), / 0 - idle\n$/);
	await fs.rm(`${f.root}/runtime`, { recursive: true }); await fs.mkdir(`${f.root}/runtime`);
	assert.match(await f.exchange(`stop ${session.id}`), /^ok /);
});

for (const stopped of [false, true]) test(`desktop durable microphone: real encoder flushes synthetic PCM on ${stopped ? "stop" : "EOF"}`, async t => {
	const f = await fixture(t);
	await fs.unlink(`${f.root}/bin/ffmpeg`);
	const pcm = Buffer.alloc(64000);
	for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i * 2 * Math.PI * 440 / 16000)), i * 2);
	await fs.writeFile(`${f.root}/synthetic.pcm`, pcm);
	await f.mock("pw-record", `[[ $1 == --help ]] && { echo Usage; exit; }; cat "$TMPDIR/synthetic.pcm"; touch "$TMPDIR/drained"; ${stopped ? "exec sleep 30" : "exit 0"}`);
	const session = await f.ticket(); session.record();
	if (stopped) {
		await until(async () => !!await fs.stat(`${f.root}/drained`).catch(() => false), "synthetic PCM drained");
		assert.match(await f.exchange(`stop ${session.id}`), /^ok /);
	}
	await session.done;
	const wire = session.bytes(); const marker = Buffer.from("stream\n"); const start = wire.indexOf(marker); assert.ok(start >= 0);
	const decoded = spawnSync("/usr/bin/ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1"], {
		input: wire.subarray(start + marker.length), env: { PATH: "/usr/bin:/bin", HOME: `${f.root}/home`, TMPDIR: f.root },
	});
	assert.equal(decoded.status, 0, decoded.stderr.toString()); assert.equal(decoded.stdout.length, pcm.length);
});

test("desktop durable microphone: pending stop prevents a delayed device check from spawning", async t => {
	const f = await fixture(t);
	await f.mock("wpctl", 'touch "$TMPDIR/checking"; while [[ ! -e $TMPDIR/release ]]; do sleep .02; done');
	const session = await f.ticket(); session.record();
	await until(async () => !!await fs.stat(`${f.root}/checking`).catch(() => false), "device check");
	assert.match(await f.exchange(`stop ${session.id}`), /^ok /);
	await fs.writeFile(`${f.root}/release`, ""); await session.done;
	assert.equal(await fs.stat(`${f.root}/spawned`).catch(() => false), false);
});

for (const damage of ["missing", "missing-file", "invalid", "multiline"]) test(`desktop durable microphone: ${damage} durable state fails closed`, async t => {
	const f = await fixture(t); const session = await f.ticket(); session.child.stdin.end(); await session.done;
	if (damage === "missing") await fs.rm(f.state, { recursive: true });
	else if (damage === "missing-file") await fs.unlink(`${f.state}/tickets`);
	else await fs.writeFile(`${f.state}/tickets`, damage === "invalid" ? "garbage\n" : `${await fs.readFile(`${f.state}/tickets`, "utf8")}garbage\n`);
	assert.match(await f.exchange("ticket"), /^error /);
	assert.match(await f.exchange(`stop ${session.id}`), /^error /);
});

test("desktop durable microphone: legacy evidence is not migrated into proof", async t => {
	const f = await fixture(t); const legacy = `${f.root}/runtime/pi-voice-client-${process.getuid!()}`;
	await fs.mkdir(legacy); await fs.writeFile(`${legacy}/recording-lock.tickets`, `${"a".repeat(32)} 1 0\n`);
	assert.match(await f.exchange("ticket"), /^error /);
});

test("desktop durable microphone: unavailable real boot fails before admission", async t => {
	const f = await fixture(t); await f.mock("cat", '[[ $1 == /proc/sys/kernel/random/boot_id ]] && exit 1; exec /bin/cat "$@"');
	assert.match(await f.exchange("ticket"), /^error /);
	assert.equal(await fs.stat(f.state).catch(() => false), false);
});

test("desktop durable microphone: persisted different boot retires old work, same boot cannot", async t => {
	const f = await fixture(t); const session = await f.ticket(); session.child.stdin.end(); await session.done;
	const fields = (await fs.readFile(`${f.state}/tickets`, "utf8")).trim().split(" ");
	fields[4] = "1"; fields[5] = "b".repeat(32); fields[6] = "admitted";
	await fs.writeFile(`${f.state}/tickets`, fields.join(" ") + "\n");
	const blocked = await f.ticket(); blocked.record(); await blocked.done;
	assert.ok(!blocked.output().includes("stream")); assert.match(blocked.output(), /error /);
	fields[0] = "00000000-0000-0000-0000-000000000000";
	await fs.writeFile(`${f.state}/tickets`, fields.join(" ") + "\n");
	assert.match(await f.exchange(`stop ${session.id}`), /^ok /);
	assert.match(await fs.readFile(`${f.state}/tickets`, "utf8"), new RegExp(`^${boot} .* 1 1 0 - idle\\n$`));
});

test("desktop durable microphone: admission sync failure never spawns a recorder", async t => {
	const f = await fixture(t);
	await f.mock("sync", '[[ $1 == */tickets.tmp ]] && grep -q " admitted$" "$1" && exit 1; exec /bin/sync "$@"');
	const session = await f.ticket(); session.record(); await session.done;
	assert.equal(await fs.stat(`${f.root}/spawned`).catch(() => false), false);
});

test("desktop durable microphone: kernel boot is rechecked on record, not cached per process", async t => {
	const f = await fixture(t); const session = await f.ticket();
	await f.mock("cat", '[[ $1 == /proc/sys/kernel/random/boot_id ]] && { echo 00000000-0000-0000-0000-000000000000; exit; }; exec /bin/cat "$@"');
	session.record(); await session.done;
	assert.ok(!session.output().includes("stream"));
	assert.equal(await fs.stat(`${f.root}/spawned`).catch(() => false), false);
});

test("desktop durable microphone: killed owner leaves a fence even after its child exits", async t => {
	const f = await fixture(t);
	await f.mock("pw-record", '[[ $1 == --help ]] && { echo Usage; exit; }; touch "$TMPDIR/spawned"; while [[ ! -e $TMPDIR/release ]]; do sleep .02; done');
	const session = await f.ticket(); session.record();
	await until(async () => !!await fs.stat(`${f.root}/spawned`).catch(() => false), "recorder spawn");
	session.child.kill("SIGKILL"); session.child.stdin.end();
	await fs.writeFile(`${f.root}/release`, ""); await session.done;
	assert.match(await fs.readFile(`${f.state}/tickets`, "utf8"), / 1 [0-9a-f]{32} admitted\n$/);
	// Shorten only this fixture's retry delays; no production timeout override.
	await f.mock("sleep", "exec /bin/sleep .001");
	assert.match(await f.exchange(`stop ${session.id}`), /^error /);
	const next = await f.ticket(); next.record(); await next.done;
	assert.ok(!next.output().includes("stream"));
});

test("desktop durable microphone: stop waits for owned recorder, not just encoder exit", async t => {
	const f = await fixture(t);
	await f.mock("pw-record", '[[ $1 == --help ]] && { echo Usage; exit; }; trap "" TERM INT HUP; touch "$TMPDIR/spawned"; while [[ ! -e $TMPDIR/release ]]; do sleep .02; done');
	await f.mock("ffmpeg", "exit 0");
	const session = await f.ticket(); session.record();
	await until(async () => !!await fs.stat(`${f.root}/spawned`).catch(() => false), "recorder spawn");
	const stop = f.start(`stop ${session.id}\n`); stop.child.stdin.end();
	await new Promise(resolve => setTimeout(resolve, 150));
	session.child.kill("SIGTERM"); await pause(); session.child.kill("SIGTERM");
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.equal(stop.output(), "", "must not certify retirement while owned recorder lives, even during repeated cleanup signals");
	await fs.writeFile(`${f.root}/release`, ""); await session.done; await stop.done;
	assert.match(stop.output(), /^ok /);
});
