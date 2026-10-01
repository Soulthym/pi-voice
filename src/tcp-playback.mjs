import * as net from "node:net";
import { stopRemotePlayback, validStreamId, validBootId, RemotePlaybackUnconfirmedError } from "./remote-playback.mjs";

const [output, rate, utteranceValue] = process.argv.slice(2);
const utterance = Number(utteranceValue);
const endpoint = new URL(output);
if (!((endpoint.protocol === "tcp:" && endpoint.hostname && endpoint.port) ||
	(endpoint.protocol === "unix:" && !endpoint.hostname && endpoint.pathname.startsWith("/"))) ||
	!Number.isFinite(Number(rate)) || Number(rate) <= 0 || !Number.isInteger(utterance)) throw new Error("Invalid playback parameters");
const control = new net.Socket({ fd: 3, readable: true, writable: true });
const input = control;
control.on("error", fail);
let session;
let bootId;
let committed = false;
let audioAdmitted = false;
let negotiated = false;
let complete = false;
let stopping = false;
let stopSent = false;
let pendingPause = false;
let finished = false;
let failing = false;
let controlQueue = Promise.resolve();
let feedback = "";
let commands = "";
let renewalTimer;
let renewalPeer;
let leaseDeadline;
let leaseExpiresAt = 0;
function stopRenewal() {
	clearInterval(renewalTimer);
	clearTimeout(leaseDeadline);
	renewalPeer?.destroy();
	renewalPeer = undefined;
}
function armLease(elapsed = 0) {
	clearTimeout(leaseDeadline);
	leaseExpiresAt = performance.now() + 30_000 - elapsed;
	leaseDeadline = setTimeout(() => fail(new Error("Native playback lease expired")), Math.max(0, 30_000 - elapsed));
}
function renew() {
	if (stopping || failing || finished || complete || renewalPeer) return;
	if (performance.now() >= leaseExpiresAt) return fail(new Error("Native playback lease expired"));
	const sentAt = performance.now();
	const peer = renewalPeer = connect();
	let reply = "";
	let acknowledged = false;
	// Bound the whole exchange, not socket inactivity (a trickle is not a renewal).
	const timeout = setTimeout(() => peer.destroy(new Error("Native playback renewal timed out")), 5000);
	peer.on("connect", () => peer.end(`PI_VOICE_CONTROLrenew ${session} ${bootId}\n`));
	peer.on("data", chunk => {
		reply += chunk;
		if (reply.length > 8192) return peer.destroy(new Error("Invalid renewal response"));
		for (;;) {
			const end = reply.indexOf("\n");
			if (end < 0) break;
			try {
				const event = JSON.parse(reply.slice(0, end));
				if (event.type === "renewed" && event.id === session && event.boot_id === bootId) acknowledged = true;
			} catch {}
			reply = reply.slice(end + 1);
		}
	});
	peer.on("error", error => { if (!stopping && !complete && !finished && !failing) fail(error); });
	peer.on("close", () => {
		clearTimeout(timeout);
		if (renewalPeer !== peer) return; // A stopped/expired scope cannot be revived by a late ACK.
		renewalPeer = undefined;
		if (stopping || failing || finished || complete) return;
		if (performance.now() >= leaseExpiresAt) return fail(new Error("Native playback lease expired"));
		if (!acknowledged) fail(new Error("Missing scoped native renewal acknowledgment"));
		else armLease(performance.now() - sentAt);
	});
}
const connect = () => endpoint.protocol === "unix:"
	? net.createConnection({ path: decodeURIComponent(endpoint.pathname) })
	: net.createConnection({ host: endpoint.hostname.replace(/^\[|\]$/g, ""), port: Number(endpoint.port) });
