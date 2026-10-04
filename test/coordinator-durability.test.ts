import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test, { mock, type TestContext } from "node:test";

const fsyncSync = fs.fsyncSync;
const spawnSync = childProcess.spawnSync;
let syncHook: ((fd: number) => void) | undefined;
let linkHook: ((source: string, target: string) => void) | undefined;
let lockHook: (() => void) | undefined;
let missingFlock = false;
let unreadableAncestor: string | undefined;
mock.module("node:fs", { defaultExport: { ...fs }, namedExports: { ...fs, openSync(file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
	if (file === unreadableAncestor) throw Object.assign(new Error("execute-only ancestor"), { code: "EACCES" });
	return fs.openSync(file, flags, mode);
}, fsyncSync(fd: number) {
	syncHook?.(fd);
	fsyncSync(fd);
}, symlinkSync(source: string, target: string, type: fs.symlink.Type) {
	linkHook?.(path.resolve(path.dirname(target), source), target);
	fs.symlinkSync(source, target, type);
} } });
mock.module("node:child_process", { defaultExport: childProcess, namedExports: { ...childProcess,
	spawnSync(command: string, args: string[], options: object) {
		if (command === "flock" && missingFlock) return { status: null, error: new Error("ENOENT") };
		assert.notEqual(command, "mv", "publication must use the native filesystem primitive");
		const result = spawnSync(command, args, options);
		if (command === "flock" && result.status === 0) lockHook?.();
		return result;
	},
} });
const { SessionCoordinator } = await import("../src/session-coordinator.js");
const { StopRecovery } = await import("../src/stop-recovery.js");
const { PhoneInputClient } = await import("../src/phone-input.js");
const { FakeVoiceHost, MockedVoiceWorkerClient, assistant } = await import("./helpers/fake-voice-host.js");
mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const { Vocalizer } = await import("../src/vocalizer.js");
const { DEFAULT_VOICE_CONFIG } = await import("../src/config.js");
const { plainCodeNarration } = await import("../src/code-narration.js");

for (const failure of ["flock", "fsync"]) test(`heartbeat survives ${failure} failure and retains ownership`, async t => {
	const { owner, root } = setup(t);
	owner.start();
	assert.equal(owner.tryAcquireSpeech(), true);
	const generation = owner.speechOwner()!.speechGeneration;
	const errors = t.mock.method(console, "error", () => {});
	if (failure === "flock") missingFlock = true;
	else syncHook = () => { throw new Error("heartbeat fsync failure"); };
	await delay(1150);
	assert.ok(errors.mock.calls.some(call => /heartbeat failed; retaining speech fence/.test(String(call.arguments[0]))));
	assert.equal(owner.speechOwner()!.speechGeneration, generation);
	assert.equal(fs.lstatSync(path.join(root, "speech.lock")).isSymbolicLink(), true);
	missingFlock = false; syncHook = undefined;
	await delay(1050);
	assert.equal(owner.speechOwner()!.speechGeneration, generation);
});

for (const description of [false, true]) test(`middle sentence fsync failure aborts entire ${description ? "description" : "prose"} dispatch loop`, async t => {
	const { owner } = setup(t);
	owner.start();
	const worker = new MockedVoiceWorkerClient(() => {});
	let cancellations = 0;
	t.mock.method(worker, "cancel", () => { cancellations++; return undefined; });
	const errors: string[] = [];
	const vocalizer = new Vocalizer(() => ({ ...DEFAULT_VOICE_CONFIG, enabled: true }), event => {
		if (event.type === "error") { errors.push(event.message); vocalizer.clear(); }
	}, async () => plainCodeNarration("First sentence. Second sentence. Third sentence."),
	undefined, worker, undefined, undefined, undefined, undefined, () => owner.recovery.beforeIO("output"));
	t.after(() => vocalizer.shutdown());
	let writes = 0;
	syncHook = fd => {
		if (fs.fstatSync(fd).isFile() && ++writes === 2) throw new Error("transient middle fsync failure");
	};
	vocalizer.speak(description ? "```js\nconst x = 1;\n```\nFollowing prose." : "First sentence. Second sentence. Third sentence.");
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(worker.sent.length, 1, "first sentence is already active; nothing after failure dispatches");
	assert.equal(cancellations, 1);
	assert.deepEqual(errors, ["transient middle fsync failure"]);
	assert.equal(writes, 2, "transient recovery must not admit the rest of the cancelled batch");
	vocalizer.speak("Replacement sentence.");
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(worker.sent.length, 2);
	const replacement = vocalizer.playbackUtterance;
	vocalizer.handleWorkerEvent({ type: "idle", cancelId: 91 });
	assert.equal(vocalizer.playbackUtterance, replacement, "stale cancellation ACK cannot retire replacement");
});

