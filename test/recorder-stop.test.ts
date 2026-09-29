import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { PhoneInputClient } from "../src/phone-input.js";

const BOOT = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();

function fixtureEnv(root: string): NodeJS.ProcessEnv {
	return { HOME: root, XDG_STATE_HOME: path.join(root, "state"), PREFIX: "", PATH: "/usr/bin:/bin", TMPDIR: root, XDG_RUNTIME_DIR: root };
}

function stateDir(root: string, script: string): string {
	return path.join(root, "state/pi-voice", script === "client/pi-voice-stt-session" ? "microphone-desktop" : "microphone/termux");
}

function receipt(ticket: string): string {
	return `ok ${Buffer.from(`stopped ${ticket}`).toString("base64")}\n`;
}

async function waitFor(check: () => Promise<unknown>): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (await check().catch(() => false)) return;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.fail("fixture did not reach expected state");
}

function session(script: string, env: NodeJS.ProcessEnv, command: string) {
	const child = spawn("bash", [path.resolve(script)], { env });
	let output = "";
	let admission = command === "record";
	let ticket = "";
	child.stdout.on("data", chunk => {
		output += chunk;
		if (admission && output.includes("\n")) {
			const match = /^ticket ([0-9a-f]{32}\.[1-9][0-9]*) ([0-9a-f-]{36})\n/.exec(output);
			if (!match) return;
			ticket = match[1];
			admission = false;
			output = output.slice(match[0].length);
			assert.equal(match[2], BOOT);
			child.stdin.write(`record ${match[1]} ${match[2]}\n`);
		}
	});
	child.stderr.resume();
	const closed = new Promise<string>(resolve => child.once("close", () => resolve(output)));
	child.stdin.write(`${command === "record" ? "ticket" : command}\n`);
	return { child, closed, get ticket() { return ticket; }, get output() { return output; } };
}

for (const script of ["client/pi-voice-stt-session", "client/pi-voice-termux-stt-session", "termux/pi-voice-stt-session"]) {
	for (const disconnect of [false, true]) test(`${script}: ${disconnect ? "disconnect" : "stop ACK"} waits for the fake recorder`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-recorder-stop-"));
		const bin = path.join(root, "bin"); await fs.mkdir(bin);
		const linux = script === "client/pi-voice-stt-session";
		const tools: Record<string, string> = linux ? {
			wpctl: "exit 0", pactl: "exit 1", ffmpeg: "exec cat",
			"pw-record": `[[ $1 == --help ]] && { echo "Usage: pw-record"; exit 0; }; exec '${process.execPath}' -e 'const fs = require("fs"); fs.writeFileSync(process.env.TMPDIR + "/running", "yes"); const timer = setInterval(() => {}, 100); process.on("SIGTERM", () => setTimeout(() => { fs.unlinkSync(process.env.TMPDIR + "/running"); clearInterval(timer); process.exit(0); }, 200));'`,
		} : {
			"termux-microphone-record": `case "$1" in
-q) sleep 0.2; rm -f "$TMPDIR/running";;
-i) if [[ -e "$TMPDIR/running" ]]; then printf '{"isRecording":true}'; else printf '{"isRecording":false}'; fi;;
-f) printf 'fake audio' > "$2"; touch "$TMPDIR/running"; printf 'Recording started: %s\nMax Duration: 00:02:00\n' "$2";;
esac`,
		};
		for (const [name, body] of Object.entries(tools)) await fs.writeFile(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
		const env = { ...fixtureEnv(root), PATH: `${bin}:/usr/bin:/bin`, PI_VOICE_MAX_RECORD_SECONDS: "5" };
		const child = spawn("bash", [path.resolve(script)], { env, stdio: ["pipe", "pipe", "pipe"] });
		let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.resume();
		const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
		t.after(async () => { child.stdin.end(); await closed; await fs.rm(root, { recursive: true, force: true }); });
		child.stdin.write("ticket\n");
		child.stdout.once("data", chunk => child.stdin.write(`record ${String(chunk).trim().slice(7)}\n`));
		for (let i = 0; i < 300 && !await fs.stat(path.join(root, "running")).catch(() => false); i++) await new Promise(resolve => setTimeout(resolve, 5));
		assert.ok(await fs.stat(path.join(root, "running")));
		if (disconnect) child.stdin.end();
		else {
			const stop = spawn("bash", [path.resolve(script)], { env });
			let ack = ""; stop.stdout.on("data", chunk => { ack += chunk; }); stop.stderr.resume();
			const stopped = new Promise<void>(resolve => stop.once("close", () => resolve()));
			stop.stdin.end(`stop ${output.split(" ")[1]}\n`);
			await new Promise(resolve => setTimeout(resolve, 50));
			assert.equal(ack, "", "must not acknowledge the stop request before stopping");
			await stopped;
			assert.equal(ack, receipt(output.split(" ")[1]));
			assert.equal(await fs.stat(path.join(root, "running")).catch(() => false), false);
		}
		await closed;
		assert.match(output, /^ticket [0-9a-f]{32}\.1 [0-9a-f-]{36}\nstream\n/);
		assert.equal(await fs.stat(path.join(root, "running")).catch(() => false), false);
	});
}

