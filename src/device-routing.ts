import { DevicePriorityStore, type RankedDevice } from "./device-priorities.js";
import type { VoiceDeviceRegistration } from "./device-router.js";
import type { DevicePickerSnapshot } from "./device-picker-ui.js";

/** Event cache only. Heartbeats and labels are not connection generations. */
export class DeviceRouting {
	rows: readonly RankedDevice[] = [];
	devices: readonly VoiceDeviceRegistration[] = [];
	selected?: RankedDevice;
	snapshot: DevicePickerSnapshot = { devices: [], userOrder: [] };
	revision = 0;
	#signature = "";
	constructor(readonly store: DevicePriorityStore) {}

	update(devices: readonly VoiceDeviceRegistration[], selectedId?: string, pin?: string, configuration = ""): boolean {
		const signature = JSON.stringify([devices.map(d => [d.id, d.connectedAt, d.audioEndpoint, d.inputEndpoint]).sort(), this.store.snapshot, pin, configuration]);
		if (signature === this.#signature) return false;
		const fresh = devices.filter(d => !Object.hasOwn(this.store.snapshot.discovery, d.id));
		if (fresh.length) this.store.discover(fresh.map(d => ({ id: d.id, date: Date.now() })));
		this.#signature = JSON.stringify([devices.map(d => [d.id, d.connectedAt, d.audioEndpoint, d.inputEndpoint]).sort(), this.store.snapshot, pin, configuration]);
		this.devices = devices;
		this.rows = this.store.ranking(new Set(["local", ...devices.map(d => d.id)]), pin);
		this.revision++;
		this.select(selectedId);
		return true;
	}

	select(id?: string): void {
		this.selected = this.rows.find(row => row.id === id);
		this.snapshot = { devices: this.rows.map(row => ({ ...row, name: row.id === "local" ? "Local (host audio)" : this.devices.find(d => d.id === row.id)?.name ?? row.id })), userOrder: this.store.snapshot.user_order, selectedId: id };
	}

	/** Missing selected output waits. Only a relationally higher arrival may bypass it. */
	winner(selectedId?: string): string | undefined {
		const winner = this.rows.find(row => row.available);
		const selected = this.rows.findIndex(row => row.id === selectedId);
		if (!winner) return;
		if (selected < 0) return selectedId ? undefined : winner.id;
		if (this.rows[selected].available || this.rows.indexOf(winner) < selected) return winner.id;
	}
}