test("middle admission failure cancels active host transport and stale ACK preserves replacement lease", async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "voice-admission-host-"));
	const env = { PI_VOICE_CONFIG: path.join(directory, "config.json"), PI_VOICE_COORDINATOR_DIR: path.join(directory, "coordinator"), PI_VOICE_DEVICE_DIR: path.join(directory, "devices") };
	const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	fs.writeFileSync(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, mode: "assistant", input: "disabled", output: "local", audioCache: false, timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(directory, "admission-host");
	t.after(async () => {
		syncHook = undefined;
		await host.shutdown();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		fs.rmSync(directory, { recursive: true, force: true });
	});
	host.addMessage("history", null, assistant("Historical replacement."));
	const workerIndex = MockedVoiceWorkerClient.instances.length;
	await host.start();
	const worker = MockedVoiceWorkerClient.instances[workerIndex]!;
	const partial = assistant("First sentence. Second sentence. Third sentence.", "pending");
	await host.emit("message_start", { type: "message_start", message: partial });
	let admissions = 0;
	const beforeIO = StopRecovery.prototype.beforeIO;
	t.mock.method(StopRecovery.prototype, "beforeIO", function(this: InstanceType<typeof StopRecovery>, direction: "input" | "output") {
		if (direction === "output" && ++admissions === 2) syncHook = () => { throw new Error("transient admission fsync failure"); };
		try { beforeIO.call(this, direction); } finally { syncHook = undefined; }
	});
	const cancel = t.mock.method(worker, "cancel", () => 71);
	await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: partial.content[0].type === "text" ? partial.content[0].text + " " : "" } });
	const settle = async () => { for (let i = 0; i < 16; i++) await new Promise(resolve => setImmediate(resolve)); };
	await settle();
	assert.equal(worker.sent.length, 1);
	assert.equal(admissions, 2);
	assert.equal(cancel.mock.callCount(), 1);
	const lease = path.join(env.PI_VOICE_COORDINATOR_DIR, "speech.lock", "lease.json");
	assert.ok(fs.existsSync(lease), "active transport retains ownership until ACK");
	cancel.mock.restore();
	await host.shortcut("f5");
	await settle();
	assert.equal(worker.sent.length, 1, "replacement waits for cancellation proof");
	worker.emit({ type: "idle", cancelId: 70 });
	await settle();
	assert.equal(worker.sent.length, 1);
	worker.emit({ type: "idle", cancelId: 71 });
	await settle();
	assert.ok(worker.sent.length > 1);
	const replacement = fs.readFileSync(lease, "utf8");
	worker.emit({ type: "idle", cancelId: 71 });
	await settle();
	assert.equal(fs.readFileSync(lease, "utf8"), replacement);
});

