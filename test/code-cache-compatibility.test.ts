import assert from "node:assert/strict";
import test from "node:test";
import { CodeDescriptionCache, type CodeDescriptionCacheSnapshot } from "../src/code-description-cache.js";
import { assistantCodeContext, legacyStructuredContextIdentity, structuredContextIdentity } from "../src/code-context.js";
import { codeDescriptionCacheKey } from "../src/code-describer.js";
import { plainCodeNarration } from "../src/code-narration.js";

test("lazy conversation-cache adoption preserves old source keys and legacy timing aliases across reload", async () => {
	const block = { language: "ts", code: "run();" };
	const code = "```ts\nrun();\n```\n";
	const assistant = { role: "assistant", content: [{ type: "text", text: code + "Explanation.\n```ts\nnext();\n```" }] };
	const messages = assistantCodeContext([], assistant, 0, code.length)!;
	const serialized = JSON.stringify(messages.map(({ role, content }) => ({ role, content })));
	assert.equal(legacyStructuredContextIdentity(messages), serialized);
	const keyFor = (context: string) => codeDescriptionCacheKey({} as never, block, "missing/model", "guided", context, "conversation");
	const oldSource = keyFor(serialized);
	const identity = keyFor(structuredContextIdentity(messages));
	const plan = plainCodeNarration("Runs the requested operation.");
	for (const key of [oldSource, "a".repeat(64)]) {
		const cache = new CodeDescriptionCache();
		cache.restore([{ version: 1, key, ...(key !== oldSource ? { identity: oldSource } : {}), plan }]);
		let lookups = 0;
		const saved: CodeDescriptionCacheSnapshot[] = [];
		const compatible = () => { lookups++; return [keyFor(legacyStructuredContextIdentity(messages))]; };
		assert.equal(cache.resolveKey(identity, compatible, snapshot => saved.push(snapshot)), key);
		assert.equal(cache.resolveKey(identity, compatible), key);
		assert.equal(lookups, 1);
		const reloaded = new CodeDescriptionCache();
		reloaded.restore(JSON.parse(JSON.stringify(saved)));
		assert.equal(reloaded.resolveKey(identity, () => { throw new Error("must stay lazy"); }), key);
		assert.deepEqual(await reloaded.getOrCreate(key, async () => { throw new Error("no provider request"); }), plan);
		const dependencies = new Map([[key, "existing timing measurement"]]);
		assert.equal(dependencies.get(reloaded.resolveKey(identity)), "existing timing measurement");
		assert.match(saved[0].identity!, /^[a-f0-9]{64}$/);
		assert.doesNotMatch(JSON.stringify(saved), /Explanation/);

		const changed = structuredClone(assistant);
		changed.content[0].text = code + "Genuinely different explanation.\n```ts\nnext();\n```";
		const different = assistantCodeContext([], changed, 0, code.length)!;
		const differentIdentity = keyFor(structuredContextIdentity(different));
		assert.notEqual(differentIdentity, identity);
		assert.equal(cache.resolveKey(differentIdentity, () => [keyFor(legacyStructuredContextIdentity(different))]), differentIdentity);
		assert.equal(cache.get(differentIdentity), undefined);
	}
});
