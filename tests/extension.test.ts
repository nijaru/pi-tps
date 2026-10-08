import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piTps, { METRIC_ENTRY, STATE_ENTRY, type Metric } from "../extensions/index.ts";

afterEach(() => setSystemTime());

function fixture(active: boolean) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const branch = [{ type: "custom", customType: STATE_ENTRY, data: { active } }];
	let renderer: any;
	const ctx = { sessionManager: { getBranch: () => branch }, ui: { setStatus() {}, notify() {} } };
	piTps({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand() {},
		registerEntryRenderer: (_name: string, callback: any) => { renderer = callback; },
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
	} as unknown as ExtensionAPI);
	return { entries, emit: async (name: string, event: unknown) => handlers.get(name)?.(event, ctx), row: (metric: Metric) => renderer({ data: metric }, {}, { fg: (_color: string, text: string) => text }) };
}

test("saved timing rows remain visible when recording is disabled", async () => {
	const f = fixture(false);
	await f.emit("session_start", {});
	const row = f.row({ version: 3, ttftMs: 500, rateMs: 1000, outputTokens: 100, stopReason: "stop", rateBasis: "stream" });
	expect(row?.render(80).join("\n")).toContain("0.50s · 100 tok/s");
});

test("message-owned timing ignores warming requests and observes later thinking", async () => {
	const f = fixture(true);
	await f.emit("session_start", {});
	setSystemTime(1000);
	await f.emit("before_provider_request", {});
	setSystemTime(1400);
	await f.emit("before_provider_request", {}); // background cache warmer
	const message = { role: "assistant", timestamp: 1000, api: "anthropic-messages", stopReason: "stop", usage: { output: 100, reasoning: 20 } };
	await f.emit("message_start", { message });
	setSystemTime(1500);
	await f.emit("message_update", { assistantMessageEvent: { type: "text_delta" } });
	setSystemTime(1700);
	await f.emit("message_update", { assistantMessageEvent: { type: "thinking_delta" } });
	setSystemTime(2000);
	await f.emit("message_end", { message });
	await f.emit("turn_end", { message });
	expect(f.entries).toEqual([{ customType: METRIC_ENTRY, data: { version: 3, ttftMs: 500, rateMs: 500, outputTokens: 100, stopReason: "stop", rateBasis: "stream" } }]);
});
