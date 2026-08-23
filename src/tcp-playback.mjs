import * as fs from "node:fs";
import * as net from "node:net";

const [output, sampleRateValue, utteranceValue] = process.argv.slice(2);
const sampleRate = Number(sampleRateValue);
const utterance = Number(utteranceValue);
const control = fs.createWriteStream(null, { fd: 3, autoClose: false });
const controlInput = fs.createReadStream(null, { fd: 3, autoClose: false });
let stopped = false;
let startedAt = null;
let pausedAt = null;
let pausedDuration = 0;
let clientSessionId;
let pendingControl;
let lastFeedbackAt = performance.now();
let samplesWritten = 0;
let feedback = "";

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function controlLine(line) {
	try {
		control.write(`${line.replace(/\r?\n/g, " ")}\n`);
	} catch {
		// The parent may have already stopped the playback helper.
	}
}

function fail(error) {
	if (stopped) return;
	stopped = true;
	const message = error instanceof Error ? error.message : String(error);
	controlLine(`error ${message}`);
	send({ type: "error", message });
	process.exitCode = 1;
}

let endpoint;
try {
	endpoint = new URL(output);
	if (
		!((endpoint.protocol === "tcp:" && endpoint.hostname && endpoint.port) ||
			(endpoint.protocol === "unix:" && !endpoint.hostname && endpoint.pathname.startsWith("/")))
	) {
		throw new Error(`Invalid network output: ${output}`);
	}
	if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isInteger(utterance)) {
		throw new Error("Invalid TCP playback parameters");
	}
} catch (error) {
	fail(error);
	process.exit(1);
}

function connectEndpoint() {
	return endpoint.protocol === "unix:"
		? net.createConnection({ path: decodeURIComponent(endpoint.pathname) })
		: net.createConnection({
				host: endpoint.hostname.replace(/^\[|\]$/g, ""),
				port: Number(endpoint.port),
			});
}

function sendPlaybackControl(command) {
	if (!clientSessionId) {
		pendingControl = command;
		return;
	}
	const commandSocket = connectEndpoint();
	commandSocket.on("connect", () => {
		commandSocket.end(`PI_VOICE_CONTROL${command} ${clientSessionId}\n`);
	});
	commandSocket.on("error", () => {});
}

let controlCommands = "";
controlInput.on("data", chunk => {
	controlCommands += String(chunk);
	for (;;) {
		const newline = controlCommands.indexOf("\n");
		if (newline < 0) break;
		const command = controlCommands.slice(0, newline).trim();
		controlCommands = controlCommands.slice(newline + 1);
		if (command !== "pause" && command !== "resume") continue;
		const now = performance.now();
		if (command === "pause" && pausedAt === null) pausedAt = now;
		if (command === "resume" && pausedAt !== null) {
			pausedDuration += now - pausedAt;
			pausedAt = null;
		}
		sendPlaybackControl(command);
	}
});

const socket = connectEndpoint();
socket.setNoDelay(true);

const timer = setInterval(() => {
	if (startedAt === null || performance.now() - lastFeedbackAt < 750) return;
	const now = performance.now();
	const paused = pausedDuration + (pausedAt === null ? 0 : now - pausedAt);
	const position = Math.min((now - startedAt - paused) / 1_000, samplesWritten / sampleRate);
	send({ type: "playback", utterance, position, estimated: true });
}, 125);
timer.unref?.();

process.stdin.on("data", chunk => {
	if (startedAt === null) startedAt = performance.now();
	samplesWritten += Math.floor(chunk.length / Float32Array.BYTES_PER_ELEMENT);
});
process.stdin.on("error", fail);
process.stdin.on("end", () => socket.end());

socket.on("connect", () => {
	controlLine("ready");
	process.stdin.pipe(socket, { end: false });
});

socket.on("data", chunk => {
	feedback = `${feedback}${String(chunk)}`.slice(-8_192);
	for (;;) {
		const newline = feedback.indexOf("\n");
		if (newline < 0) break;
		const line = feedback.slice(0, newline);
		feedback = feedback.slice(newline + 1);
		try {
			const event = JSON.parse(line);
			if (event.type === "session" && typeof event.id === "string") {
				clientSessionId = event.id;
				if (pendingControl) {
					const command = pendingControl;
					pendingControl = undefined;
					sendPlaybackControl(command);
				}
				continue;
			}
			const position = Number(event.position);
			if (event.type === "playback" && Number.isFinite(position) && position >= 0) {
				lastFeedbackAt = performance.now();
				send({ type: "playback", utterance, position });
			}
		} catch {
			// Ignore malformed feedback from an interrupted phone session.
		}
	}
});

socket.on("error", fail);
socket.on("close", () => {
	clearInterval(timer);
	process.stdin.destroy();
	control.end();
	if (!stopped) process.exitCode = 0;
});
