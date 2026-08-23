/** Headless child/subagent sessions must not register as independent voice projects. */
export function supportsInteractiveVoice(mode: string): boolean {
	return mode === "tui";
}