const socket = connect();
// Independent wall-clock budgets include durable device/host writes, not just RTT.
// Only validated forward progress changes phase; trickled bytes never extend either cap.
const startupBudgets = { connection: 5_000, protocol: 5_000, prepare: 15_000, "host-grant": 15_000, "device-commit": 20_000, "native-binding": 10_000 };
let startupPhase = "connection";
let phaseDeadline;
const deadline = setTimeout(() => fail(new Error(`Audio client ${startupPhase} startup timed out (70000ms overall limit)`)), 70_000);
function enterPhase(phase) {
	startupPhase = phase;
	clearTimeout(phaseDeadline);
	phaseDeadline = setTimeout(() => fail(new Error(`Audio client ${phase} startup timed out after ${startupBudgets[phase]}ms`)), startupBudgets[phase]);
}
function clearStartup() { clearTimeout(deadline); clearTimeout(phaseDeadline); }
enterPhase("connection");
function finish(code) {
	if (finished) return;
	finished = true;
	stopRenewal();
	clearStartup();
	socket.destroy();
	process.exit(code);
}
function fail(error) {
	if (finished || failing) return;
	failing = true;
	stopRenewal();
	clearStartup();
	const detail = error instanceof Error ? error.message : String(error);
	if (audioAdmitted) error = new RemotePlaybackUnconfirmedError(detail);
	const message = error instanceof Error ? error.message : String(error);
	// No-audio admission evidence is not a remote player-exit receipt.
	if (!audioAdmitted) control.write("no-audio\n");
	control.write(`error ${detail}\n`);
	process.stdout.write(`${JSON.stringify({ type: "error", message, ...(audioAdmitted ? { code: error.code } : {}), utterance })}\n`, () => finish(audioAdmitted ? 1 : 2));
}
function command(command) {
	if (stopping && command !== "stop") return Promise.resolve();
	if (command === "stop") stopRenewal();
	if (!session) {
		if (command === "stop") stopping = true;
		return Promise.resolve();
	}
	if (command === "stop") {
		if (stopSent) return controlQueue;
		stopSent = true;
		// Stop owns its deadline even if cancelled during prepare/commit.
		clearStartup();
		return controlQueue = controlQueue.then(async () => {
			try {
				await stopRemotePlayback({ output, id: session, bootId, nativeWatchdog: true });
				process.stdout.write(`${JSON.stringify({ type: "remote-released", id: session })}\n`, () => finish(0));
			} catch (error) { fail(error); }
		});
	}
	return controlQueue = controlQueue.then(() => new Promise(resolve => {
		if (stopping || failing || finished) return resolve();
		const peer = connect();
		let reply = "";
		const timeout = setTimeout(() => peer.destroy(new Error("Remote playback control timed out")), 1500);
		peer.on("connect", () => peer.end(`PI_VOICE_CONTROL${command} ${session}\n`));
		peer.on("data", chunk => {
			reply += chunk;
			if (reply.length > 8192) return peer.destroy(new Error("Invalid playback control response"));
		});
		peer.on("error", error => { if (!stopSent) fail(error); });
		peer.on("close", () => { clearTimeout(timeout); resolve(); });
	}));
}
input.on("data", chunk => {
	commands += chunk;
	if (commands.length > 8192) return fail(new Error("Invalid host playback control"));
	for (;;) {
		const end = commands.indexOf("\n");
		if (end < 0) break;
		const value = commands.slice(0, end).trim();
		commands = commands.slice(end + 1);
		if (value === `grant ${session} ${bootId}` && session && !committed && !stopping && !failing) {
			committed = true;
			// Commit can open physical output even before PCM: death now needs a receipt.
			audioAdmitted = true;
			enterPhase("device-commit");
			socket.write(`PI_VOICE_COMMIT ${session} ${bootId}\n`);
			continue;
		}
		if (!["pause", "resume", "stop"].includes(value)) continue;
		if (value === "stop") stopping = true;
		else pendingPause = value === "pause";
		command(value);
	}
});
control.on("end", () => { stopping = true; void command("stop"); });
// This is an existing control header, not an audio probe. V1 safely ignores hello.
socket.on("connect", () => {
	enterPhase("protocol");
	socket.write("PI_VOICE_CONTROLhello\n");
});
socket.on("error", error => { if (!complete && !stopSent) fail(error); });
socket.on("data", chunk => {
	if (finished || failing) return;
	feedback += chunk;
	if (feedback.length > 8192) return fail(new Error("Invalid audio client feedback"));
	for (;;) {
		const end = feedback.indexOf("\n");
		if (end < 0) break;
		const line = feedback.slice(0, end);
		feedback = feedback.slice(end + 1);
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		if (!event || typeof event !== "object") continue;
		if (stopSent) continue; // Only the separate stop exchange can finish this scope.
		if (event.type === "error") {
			// This dedicated startup channel supplies correlation before a scope exists.
			// Once prepared, only the exact current scope/boot may report failures.
			if (session ? event.id !== session || event.boot_id !== bootId :
				(event.id !== undefined && !validStreamId(event.id)) || (event.boot_id !== undefined && !validBootId(event.boot_id))) continue;
			if (typeof event.message !== "string" || !/^[\x20-\x7e]{1,512}$/.test(event.message) ||
				(event.phase !== undefined && (typeof event.phase !== "string" || !/^[a-z-]{1,64}$/.test(event.phase)))) return fail(new Error(`Invalid audio client error during ${startupPhase}`));
			return fail(new Error(`Audio client ${event.phase ?? startupPhase}: ${event.message}`));
		}
		if (event.type === "phase" && committed && startupPhase === "device-commit" && event.id === session && event.boot_id === bootId && event.phase === "native-binding") {
			enterPhase("native-binding");
		} else if (!negotiated && event.type === "protocol") {
			if (event.version !== 4 || event.native_watchdog !== true || event.lease_seconds !== 30) return fail(new Error("Audio client requires v4 native watchdog with a 30-second lease; upgrade the client"));
			negotiated = true;
			enterPhase("prepare");
			socket.write("PI_VOICE_PREPARE 4\n");
		} else if (negotiated && event.type === "prepared") {
			if (session || event.version !== 4 || event.native_watchdog !== true || event.lease_seconds !== 30 || !validStreamId(event.id) || !validBootId(event.boot_id)) return fail(new Error("Invalid prepared output scope or kernel boot ID"));
			session = event.id;
			bootId = event.boot_id;
			enterPhase("host-grant");
			// Missing identity must not collide with any valid registered ID (including "-").
			const deviceId = typeof event.device_id === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(event.device_id) ? event.device_id : ":";
			control.write(`prepared ${session} ${bootId} ${event.boot_fenced === true ? "fenced" : "unfenced"} ${deviceId} native-watchdog\n`);
			if (stopping) void command("stop");
		} else if (negotiated && event.type === "session") {
			if (!committed || renewalTimer || event.version !== 4 || event.id !== session || event.boot_id !== bootId) return fail(new Error("Output commit identity mismatch"));
			clearStartup();
			startupPhase = "playback";
			if (stopping) command("stop");
			else {
				armLease();
				renewalTimer = setInterval(renew, 5000);
				const start = () => {
					if (stopping || finished || failing) return;
					// Physical dispatch was already journaled before commit.
					control.write("ready\n");
					process.stdin.pipe(socket);
				};
				if (pendingPause) void command("pause").then(start);
				else start();
			}
		} else if (session && event.type === "complete" && event.id === session && event.boot_id === bootId) {
			complete = true;
			stopRenewal();
		} else if (session && event.type === "playback" && Number.isFinite(event.position) && event.position >= 0) {
			process.stdout.write(`${JSON.stringify({ type: "playback", position: event.position, utterance })}\n`);
		}
	}
});
socket.on("close", () => {
	stopRenewal();
	if (stopping) return; // Only the separate stop receipt proves remote termination.
	if (complete) process.stdout.write(`${JSON.stringify({ type: "remote-released", id: session })}\n`, () => finish(0));
	else fail(new Error(`Audio client connection closed during ${renewalTimer ? "playback" : startupPhase} without readiness/completion proof (no replay)`));
});
process.stdin.on("error", fail);
