import assert from "node:assert/strict";
import test from "node:test";
import { resolveCurrentConnection } from "../src/connection-device.js";

const env = { TMUX: "/tmp/test-tmux/socket,99,0", TMUX_PANE: "%7", PI_VOICE_DEVICE_ID: "startup-A" };
const stat = (start = "123") => `42 (tmux client) ${["S", ...Array(18).fill("0"), start].join(" ")}`;
function fixture() {
	const calls: string[][] = [];
	let panes = "$0\t%7\n$1\t%7\n$2\t%9\n";
	let clients = "$1\t42\t100\t/dev/pts/4\n$2\t88\t100\t/dev/pts/8\n";
	let environ = "PI_VOICE_DEVICE_ID=current-B\0PI_VOICE_DEVICE_TARGET=target-b\0SECRET=do-not-use\0";
	let reads = 0;
	return {
		calls,
		setClients: (value: string) => { clients = value; },
		setPanes: (value: string) => { panes = value; },
		setEnvironment: (value: string) => { environ = value; },
		io: {
			tmux: async (args: string[]) => {
				calls.push(args);
				assert.deepEqual(args.slice(0, 2), ["-S", "/tmp/test-tmux/socket"]);
				return args[2] === "list-panes" ? panes : clients;
			},
			read: async (file: string) => {
				reads++;
				assert.match(file, /^\/proc\/42\/(stat|environ)$/);
				return file.endsWith("stat") ? stat() : environ;
			},
		},
		readCount: () => reads,
	};
}

test("fresh linked-session attachment B replaces stale Pi environment A, with explicit socket/pane and revalidation", async () => {
	const f = fixture();
	assert.deepEqual(await resolveCurrentConnection(env, f.io), { kind: "device", id: "current-B", target: "target-b" });
	assert.equal(f.calls.length, 4);
	assert.equal(f.readCount(), 3);
});

test("ambiguity includes clients in any session sharing the pane, never last activity", async () => {
	const f = fixture();
	f.setClients("$0\t41\t101\t/dev/pts/3\n$1\t42\t100\t/dev/pts/4\n");
	await assert.rejects(resolveCurrentConnection(env, f.io), { code: "ambiguous_attachment" });
	assert.equal(f.readCount(), 0);
});

test("no attachment, missing identity/proc, malformed context, and unresolved nesting all fail closed", async () => {
	const f = fixture();
	f.setClients("");
	await assert.rejects(resolveCurrentConnection(env, f.io), { code: "attachment_unavailable" });
	f.setClients("$1\t42\t100\t/dev/pts/4\n");
	f.setEnvironment("PI_VOICE_DEVICE_ID=B\0");
	await assert.rejects(resolveCurrentConnection(env, f.io), { code: "missing_identity" });
	f.setEnvironment("PI_VOICE_DEVICE_TARGET=target-b\0");
	await assert.rejects(resolveCurrentConnection(env, f.io), { code: "missing_identity" });
	f.setEnvironment("PI_VOICE_DEVICE_ID=B\0PI_VOICE_DEVICE_TARGET=t\0TMUX=/outer,1,0\0");
	await assert.rejects(resolveCurrentConnection(env, f.io), { code: "attachment_unavailable" });
	await assert.rejects(resolveCurrentConnection(env, { ...f.io, read: async () => { throw new Error("EACCES"); } }), { code: "attachment_unavailable" });
	await assert.rejects(resolveCurrentConnection({ ...env, TMUX_PANE: undefined }, f.io), { code: "attachment_unavailable" });
});

test("detach, attachment replacement and reused PID during identity read are rejected", async () => {
	for (const change of ["detach", "replace", "pid-reuse", "membership"] as const) {
		const f = fixture();
		const read = f.io.read;
		let readIdentity = false;
		f.io.read = async file => {
			if (file.endsWith("environ")) {
				readIdentity = true;
				if (change === "detach") f.setClients("");
				if (change === "replace") f.setClients("$1\t43\t101\t/dev/pts/5\n");
				if (change === "membership") f.setPanes("$1\t%7\n");
			} else if (readIdentity && change === "pid-reuse") return stat("124");
			return read(file);
		};
		await assert.rejects(resolveCurrentConnection(env, f.io), { code: change === "detach" ? "attachment_unavailable" : "attachment_changed" });
	}
});

test("continuing direct SSH accepts wrapper identity; genuinely local context is intentional, not a missing-device error", async () => {
	assert.deepEqual(await resolveCurrentConnection({ SSH_CONNECTION: "connection", PI_VOICE_DEVICE_ID: "A", PI_VOICE_DEVICE_TARGET: "target" }), { kind: "device", id: "A", target: "target" });
	assert.deepEqual(await resolveCurrentConnection({}), { kind: "intentional_local" });
	await assert.rejects(resolveCurrentConnection({ SSH_CONNECTION: "connection" }), { code: "missing_identity" });
});