for (const script of ["client/pi-voice-stt-session", "client/pi-voice-termux-stt-session", "termux/pi-voice-stt-session"]) test(`${script}: reassigned generic bridge cannot release the host's origin ticket`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-reassigned-"));
	const other = path.join(root, "other"); await fs.mkdir(other);
	const env = fixtureEnv(root);
	const otherEnv = fixtureEnv(other);
	for (let i = 0; i < 2; i++) {
		const issued = session(script, otherEnv, "ticket"); issued.child.stdin.end();
		assert.match(await issued.closed, /^ticket /);
	}
	let route: "generic" | "foreign" | "origin" = "generic";
	let ticket = "";
	const stops: string[] = [];
	const recorded = Promise.withResolvers<void>();
	const children: ReturnType<typeof spawn>[] = [];
	const server = net.createServer(socket => {
		socket.on("error", () => {});
		socket.once("data", raw => {
			const command = String(raw).trim();
			if (command === "ticket") {
				const child = spawn("bash", [path.resolve(script)], { env }); children.push(child);
				child.stderr.resume();
				child.stdout.once("data", data => { ticket = String(data).trim().split(" ")[1]; socket.write(data); });
				child.stdin.write("ticket\n");
				// Hold before record/admission: exercise real ticket state without any hardware.
				socket.once("data", data => { assert.equal(String(data), `record ${ticket} ${BOOT}\n`); recorded.resolve(); });
				socket.on("close", () => child.stdin.end());
			} else {
				stops.push(command);
				const child = route === "generic"
					? spawn("bash", ["-c", "read -r command; printf 'ok c3RvcHBlZA==\\n'"], { env: otherEnv })
					: spawn("bash", [path.resolve(script)], { env: route === "origin" ? env : otherEnv });
				children.push(child); child.stderr.resume(); child.stdout.pipe(socket);
				child.stdin.end(`${command}\n`);
			}
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>(resolve => server.close(() => resolve()));
		await Promise.all(children.map(child => child.exitCode !== null ? undefined : new Promise(resolve => child.once("close", resolve))));
		await fs.rm(root, { recursive: true, force: true });
	});
	const address = server.address(); assert.ok(address && typeof address === "object");
	const client = new PhoneInputClient();
	await client.stop("invalid endpoint"); // Empty ownership must not send an RPC.
	const capture = assert.rejects(client.capture(`tcp://127.0.0.1:${address.port}`), /cancelled/);
	await recorded.promise;
	await assert.rejects(client.cancel(), /not confirmed/); await capture;
	await assert.rejects(client.stop(), /not confirmed/);
	route = "foreign";
	await assert.rejects(client.stop(), /Invalid microphone ticket/);
	route = "origin";
	await client.stop();
	await client.stop("invalid endpoint"); // Matching receipt cleared ownership.
	assert.deepEqual(stops, Array(4).fill(`stop ${ticket}`));
});

for (const script of ["client/pi-voice-termux-stt-session", "termux/pi-voice-stt-session"]) for (const recording of [true, false]) test(`${script}: unconfirmed start retains ownership even when Android reports recording=${recording}`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-recorder-failure-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const bin = path.join(root, "bin"); await fs.mkdir(bin);
	await fs.writeFile(path.join(bin, "termux-microphone-record"), `#!/bin/bash
case "$1" in
-f) printf 'fake audio' > "$2"; touch "$TMPDIR/running";;
-q) exit 0;;
-i) printf '{"isRecording":${recording}}';;
esac
`, { mode: 0o755 });
	const child = spawn("bash", [path.resolve(script)], { env: { ...fixtureEnv(root), PATH: `${bin}:/usr/bin:/bin` } });
	child.stdout.resume(); child.stderr.resume();
	const closed = new Promise<number | null>(resolve => child.once("close", resolve));
	child.stdin.write("ticket\n");
	child.stdout.once("data", chunk => child.stdin.write(`record ${String(chunk).trim().slice(7)}\n`));
	await waitFor(() => fs.stat(path.join(root, "running")));
	child.stdin.end();
	assert.equal(await closed, 1);
	assert.ok(await fs.stat(path.join(stateDir(root, script), "active")));
	assert.ok(await fs.stat(path.join(stateDir(root, script), "recording")));
	const owner = await fs.readFile(path.join(stateDir(root, script), "active"), "utf8");
	const env = { ...fixtureEnv(root), PATH: `${bin}:/usr/bin:/bin` };
	const retry = session(script, env, `stop ${owner.trim().split(":")[0]}`); retry.child.stdin.end();
	assert.match(await retry.closed, /^error /, "idle alone is not proof that an uncertain start cannot arrive later");
	const fresh = session(script, env, "record");
	assert.match(await fresh.closed, /^error /, "uncertain ownership must block new capture");
	assert.equal(await fs.readFile(path.join(stateDir(root, script), "active"), "utf8"), owner);
});