for (const failure of ["flock", "fsync"]) test(`waiting announcement timer catches ${failure} failure without releasing its fence`, async t => {
	const { directory, root, owner: waiter } = setup(t);
	const env = { PI_VOICE_CONFIG: path.join(directory, "config.json"), PI_VOICE_COORDINATOR_DIR: root, PI_VOICE_DEVICE_DIR: path.join(directory, "devices") };
	const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	fs.writeFileSync(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, mode: "assistant", input: "disabled", output: "local", audioCache: false, timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(directory, "announcer");
	t.after(async () => {
		missingFlock = false; syncHook = linkHook = undefined;
		await host.shutdown();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	});
	const workerIndex = MockedVoiceWorkerClient.instances.length;
	await host.start();
	waiter.start();
	waiter.markWaiting({ kind: "intentional_local" });
	if (failure === "flock") missingFlock = true;
	else linkHook = () => {
		syncHook = fd => {
			if (fs.readlinkSync(`/proc/self/fd/${fd}`) === root) throw new Error("announcement fsync failure");
		};
	};
	await until(() => host.notices.some(notice => notice.message.includes("Attention poll failed; ownership retained")));
	assert.equal(MockedVoiceWorkerClient.instances[workerIndex]!.sent.length, 0);
	assert.equal(waiter.waitingSessions()[0]!.announced, false);
	assert.equal(fs.existsSync(path.join(root, "speech.lock")), failure === "fsync", "a published fence survives failed durability");
	missingFlock = false; syncHook = linkHook = undefined;
	await delay(250);
	assert.equal(MockedVoiceWorkerClient.instances[workerIndex]!.sent.length, 0, "failure suppresses automatic announcement retries");
});

function setup(t: TestContext) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "voice-durable-"));
	const root = path.join(directory, "nested", "coordinator");
	const owner = new SessionCoordinator(directory, "owner", root);
	t.after(async () => {
		syncHook = linkHook = lockHook = undefined;
		missingFlock = false;
		unreadableAncestor = undefined;
		owner.shutdown();
		await delay(60);
		fs.rmSync(directory, { recursive: true, force: true });
	});
	return { directory, root, owner, lock: path.join(root, ".speech-mutation.lock") };
}

function hold(lock: string): number {
	const fd = fs.openSync(lock, "a");
	assert.equal(childProcess.spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "pipe", fd] }).status, 0);
	return fd;
}

async function until(check: () => boolean) {
	for (let count = 0; count < 200; count++) {
		if (check()) return;
		await delay(10);
	}
	assert.fail("deferred release did not complete");
}

for (const direction of ["input", "output"] as const) test(`actual journal fsync failure blocks ${direction} admission, including retry`, async t => {
	const { root } = setup(t);
	const ledger = new StopRecovery(root, "journal-owner");
	ledger.initialize();
	let failures = 0;
	syncHook = fd => {
		if (fs.fstatSync(fd).isFile()) { failures++; throw new Error("injected journal fsync failure"); }
	};
	for (let retry = 0; retry < 2; retry++) {
		if (direction === "input") {
			const input = new PhoneInputClient(undefined, undefined, () => ledger.beforeIO(direction));
			await assert.rejects(input.capture("not-an-endpoint"), /journal fsync failure/);
		} else assert.throws(() => ledger.beforeIO(direction), /journal fsync failure/);
	}
	assert.equal(failures, 2, "a failed write must not become an in-memory admission bypass");
	assert.equal(new StopRecovery(root, "journal-owner").isIdle(direction), true, "failed file fsync never publishes uncertain journal");
	syncHook = undefined;
	ledger.beforeIO(direction);
	assert.equal(new StopRecovery(root, "journal-owner").isIdle(direction), false);
});

