import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { PhoneInputClient } from "../src/phone-input.js";

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
			const match = /^ticket ([0-9a-f]{32}\.[1-9][0-9]*)\n/.exec(output);
			if (!match) return;
			ticket = match[1];
			admission = false;
			output = output.slice(match[0].length);
			child.stdin.write(`record ${match[1]}\n`);
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
-f) printf 'fake audio' > "$2"; touch "$TMPDIR/running";;
esac`,
		};
		for (const [name, body] of Object.entries(tools)) await fs.writeFile(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
		const env = { ...process.env, PREFIX: "", PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root, XDG_RUNTIME_DIR: root, PI_VOICE_MAX_RECORD_SECONDS: "5" };
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
			stop.stdin.end(`stop ${output.split("\n")[0].slice(7)}\n`);
			await new Promise(resolve => setTimeout(resolve, 50));
			assert.equal(ack, "", "must not acknowledge the stop request before stopping");
			await stopped;
			assert.equal(ack, receipt(output.split("\n")[0].slice(7)));
			assert.equal(await fs.stat(path.join(root, "running")).catch(() => false), false);
		}
		await closed;
		assert.match(output, /^ticket [0-9a-f]{32}\.1\nstream\n/);
		assert.equal(await fs.stat(path.join(root, "running")).catch(() => false), false);
	});
}

for (const script of ["client/pi-voice-stt-session", "client/pi-voice-termux-stt-session", "termux/pi-voice-stt-session"]) test(`${script}: reassigned generic bridge cannot release the host's origin ticket`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-reassigned-"));
	const other = path.join(root, "other"); await fs.mkdir(other);
	const env = { ...process.env, PREFIX: "", PATH: "/usr/bin:/bin", TMPDIR: root, XDG_RUNTIME_DIR: root };
	const otherEnv = { ...env, TMPDIR: other, XDG_RUNTIME_DIR: other };
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
				child.stdout.once("data", data => { ticket = String(data).trim().slice(7); socket.write(data); });
				child.stdin.write("ticket\n");
				// Hold before record/admission: exercise real ticket state without any hardware.
				socket.once("data", data => { assert.equal(String(data), `record ${ticket}\n`); recorded.resolve(); });
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

for (const script of ["client/pi-voice-termux-stt-session", "termux/pi-voice-stt-session"]) test(`${script}: an unconfirmed Android stop retains the recording marker`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-recorder-failure-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const bin = path.join(root, "bin"); await fs.mkdir(bin);
	await fs.writeFile(path.join(bin, "termux-microphone-record"), `#!/bin/bash
case "$1" in
-f) printf 'fake audio' > "$2"; touch "$TMPDIR/running";;
-q) exit 0;;
-i) printf '{"isRecording":true}';;
esac
`, { mode: 0o755 });
	const child = spawn("bash", [path.resolve(script)], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root } });
	child.stdout.resume(); child.stderr.resume();
	const closed = new Promise<number | null>(resolve => child.once("close", resolve));
	child.stdin.write("ticket\n");
	child.stdout.once("data", chunk => child.stdin.write(`record ${String(chunk).trim().slice(7)}\n`));
	await waitFor(() => fs.stat(path.join(root, "running")));
	child.stdin.end();
	assert.equal(await closed, 1);
	assert.ok(await fs.stat(path.join(root, "pi-voice-recording-active")));
	assert.ok(await fs.stat(path.join(root, "pi-voice-recording-lock")));
});