for (const script of ["client/pi-voice-stt-session", "client/pi-voice-termux-stt-session", "termux/pi-voice-stt-session"]) {
	for (const block of ["pending", "admission", ...(script === "client/pi-voice-stt-session" ? ["help", "pending-crash"] : ["mkdir-crash"])]) test(`${script}: ${block} cancellation and delayed stop preserve a newer generation`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-prestart-"));
		const bin = path.join(root, "bin"); await fs.mkdir(bin);
		const linux = script === "client/pi-voice-stt-session";
		const tools = linux ? {
			pactl: "exit 1", wpctl: "exit 0", ffmpeg: "exec cat",
			"pw-record": `if [[ $1 == --help ]]; then
  if [[ \${BLOCK_CHECK:-} == help ]]; then touch "$TMPDIR/check-blocked"; while [[ ! -e "$TMPDIR/release-check" ]]; do sleep 0.01; done; fi
  echo "Usage: pw-record"; exit 0
fi; exec '${process.execPath}' -e 'require("fs").writeFileSync(process.env.TMPDIR + "/running", "yes"); setInterval(() => {}, 100);'`,
		} : {
			"termux-microphone-record": `case "$1" in
-f) touch "$TMPDIR/running"; printf audio > "$2"; printf 'Recording started: %s\nMax Duration: 00:02:00\n' "$2";;
-q) rm -f "$TMPDIR/running";;
-i) printf '{"isRecording":false}';;
esac`,
		};
		for (const [name, body] of Object.entries(tools)) await fs.writeFile(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
		const hook = path.join(root, "hook");
		await fs.writeFile(hook, `command() {
  if [[ $* == '-v ${linux ? "ffmpeg" : "termux-microphone-record"}' && \${BLOCK_CHECK:-} == pending ]]; then
    touch "$TMPDIR/check-blocked"
    while [[ ! -e "$TMPDIR/release-check" ]]; do sleep 0.01; done
  fi
  builtin command "$@"
}
flock() {
  if [[ \${BLOCK_CHECK:-} == admission && \${command:-} == 'record '* && $* == '-x 9' ]]; then
    touch "$TMPDIR/check-blocked"
    while [[ ! -e "$TMPDIR/release-check" ]]; do sleep 0.01; done
  fi
  builtin command flock "$@"
}
sync() {
  builtin command sync "$@" || return
  if [[ \${BLOCK_CHECK:-} == pending-crash && $* == */microphone-desktop ]] && grep -q ' pending$' "$1/tickets"; then
    touch "$TMPDIR/check-blocked"
    kill -KILL "$BASHPID"
  fi
}
mkdir() {
  builtin command mkdir "$@" || return
  if [[ \${BLOCK_CHECK:-} == mkdir-crash && $* == */recording ]]; then
    touch "$TMPDIR/check-blocked"
    kill -KILL "$BASHPID"
  fi
}\n`);
		const env = { ...fixtureEnv(root), BASH_ENV: hook, PATH: `${bin}:/usr/bin:/bin`, PI_VOICE_MAX_RECORD_SECONDS: "5" };
		const old = session(script, { ...env, BLOCK_CHECK: block }, "record");
		let fresh: ReturnType<typeof session> | undefined;
		t.after(async () => {
			await fs.writeFile(path.join(root, "release-check"), "");
			old.child.stdin.end(); fresh?.child.stdin.end();
			await Promise.all([old.closed, fresh?.closed]);
			await fs.rm(root, { recursive: true, force: true });
		});
		await waitFor(() => fs.stat(path.join(root, "check-blocked")));
		const stop = session(script, env, `stop ${old.ticket}`); stop.child.stdin.end();
		assert.equal(await stop.closed, receipt(old.ticket));
		assert.equal(await fs.stat(path.join(root, "running")).catch(() => false), false);
		fresh = session(script, env, "record");
		await waitFor(() => fs.stat(path.join(root, "running")));
		const marker = path.join(stateDir(root, script), linux ? "tickets" : "active");
		const owner = await fs.readFile(marker, "utf8");
		assert.match(owner, linux ? / 2 1 2 [0-9a-f]{32} admitted\n$/ : /^[0-9a-f]{32}\.2:[0-9]+\n$/);
		const delayedStop = session(script, env, `stop ${old.ticket}`); delayedStop.child.stdin.end();
		assert.equal(await delayedStop.closed, receipt(old.ticket));
		assert.equal(await fs.readFile(marker, "utf8"), owner);
		assert.ok(await fs.stat(path.join(root, "running")));
		await fs.writeFile(path.join(root, "release-check"), "");
		assert.equal(await old.closed, "", "cancelled admission must never emit a stream/start recorder");
		assert.equal(await fs.readFile(marker, "utf8"), owner, "old cleanup must preserve the new owner");
		const finalStop = session(script, env, `stop ${fresh.ticket}`); finalStop.child.stdin.end();
		assert.equal(await finalStop.closed, receipt(fresh.ticket));
	});
}

