import * as net from "node:net";
import { validStreamId, RemotePlaybackUnconfirmedError } from "./remote-playback.mjs";

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
let audioAdmitted = false;
let negotiated = false;
let complete = false;
let stopping = false;
let pendingPause = false;
let finished = false;
let failing = false;
let controlQueue = Promise.resolve();
let feedback = "";
let commands = "";
const connect = () => endpoint.protocol === "unix:"
	? net.createConnection({ path: decodeURIComponent(endpoint.pathname) })
	: net.createConnection({ host: endpoint.hostname.replace(/^\[|\]$/g, ""), port: Number(endpoint.port) });
const socket = connect();
const deadline = setTimeout(() => fail(new Error("Audio client v2 session readiness timed out; upgrade the client")), 5000);
function finish(code) {
	if (finished) return;
	finished = true;
	clearTimeout(deadline);
	socket.destroy();
	process.exit(code);
}
function fail(error) {
	if (finished || failing) return;
	failing = true;
	const detail = error instanceof Error ? error.message : String(error);
	if (audioAdmitted) error = new RemotePlaybackUnconfirmedError(detail);
	const message = error instanceof Error ? error.message : String(error);
	// No-audio admission evidence is not a remote player-exit receipt.
	if (!audioAdmitted) control.write("no-audio\n");
	control.write(`error ${detail}\n`);
	process.stdout.write(`${JSON.stringify({ type: "error", message, ...(audioAdmitted ? { code: error.code } : {}), utterance })}\n`, () => finish(audioAdmitted ? 1 : 2));
}
function command(command) {
	if (!session) {
		if (command === "stop") stopping = true;
		return Promise.resolve();
	}
	return controlQueue = controlQueue.then(() => new Promise(resolve => {
		const peer = connect();
		let reply = "";
		let ack = false;
		peer.setTimeout(1500, () => peer.destroy(new Error("Remote playback control timed out")));
		peer.on("connect", () => peer.end(`PI_VOICE_CONTROL${command} ${session}\n`));
		peer.on("data", chunk => {
			reply += chunk;
			if (reply.length > 8192) return peer.destroy(new Error("Invalid playback control response"));
			for (;;) {
				const end = reply.indexOf("\n");
				if (end < 0) break;
				try {
					const event = JSON.parse(reply.slice(0, end));
					if (event.type === "stopped" && event.id === session) ack = true;
				} catch {}
				reply = reply.slice(end + 1);
			}
		});
		peer.on("error", error => { if (!ack || command !== "stop") fail(error); });
		peer.on("close", () => {
			resolve();
			if (command !== "stop") return;
			if (ack) {
				process.stdout.write(`${JSON.stringify({ type: "remote-released", id: session })}\n`, () => finish(0));
			}
			else fail(new Error("Remote stop unconfirmed: missing player-exit ACK"));
		});
	}));
}
input.on("data", chunk => {
	commands += chunk;
	for (;;) {
		const end = commands.indexOf("\n");
		if (end < 0) break;
		const value = commands.slice(0, end).trim();
		commands = commands.slice(end + 1);
		if (!["pause", "resume", "stop"].includes(value)) continue;
		if (value === "stop") stopping = true;
		else pendingPause = value === "pause";
		command(value);
	}
});
// This is an existing control header, not an audio probe. V1 safely ignores hello.
socket.on("connect", () => socket.write("PI_VOICE_CONTROLhello\n"));
socket.on("error", error => { if (!complete) fail(error); });
socket.on("data", chunk => {
	feedback += chunk;
	if (feedback.length > 8192) return fail(new Error("Invalid audio client feedback"));
	for (;;) {
		const end = feedback.indexOf("\n");
		if (end < 0) break;
		const line = feedback.slice(0, end);
		feedback = feedback.slice(end + 1);
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		if (!negotiated && event.type === "protocol" && event.version === 2) {
			negotiated = true;
			socket.write("PI_VOICE_AUDIO\n");
		} else if (negotiated && event.type === "session") {
			if (session || event.version !== 2 || !validStreamId(event.id)) return fail(new Error("Audio client requires opaque v2 stream IDs; upgrade the client and host"));
			session = event.id;
			control.write(`session ${session}\n`);
			process.stdout.write(`${JSON.stringify({ type: "remote-handle", output, id: session, utterance })}\n`);
			clearTimeout(deadline);
			if (stopping) command("stop");
			else {
				const start = () => {
					if (stopping || finished || failing) return;
					audioAdmitted = true;
					// Flush the retained identity before admitting PCM, including if the helper dies.
					process.stdout.write("", () => {
						if (stopping || finished || failing) return;
						control.write("ready\n");
						process.stdin.pipe(socket);
					});
				};
				if (pendingPause) void command("pause").then(start);
				else start();
			}
		} else if (session && event.type === "complete" && event.id === session) {
			complete = true;
		} else if (session && event.type === "playback" && Number.isFinite(event.position) && event.position >= 0) {
			process.stdout.write(`${JSON.stringify({ type: "playback", position: event.position, utterance })}\n`);
		}
	}
});
socket.on("close", () => {
	if (stopping) return; // Only the separate stop receipt proves remote termination.
	if (complete) process.stdout.write(`${JSON.stringify({ type: "remote-released", id: session })}\n`, () => finish(0));
	else fail(new Error("Audio client closed without v2 readiness/completion proof; upgrade client or repair forwarding (no replay)"));
});
process.stdin.on("error", fail);