test("named-session startup fails closed when the fresh nested root's upper parent cannot fsync", async t => {
	const { directory, root } = setup(t);
	const env = { PI_VOICE_CONFIG: path.join(directory, "config.json"), PI_VOICE_COORDINATOR_DIR: root, PI_VOICE_DEVICE_DIR: path.join(directory, "devices") };
	const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	fs.writeFileSync(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, mode: "assistant", input: "disabled", output: "local", audioCache: false, timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(directory, "named-startup");
	host.sessionName = "Named session";
	t.after(async () => {
		syncHook = undefined;
		try { await host.shutdown(); }
		finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
		}
	});
	const acquire = t.mock.method(SessionCoordinator.prototype, "tryAcquireSpeech");
	const forceAcquire = t.mock.method(SessionCoordinator.prototype, "forceAcquireSpeech");
	const admission = t.mock.method(StopRecovery.prototype, "beforeIO");
	assert.equal(fs.existsSync(path.dirname(root)), false);
	syncHook = fd => {
		if (fs.readlinkSync(`/proc/self/fd/${fd}`) === directory) throw new Error("upper parent fsync failure");
	};
	await assert.rejects(host.start(), /upper parent fsync failure/);
	assert.equal(fs.existsSync(path.join(root, "sessions")), false, "presence must not precede durable root initialization");
	assert.equal(fs.existsSync(path.join(root, "speech.lock")), false);
	assert.equal(acquire.mock.callCount(), 0);
	assert.equal(forceAcquire.mock.callCount(), 0);
	assert.equal(admission.mock.callCount(), 0);
});

test("initialization bounds ancestor fsync and retains the boundary across failed saves", t => {
	const { directory, root } = setup(t);
	const ledger = new StopRecovery(root, "initialization-owner");
	// Mock permissions even when running as root: traversal is allowed, opening this ancestor is not.
	unreadableAncestor = path.dirname(directory);
	const seen: string[] = [];
	syncHook = fd => {
		if (!fs.fstatSync(fd).isDirectory()) return;
		const name = fs.readlinkSync(`/proc/self/fd/${fd}`);
		seen.push(name);
		if (name === directory) throw new Error("parent fsync failure");
	};
	assert.throws(() => ledger.initialize(), /parent fsync failure/);
	assert.throws(() => ledger.beforeIO("output"), /unavailable/);
	assert.throws(() => ledger.clear("output"), /parent fsync failure/, "retry must sync the original mkdir boundary");
	assert.throws(() => ledger.beforeIO("output"), /unavailable/);
	assert.ok(seen.includes(root));
	assert.ok(seen.includes(path.dirname(root)));
	syncHook = fd => { if (fs.fstatSync(fd).isDirectory()) seen.push(fs.readlinkSync(`/proc/self/fd/${fd}`)); };
	seen.length = 0;
	ledger.clear("output");
	assert.deepEqual(seen, [path.dirname(ledger.file), root, path.dirname(root), directory]);
	seen.length = 0;
	ledger.beforeIO("output");
	assert.deepEqual(seen, [path.dirname(ledger.file)], "existing directories need only the journal directory synced");
	assert.equal(new StopRecovery(root, "initialization-owner").isIdle("output"), false);
});

for (const competitor of ["none", "empty", "populated"] as const) test(`speech publication is populated and atomic against ${competitor} legacy contender`, t => {
	const { root, owner } = setup(t);
	owner.start();
	const target = path.join(root, "speech.lock");
	linkHook = (source, destination) => {
		assert.equal(destination, target);
		assert.equal(fs.existsSync(target), false, "legacy stale cleaner cannot observe our empty lease");
		const staged = JSON.parse(fs.readFileSync(path.join(source, "lease.json"), "utf8"));
		assert.equal(staged.instanceId, owner.instanceId);
		assert.ok(staged.speechGeneration);
		// A legacy mkdir may win immediately before symlink, without taking flock.
		if (competitor !== "none") fs.mkdirSync(target);
		if (competitor === "populated") fs.writeFileSync(path.join(target, "lease.json"), "other owner's lease");
	};
	assert.equal(owner.tryAcquireSpeech(), competitor === "none");
	if (competitor === "empty") assert.deepEqual(fs.readdirSync(target), []);
	if (competitor === "populated") assert.equal(fs.readFileSync(path.join(target, "lease.json"), "utf8"), "other owner's lease");
	assert.equal(fs.readdirSync(root).filter(name => name.startsWith("speech.lock.")).length, competitor === "none" ? 1 : 0);
	if (competitor === "none") {
		assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
		const backing = fs.realpathSync(target);
		assert.equal(path.isAbsolute(fs.readlinkSync(target)), false);
		// Old coordinators read through the link and recursively remove only the link.
		assert.equal(JSON.parse(fs.readFileSync(path.join(target, "lease.json"), "utf8")).instanceId, owner.instanceId);
		fs.rmSync(target, { recursive: true });
		assert.equal(fs.existsSync(path.join(backing, "lease.json")), true);
	}
});

