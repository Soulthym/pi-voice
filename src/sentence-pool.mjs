import { fork } from "node:child_process";

/** CPU model processes; callers bound lookahead, not just in-flight inference. */
export class SentencePool {
	#workers = [];
	#queue = [];
	#nextId = 0;
	#closed = false;
	constructor(size = 3, onEvent = () => {}) { this.onEvent = onEvent; this.resize(size); }

	resize(size) {
		if (!Number.isInteger(size) || size < 1 || size > 8) throw new RangeError("Sentence workers must be 1–8");
		this.size = size;
		this.#pump();
	}

	generate(operation) {
		if (this.#closed) return Promise.reject(new Error("Sentence pool closed"));
		return new Promise((resolve, reject) => {
			this.#queue.push({ id: ++this.#nextId, operation, resolve, reject });
			this.#pump();
		});
	}

	#spawn() {
		const child = fork(new URL("./worker.mjs", import.meta.url), [], {
			serialization: "advanced", execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"],
			env: { ...process.env, PI_VOICE_SENTENCE_CHILD: "1" },
		});
		const slot = { child, job: undefined };
		this.#workers.push(slot);
		child.on("message", message => {
			if (!this.#workers.includes(slot)) return;
			if (message.event) { if (slot.job) this.onEvent(message.event); return; }
			const job = slot.job;
			if (!job || message.id !== job.id) return;
			slot.job = undefined;
			if (message.error) job.reject(new Error(message.error)); else job.resolve(message.audio);
			this.#pump();
		});
		const failed = error => {
			if (!this.#workers.includes(slot)) return;
			this.#workers.splice(this.#workers.indexOf(slot), 1);
			slot.job?.reject(error);
			slot.job = undefined;
			child.kill("SIGKILL");
			this.#pump();
		};
		slot.fail = failed;
		child.on("error", failed);
		child.on("exit", (code, signal) => failed(new Error(`Sentence worker exited (${signal ?? code})`)));
		return slot;
	}

	#pump() {
		// Retire only idle models; already-started synthesis keeps its ordered result.
		for (const slot of [...this.#workers]) {
			if (this.#workers.length <= this.size) break;
			if (slot.job) continue;
			this.#workers.splice(this.#workers.indexOf(slot), 1);
			slot.child.kill("SIGKILL");
		}
		while (!this.#closed && this.#queue.length) {
			if (this.#workers.length > this.size) return;
			let slot = this.#workers.find(worker => !worker.job);
			if (!slot && this.#workers.length < this.size) {
				try { slot = this.#spawn(); }
				catch (error) { this.#queue.shift().reject(error); continue; }
			}
			if (!slot) return;
			const job = this.#queue.shift();
			slot.job = job;
			try {
				slot.child.send({ id: job.id, operation: job.operation }, error => {
					if (error && slot.job === job) {
						slot.fail(error);
					}
				});
			} catch (error) { slot.fail(error); }
		}
	}

	cancel() {
		const error = new Error("Sentence generation cancelled");
		for (const job of this.#queue.splice(0)) job.reject(error);
		for (const slot of [...this.#workers]) {
			if (!slot.job) continue; // Retain idle warm models.
			this.#workers.splice(this.#workers.indexOf(slot), 1);
			slot.job.reject(error);
			slot.job = undefined;
			slot.child.kill("SIGKILL");
		}
	}

	close() {
		this.#closed = true;
		this.cancel();
		for (const slot of this.#workers.splice(0)) slot.child.kill("SIGKILL");
	}
}