for (const script of ["client/pi-voice-stt-session", "client/pi-voice-termux-stt-session", "termux/pi-voice-stt-session"]) {
	for (const block of ["pending", "admission", "mkdir-crash", ...(script === "client/pi-voice-stt-session" ? ["help"] : [])]) test(`${script}: ${block} cancellation and delayed stop preserve a newer generation`, async t => {
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
-f) touch "$TMPDIR/running"; printf audio > "$2";;
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
mkdir() {
  builtin command mkdir "$@" || return
  if [[ \${BLOCK_CHECK:-} == mkdir-crash && $* == *recording-lock ]]; then
    touch "$TMPDIR/check-blocked"
    kill -KILL "$BASHPID"
  fi
}\n`);
		const env = { ...process.env, PREFIX: "", BASH_ENV: hook, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root, XDG_RUNTIME_DIR: root, PI_VOICE_MAX_RECORD_SECONDS: "5" };
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
		const marker = path.join(root, linux ? `pi-voice-client-${process.getuid!()}/recording-active` : "pi-voice-recording-active");
		const owner = await fs.readFile(marker, "utf8");
		assert.match(owner, /^[0-9a-f]{32}\.2:[0-9]+\n$/);
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
-f) printf audio > "$2"; touch "$TMPDIR/running";;
-q) if [[ -e "$TMPDIR/allow-stop" ]]; then
      touch "$TMPDIR/stop-blocked"
      while [[ ! -e "$TMPDIR/release-stop" ]]; do sleep 0.01; done
      rm -f "$TMPDIR/running"
    fi;;
-i) if [[ -e "$TMPDIR/running" ]]; then printf '{"isRecording":true}'; else printf '{"isRecording":false}'; fi;;
esac\n`, { mode: 0o755 });
		const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root, PI_VOICE_MAX_RECORD_SECONDS: "5" };
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
		const marker = path.join(root, "pi-voice-recording-active");
		const staleOwner = await fs.readFile(marker, "utf8");
		// First explicit retry still cannot confirm: retain the lease, never fake ACK.
		const failed = session(script, env, `stop ${old.ticket}`); failed.child.stdin.end();
		assert.match(await failed.closed, /^error /);
		assert.equal(await fs.readFile(marker, "utf8"), staleOwner);
		// A forwarded endpoint reassigned to B must not confirm A, even at a higher counter.
		const otherRoot = path.join(root, "other"); await fs.mkdir(otherRoot);
		const otherEnv = { ...env, TMPDIR: otherRoot };
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
		const env = { ...process.env, PREFIX: "", PATH: "/usr/bin:/bin", TMPDIR: root, XDG_RUNTIME_DIR: root };
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
		await waitFor(async () => /^ticket [0-9a-f]{32}\.1\n$/.test(first.output));
		const epoch = first.output.slice(7, 39);
		const second = connect("ticket");
		await waitFor(async () => second.output === `ticket ${epoch}.2\n`);
		first.child.stdin.end(`record ${epoch}.1\n`);
		assert.equal(await first.closed, `ticket ${epoch}.1\n`, "superseded tickets cannot record");
		second.child.stdin.end(`record ${epoch}.1\n`);
		assert.equal(await second.closed, `ticket ${epoch}.2\n`, "ticket must match its connection");
		assert.match(await exchange(`record ${epoch}.2`), /^error /, "another connection cannot replay a ticket");
		for (const ticket of ["0", "3", "-1", "01", "1+1", "9007199254740992", "999999999999999999999999", "2 extra"]) {
			assert.match(await exchange(`stop ${ticket}`), /^error /);
		}
		assert.equal(await exchange(`stop ${epoch}.2`), receipt(`${epoch}.2`));
		assert.equal(await exchange(`stop ${epoch}.1`), receipt(`${epoch}.1`));
		const lock = path.join(root, script === "client/pi-voice-stt-session"
			? `pi-voice-client-${process.getuid!()}/recording-lock` : "pi-voice-recording-lock");
		assert.equal(await fs.readFile(`${lock}.tickets`, "utf8"), `${epoch} 2 2\n`);
		const cancelled = connect("ticket");
		await waitFor(async () => cancelled.output === `ticket ${epoch}.3\n`);
		assert.equal(await exchange(`stop ${epoch}.3`), receipt(`${epoch}.3`));
		cancelled.child.stdin.end(`record ${epoch}.3\n`);
		assert.equal(await cancelled.closed, `ticket ${epoch}.3\n`, "watermark rejects even the latest ticket");
		// Ownerless recovery must never recursively delete an unexpected directory.
		await fs.mkdir(lock);
		await fs.writeFile(path.join(lock, "keep"), "keep");
		const blocked = connect("record");
		assert.match(await blocked.closed, /^error /);
		assert.equal(await fs.readFile(path.join(lock, "keep"), "utf8"), "keep");
		await fs.writeFile(`${lock}.tickets`, `${epoch} 9007199254740990 2\n`);
		assert.equal(await exchange("ticket"), `ticket ${epoch}.9007199254740991\n`);
		assert.match(await exchange("ticket"), /^error /, "ticket exhaustion must not wrap");
		assert.equal(await fs.readFile(`${lock}.tickets`, "utf8"), `${epoch} 9007199254740991 2\n`);
		for (const reset of ["loss", "rollover"]) {
			await fs.rm(`${lock}.tickets`, { force: true });
			const pending = connect("ticket");
			await waitFor(async () => pending.output.startsWith("ticket "));
			const ticket = pending.output.trim().slice(7);
			assert.notEqual(ticket.split(".")[0], epoch);
			if (reset === "loss") await fs.rm(`${lock}.tickets`);
			else await fs.writeFile(`${lock}.tickets`, `${"f".repeat(32)} 100 0\n`);
			assert.match(await exchange(`stop ${ticket}`), /^error /);
			pending.child.stdin.end(`record ${ticket}\n`);
			assert.equal(await pending.closed, `ticket ${ticket}\n`, "reset between issuance and record fails closed");
			assert.match(await exchange(`stop ${epoch}.1`), /^error /);
		}

	});
}
