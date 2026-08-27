import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";

const read = (path: string): string => fs.readFileSync(path, "utf8");

function documentedDefaults(markdown: string): Map<string, string> {
	return new Map(
		[...markdown.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|/gm)].map(match => [match[1]!, match[2]!]),
	);
}

test("README, example JSON, and configuration table match current defaults", () => {
	const defaults = { ...DEFAULT_VOICE_CONFIG } as Record<string, unknown>;
	const example = JSON.parse(read("pi-voice.example.json")) as Record<string, unknown>;
	assert.deepEqual(example, { ...defaults, enabled: true });

	const readme = read("README.md");
	const readmeBlock = /## Default configuration[\s\S]*?```json\n([\s\S]*?)\n```/.exec(readme)?.[1];
	assert.ok(readmeBlock, "README default configuration block is missing");
	assert.deepEqual(JSON.parse(readmeBlock), defaults);

	const table = documentedDefaults(read("docs/configuration.md"));
	for (const [setting, value] of Object.entries(defaults)) {
		assert.equal(table.get(setting), String(value), `docs/configuration.md default for ${setting}`);
	}

	assert.match(readme, /`Alt\+V` \| Re-anchor the current narrated position/);
	assert.match(readme, /`Alt\+T` \| Pin to and follow the transcript tail/);
	assert.match(read("docs/commands.md"), /\/voice code-retry current/);
	assert.match(read("docs/commands.md"), /\/voice code-retry historical/);
});