test("failed publication fsync must succeed before reusing the linked lease", t => {
	const { root, owner } = setup(t);
	owner.start();
	linkHook = () => {
		syncHook = fd => {
			if (fs.readlinkSync(`/proc/self/fd/${fd}`) === root) throw new Error("publication fsync failure");
		};
	};
	assert.throws(() => owner.tryAcquireSpeech(), /publication fsync failure/);
	assert.throws(() => owner.tryAcquireSpeech(), /publication fsync failure/);
	syncHook = linkHook = undefined;
	assert.equal(owner.tryAcquireSpeech(), true);
});

test("flock survives helper exit, excludes contenders, and releases after holder crash", async t => {
	const { root, owner, lock } = setup(t);
	owner.start();
	const child = childProcess.spawn(process.execPath, ["--input-type=module", "-e", `
		import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
		const fd = fs.openSync(process.argv[1], 'a');
		if (spawnSync('flock', ['-n', '3'], {stdio:['ignore','ignore','pipe',fd]}).status !== 0) process.exit(2);
		console.log('locked'); setInterval(() => {}, 1000);
	`, lock], { stdio: ["ignore", "pipe", "pipe"] });
	t.after(() => child.kill("SIGKILL"));
	await once(child.stdout!, "data");
	const inode = fs.statSync(lock).ino;
	assert.equal(owner.tryAcquireSpeech(), false);
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
	assert.equal(owner.tryAcquireSpeech(), true);
	owner.releaseSpeech();
	assert.equal(fs.existsSync(path.join(root, "speech.lock")), false);
	assert.equal(fs.statSync(lock).ino, inode, "persistent lockfile must never be unlinked");
});

test("symlink root aliases serialize recovery and acquisition on the same persistent inode", t => {
	const { owner, root, directory, lock } = setup(t);
	owner.start();
	const alias = path.join(directory, "alias");
	fs.symlinkSync(root, alias, "dir");
	const contender = new SessionCoordinator(directory, "alias-contender", alias);
	contender.start();
	t.after(() => contender.shutdown());
	assert.equal(owner.tryAcquireSpeech(), true);
	const dead = { ...owner.speechOwner()!, pid: 2147483647, kind: "speech" };
	fs.writeFileSync(path.join(root, "speech.lock", "lease.json"), JSON.stringify(dead));
	const inode = fs.statSync(lock).ino;
	lockHook = () => {
		lockHook = undefined;
		assert.equal(contender.recoverIdleSpeech(dead), false, "alias cannot recover while recovery holds the lock");
	};
	syncHook = fd => {
		if (fs.readlinkSync(`/proc/self/fd/${fd}`) === root && !fs.existsSync(path.join(root, "speech.lock"))) {
			syncHook = undefined;
			assert.equal(contender.tryAcquireSpeech(), false, "alias cannot acquire before recovery durability completes");
		}
	};
	assert.equal(owner.recoverIdleSpeech(dead), true);
	assert.equal(contender.tryAcquireSpeech(), true);
	assert.equal(owner.recoverIdleSpeech(dead), false);
	contender.releaseSpeech();
	assert.equal(fs.statSync(path.join(alias, ".speech-mutation.lock")).ino, inode);
});

