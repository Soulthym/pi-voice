// Display-only grammar. Never use this in an editing-model request.
type Expression = string | { sequence: Expression[] } | { alternatives: Expression[] };

const sequence = (parts: Expression[]): Expression => parts.length === 1 ? parts[0]! : { sequence: parts };
const literal = (tokens: string[]): Expression => tokens.join("");

/** Match nested choices without enumerating their Cartesian product. */
function covers(expression: Expression, text: string): boolean {
	const match = (node: Expression, start: number): number[] => {
		if (typeof node === "string") return text.startsWith(node, start) ? [start + node.length] : [];
		if ("alternatives" in node) return [...new Set(node.alternatives.flatMap(part => match(part, start)))];
		let positions = [start];
		for (const part of node.sequence) positions = [...new Set(positions.flatMap(position => match(part, position)))];
		return positions;
	};
	return match(expression, 0).includes(text.length);
}

function factor(rows: string[][]): Expression {
	if (rows.length === 1) return literal(rows[0]!);
	const first = rows[0]!;
	let prefix = 0;
	while (prefix < first.length && rows.every(row => row[prefix] === first[prefix])) prefix++;
	let suffix = 0;
	while (suffix < first.length - prefix && rows.every(row => row.length - prefix > suffix && row.at(-1 - suffix) === first.at(-1 - suffix))) suffix++;
	if (prefix || suffix) return sequence([
		literal(first.slice(0, prefix)),
		factor(rows.map(row => row.slice(prefix, suffix ? -suffix : undefined))),
		literal(suffix ? first.slice(-suffix) : []),
	]);
	if (rows.every(row => row.length === 0)) return "";

	// Prefer a shared phrase to isolated matching words. Whitespace alone is not an anchor.
	// ponytail: exhaustive phrase search is bounded; very long dictation keeps prefix/suffix sharing.
	// Use a suffix index if compacting >256-token divergent utterances becomes necessary.
	let anchor: string[] = [];
	let offsets: number[] = [];
	if (rows.every(row => row.length <= 256)) {
		for (let start = 0; start < first.length; start++) {
			if (!first[start]!.trim()) continue;
			let matches = rows.map(row => row.flatMap((token, index) => token === first[start] ? [index] : []));
			for (let length = 1; start + length <= first.length && matches.every(indices => indices.length); length++) {
				if (first[start + length - 1]!.trim() && length > anchor.length) {
					anchor = first.slice(start, start + length);
					offsets = matches.map(indices => indices[0]!);
				}
				matches = matches.map((indices, rowIndex) => indices.filter(index => rows[rowIndex]![index + length] === first[start + length]));
			}
		}
	}
	if (anchor.length) return sequence([
		factor(rows.map((row, index) => row.slice(0, offsets[index]))),
		literal(anchor),
		factor(rows.map((row, index) => row.slice(offsets[index]! + anchor.length))),
	]);

	// With no common anchor, group related phrases rather than inventing more cross-products.
	for (const end of [false, true]) {
		const groups = new Map<string | undefined, string[][]>();
		for (const row of rows) {
			const key = end ? row.at(-1) : row[0];
			const group = groups.get(key) ?? [];
			group.push(row);
			groups.set(key, group);
		}
		if (groups.size > 1 && groups.size < rows.length) return { alternatives: [...groups.values()].map(factor) };
	}
	return { alternatives: rows.map(literal) };
}

function render(expression: Expression): string {
	if (typeof expression === "string") return expression.replace(/[\\[\]|∅]/g, "\\$&");
	if ("sequence" in expression) return expression.sequence.map(render).join("");
	const branches = expression.alternatives.map(part => render(part) || "∅");
	const inline = `[${branches.join("|")}]`;
	return inline.length > 88 || branches.some(branch => branch.includes("\n")) || branches.every(branch => branch.split(/\s+/).length >= 4)
		? `[\n  ${branches.map(branch => branch.replace(/\n/g, "\n  ")).join("\n| ")}\n]`
		: inline;
}

/** Ordered ASR hypotheses → temporary, word-aligned editor preview (∅ means omission).
 * Adding an already represented hypothesis leaves the expression exactly unchanged.
 * Words (including apostrophes and path separators) stay whole; literal delimiters are escaped.
 */
export function formatAsrDisplay(candidates: readonly string[]): string {
	let expression: Expression = "";
	const rows: string[][] = [];
	for (const candidate of candidates) {
		if (!candidate.trim()) continue;
		rows.push(candidate.match(/[\p{L}\p{N}\p{M}_]+(?:['’/\-][\p{L}\p{N}\p{M}_]+)*|[^\p{L}\p{N}\p{M}_\s]+|\s+/gu) ?? []);
		if (!covers(expression, candidate)) expression = factor(rows);
	}
	return render(expression);
}