for (const script of ["client/pi-voice-termux-stt-session", "termux/pi-voice-stt-session"]) {
	test(`${script}: dead-owner retry confirms Android stop before admitting a new generation`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-stop-retry-"));
		const bin = path.join(root, "bin"); await fs.mkdir(bin);
		await fs.writeFile(path.join(bin, "termux-microphone-record"), `#!/bin/bash
case "$1" in
-f) printf audio > "$2"; touch "$TMPDIR/running"; printf 'Recording started: %s\nMax Duration: 00:02:00\n' "$2";;
-q) if [[ -e "$TMPDIR/allow-stop" ]]; then
      touch "$TMPDIR/stop-blocked"
      while [[ ! -e "$TMPDIR/release-stop" ]]; do sleep 0.01; done
      rm -f "$TMPDIR/running"
    fi;;
-i) if [[ -e "$TMPDIR/running" ]]; then printf '{"isRecording":true}'; else printf '{"isRecording":false}'; fi;;
esac\n`, { mode: 0o755 });
		const env = { ...fixtureEnv(root), PATH: `${bin}:/usr/bin:/bin`, PI_VOICE_MAX_RECORD_SECONDS: "5" };
		const old = session(script, env, "record");
		let fresh: ReturnType<typeof session> | undefined;
		t.after(async () => {
			await fs.writeFile(path.join(root, "allow-stop"), "");
			await fs.writeFile(path.join(root, "release-stop"), "");
			old.child.stdin.end(); fresh?.child.stdin.end();
			await Promise.all([old.closed, fresh?.closed]);
			await fs.rm(root, { recursive: true, force: true });
		});
		await waitFor(() => fs.stat(path.join(root, "running")));
		old.child.stdin.end(); await old.closed;
		const marker = path.join(stateDir(root, script), "active");
		const staleOwner = await fs.readFile(marker, "utf8");
		// First explicit retry still cannot confirm: retain the lease, never fake ACK.
		const failed = session(script, env, `stop ${old.ticket}`); failed.child.stdin.end();
		assert.match(await failed.closed, /^error /);
		assert.equal(await fs.readFile(marker, "utf8"), staleOwner);
		// A forwarded endpoint reassigned to B must not confirm A, even at a higher counter.
		const otherRoot = path.join(root, "other"); await fs.mkdir(otherRoot);
		const otherEnv = { ...env, ...fixtureEnv(otherRoot) };
		for (let i = 0; i < 2; i++) {
			const issued = session(script, otherEnv, "ticket"); issued.child.stdin.end();
			assert.match(await issued.closed, /^ticket /);
		}
		const foreign = session(script, otherEnv, `stop ${old.ticket}`); foreign.child.stdin.end();
		assert.match(await foreign.closed, /^error /);
		assert.equal(await fs.readFile(marker, "utf8"), staleOwner);
		assert.ok(await fs.stat(path.join(root, "running")));
		await fs.writeFile(path.join(root, "allow-stop"), "");
		const retry = session(script, env, `stop ${old.ticket}`); retry.child.stdin.end();
		await waitFor(() => fs.stat(path.join(root, "stop-blocked")));
		fresh = session(script, env, "record");
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(await fs.readFile(marker, "utf8"), staleOwner);
		await fs.writeFile(path.join(root, "release-stop"), "");
		assert.equal(await retry.closed, receipt(old.ticket));
		await waitFor(async () => (await fs.readFile(marker, "utf8")) !== staleOwner);
		await waitFor(() => fs.stat(path.join(root, "running")));
		assert.notEqual(await fs.readFile(marker, "utf8"), staleOwner);
		const stop = session(script, env, `stop ${fresh.ticket}`); stop.child.stdin.end();
		assert.equal(await stop.closed, receipt(fresh.ticket));
	});
}

