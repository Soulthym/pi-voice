import assert from "node:assert/strict";
import test from "node:test";

const native = await import(process.env.PI_VOICE_TEST_TUI_MODULE ?? "@earendil-works/pi-tui");
const { KeybindingsManager } = await import(process.env.PI_VOICE_TEST_KEYBINDINGS_MODULE ??
	"../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js");

test("native Alt+D is forward-delete-word, Alt+Delete remains its alternative", () => {
	const defaults = new KeybindingsManager().getEffectiveConfig();
	assert.deepEqual(defaults["tui.editor.deleteWordForward"], ["alt+d", "alt+delete"]);
	assert.ok(native.matchesKey("\x1bd", "alt+d"));
});

test("native F4/F5 decoding and default bindings leave Voice keys available", () => {
	// No create(): it would read personal keybindings.json.
	const defaults = new KeybindingsManager().getEffectiveConfig();
	for (const key of ["f4", "f5"]) {
		assert.ok(!Object.values(defaults).flat().includes(key), `${key} conflicts with a native default`);
	}
	for (const [key, sequences] of [
		["f4", ["\x1bOS", "\x1b[14~", "\x1b[[D"]],
		["f5", ["\x1b[15~", "\x1b[[E"]],
	] as const) {
		for (const sequence of sequences) {
			assert.equal(native.parseKey(sequence), key);
			assert.ok(native.matchesKey(sequence, key));
			assert.ok(!native.matchesKey(sequence, key === "f4" ? "f5" : "f4"));
		}
	}
});