for (const available of [true, false]) test(`Android uses Linux kernel flock and fails closed when unavailable: ${available}`, t => {
	const { owner, root } = setup(t);
	owner.start();
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { ...descriptor, value: "android" });
	try {
		missingFlock = !available;
		if (available) assert.equal(owner.tryAcquireSpeech(), true);
		else {
			assert.throws(() => owner.tryAcquireSpeech(), /requires working Linux flock/);
			assert.equal(fs.existsSync(path.join(root, "speech.lock")), false);
		}
	} finally {
		Object.defineProperty(process, "platform", descriptor);
		missingFlock = false;
	}
});

test("missing flock fails closed without publishing ownership", t => {
	const { owner, root } = setup(t);
	owner.start();
	missingFlock = true;
	assert.throws(() => owner.tryAcquireSpeech(), /requires working Linux flock/);
	assert.equal(fs.existsSync(path.join(root, "speech.lock")), false);
});

test("recovery rechecks generation after acquiring the lock and durably removes only the exact idle owner", t => {
	const { owner, root } = setup(t);
	owner.start();
	assert.equal(owner.tryAcquireSpeech(), true);
	const file = path.join(root, "speech.lock", "lease.json");
	const dead = { ...owner.speechOwner()!, pid: 2147483647 };
	fs.writeFileSync(file, JSON.stringify({ ...dead, kind: "speech" }));
	lockHook = () => {
		lockHook = undefined;
		fs.writeFileSync(file, JSON.stringify({ ...dead, kind: "speech", speechGeneration: "replacement" }));
	};
	assert.equal(owner.recoverIdleSpeech(dead), false);
	assert.equal(owner.speechOwner()!.speechGeneration, "replacement");
	let removalSynced = false;
	syncHook = fd => {
		if (fs.readlinkSync(`/proc/self/fd/${fd}`) === root && !fs.existsSync(file)) removalSynced = true;
	};
	assert.equal(owner.recoverIdleSpeech(owner.speechOwner()!), true);
	assert.equal(removalSynced, true);
});

test("release fsyncs the directory removal before returning", t => {
	const { owner, root } = setup(t);
	owner.start();
	assert.equal(owner.tryAcquireSpeech(), true);
	let removalSynced = false;
	syncHook = fd => {
		if (fs.readlinkSync(`/proc/self/fd/${fd}`) === root && !fs.existsSync(path.join(root, "speech.lock"))) removalSynced = true;
	};
	owner.releaseSpeech();
	assert.equal(removalSynced, true);
});

for (const newer of ["none", "reuse", "sync-reuse", "replacement", "wrong-owner", "shutdown"] as const) test(`release contention safely defers: ${newer}`, async t => {
	const { root, owner, lock } = setup(t);
	owner.start();
	assert.equal(owner.tryAcquireSpeech(), true);
	const fd = hold(lock);
	const lease = path.join(root, "speech.lock", "lease.json");
	try {
		assert.doesNotThrow(() => owner.releaseSpeech());
		await delay(70); // Exercise multiple busy callbacks, not just initial scheduling.
		assert.equal(fs.existsSync(lease), true);
		if (newer === "reuse") assert.equal(await owner.forceAcquireSpeech(), true);
		if (newer === "sync-reuse") assert.equal(owner.tryAcquireSpeech(), true);
		if (newer === "shutdown") owner.shutdown();
		if (newer === "replacement" || newer === "wrong-owner") {
			const value = JSON.parse(fs.readFileSync(lease, "utf8"));
			fs.writeFileSync(lease, JSON.stringify(newer === "replacement" ? { ...value, speechGeneration: "new-generation" } : { ...value, instanceId: "different-owner" }));
		}
	} finally { fs.closeSync(fd); }
	if (newer === "none" || newer === "shutdown") await until(() => !fs.existsSync(lease));
	else {
		await delay(80);
		assert.equal(fs.existsSync(lease), true, "deferred cleanup must not steal newer work");
	}
});