for (const script of ["client/pi-voice-stt-session", "client/pi-voice-termux-stt-session", "termux/pi-voice-stt-session"]) {
	test(`${script}: tickets are connection-bound, persistent, bounded and monotonic`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-tickets-"));
		const env = fixtureEnv(root);
		const connections: ReturnType<typeof session>[] = [];
		t.after(async () => {
			for (const connection of connections) connection.child.stdin.end();
			await Promise.all(connections.map(connection => connection.closed));
			await fs.rm(root, { recursive: true, force: true });
		});
		function connect(command: string) {
			const connection = session(script, env, command);
			connections.push(connection);
			return connection;
		}
		async function exchange(command: string) {
			const connection = connect(command); connection.child.stdin.end();
			return connection.closed;
		}
		const first = connect("ticket");
		await waitFor(async () => /^ticket [0-9a-f]{32}\.1 [0-9a-f-]{36}\n$/.test(first.output));
		const epoch = first.output.slice(7, 39);
		const handshake = (counter: number) => `ticket ${epoch}.${counter} ${BOOT}\n`;
		const linux = script === "client/pi-voice-stt-session";
		const lock = path.join(stateDir(root, script), "recording");
		const tickets = path.join(stateDir(root, script), linux ? "tickets" : "recording.tickets");
		const saved = (latest: number, watermark: number) => linux
			? `${BOOT} ${epoch} ${latest} ${watermark} 0 - idle\n`
			: `${epoch} ${latest} ${watermark} ${BOOT}\n`;
		const second = connect("ticket");
		await waitFor(async () => second.output === handshake(2));
		first.child.stdin.end(`record ${epoch}.1 ${BOOT}\n`);
		assert.equal(await first.closed, handshake(1), "superseded tickets cannot record");
		second.child.stdin.end(`record ${epoch}.1 ${BOOT}\n`);
		assert.equal(await second.closed, handshake(2), "ticket must match its connection");
		assert.match(await exchange(`record ${epoch}.2 ${BOOT}`), /^error /, "another connection cannot replay a ticket");
		for (const ticket of ["0", "3", "-1", "01", "1+1", "9007199254740992", "999999999999999999999999", "2 extra"]) {
			assert.match(await exchange(`stop ${ticket}`), /^error /);
		}
		assert.equal(await exchange(`stop ${epoch}.2`), receipt(`${epoch}.2`));
		assert.equal(await exchange(`stop ${epoch}.1`), receipt(`${epoch}.1`));
		assert.equal(await fs.readFile(tickets, "utf8"), saved(2, 2));
		const cancelled = connect("ticket");
		await waitFor(async () => cancelled.output === handshake(3));
		assert.equal(await exchange(`stop ${epoch}.3`), receipt(`${epoch}.3`));
		cancelled.child.stdin.end(`record ${epoch}.3 ${BOOT}\n`);
		assert.equal(await cancelled.closed, handshake(3), "watermark rejects even the latest ticket");
		// Termux ownerless recovery must never recursively delete an unexpected directory.
		if (!linux) {
			await fs.mkdir(lock);
			await fs.writeFile(path.join(lock, "keep"), "keep");
			const blocked = connect("record");
			assert.match(await blocked.closed, /^error /);
			assert.equal(await fs.readFile(path.join(lock, "keep"), "utf8"), "keep");
			await fs.rm(lock, { recursive: true });
		}
		await fs.writeFile(tickets, saved(9007199254740990, 2));
		assert.equal(await exchange("ticket"), handshake(9007199254740991));
		assert.match(await exchange("ticket"), /^error /, "ticket exhaustion must not wrap");
		assert.equal(await fs.readFile(tickets, "utf8"), saved(9007199254740991, 2));
		for (const reset of ["loss", "rollover"]) {
			// Restore known idle state solely to set up each independent corruption case.
			await fs.writeFile(tickets, saved(3, 3));
			const pending = connect("ticket");
			await waitFor(async () => pending.output === handshake(4));
			if (reset === "loss") await fs.rm(tickets);
			else await fs.writeFile(tickets, saved(100, 0).replace(epoch, "f".repeat(32)));
			assert.match(await exchange(`stop ${epoch}.4`), /^error /);
			pending.child.stdin.end(`record ${epoch}.4 ${BOOT}\n`);
			const rejected = await pending.closed;
			assert.ok(rejected.startsWith(handshake(4)));
			assert.ok(!rejected.includes("stream\n"), "reset between issuance and record fails closed");
			assert.match(await exchange(`stop ${epoch}.1`), /^error /);
			if (reset === "loss") {
				const issued = await exchange("ticket");
				if (linux) assert.match(issued, /^error /, "desktop state loss must not silently mint a new epoch");
				else {
					assert.match(issued, /^ticket [0-9a-f]{32}\.1 [0-9a-f-]{36}\n$/);
					assert.notEqual(issued.slice(7, 39), epoch, "idle Termux state loss creates a distinct epoch");
					assert.match(await exchange(`stop ${epoch}.1`), /^error /);
				}
			}
		}
		await fs.writeFile(tickets, saved(4, 4));
		for (const boot of ["", "00000000-0000-0000-0000-000000000000"]) {
			const pending = connect("ticket");
			await waitFor(async () => pending.output.startsWith("ticket "));
			const ticket = pending.output.split(" ")[1];
			const issued = pending.output;
			pending.child.stdin.end(`record ${ticket}${boot ? ` ${boot}` : ""}\n`);
			assert.equal(await pending.closed, issued, "record requires the issued boot as well as its ticket");
		}
	});
}
