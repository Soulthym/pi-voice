import assert from "node:assert/strict";
import test from "node:test";
import { supportsInteractiveVoice } from "../src/session-mode.js";

test("enables project speech only for interactive TUI sessions", () => {
	assert.equal(supportsInteractiveVoice("tui"), true);
	assert.equal(supportsInteractiveVoice("rpc"), false);
	assert.equal(supportsInteractiveVoice("json"), false);
});
