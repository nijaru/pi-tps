import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piTps, { METRIC_ENTRY, STATE_ENTRY, type Metric } from "../extensions/index.ts";

afterEach(() => setSystemTime());

function fixture(active: boolean) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const branch = [{ type: "custom", customType: STATE_ENTRY, data: { active } }];
	let renderer: any;
	const statuses: Array<string | undefined> = [];
	const ctx = { sessionManager: { getBranch: () => branch }, ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text), notify() {} } };
	piTps({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand() {},
		registerEntryRenderer: (_name: string, callback: any) => { renderer = callback; },
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
	} as unknown as ExtensionAPI);
	return { entries, statuses, emit: async (name: string, event: unknown) => handlers.get(name)?.(event, ctx), row: (metric: Metric) => renderer({ data: metric }, {}, { fg: (_color: string, text: string) => text }) };
}

test("saved timing rows remain visible when recording is disabled", async () => {
	const f = fixture(false);
	await f.emit("session_start", {});
	const row = f.row({ version: 3, ttftMs: 500, rateMs: 1000, outputTokens: 100, stopReason: "stop", rateBasis: "stream" });
	expect(row?.render(80).join("\n")).toContain("0.50s · 100 tok/s");
	expect(f.statuses.at(-1)).toBeUndefined();
});

test("hidden Responses reasoning uses visible-text latency and the full request despite warming activity", async () => {
	const f = fixture(true);
	await f.emit("session_start", {});
	setSystemTime(800);
	await f.emit("before_provider_request", {}); // background cache warmer
	const message = { role: "assistant", timestamp: 1000, api: "openai-responses", stopReason: "stop", usage: { output: 100, reasoning: 40 }, content: [{ type: "text", text: "answer" }] };
	await f.emit("message_start", { message });
	setSystemTime(1200);
	await f.emit("before_provider_request", {}); // another warming request
	setSystemTime(1500);
	await f.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "answer" } });
	setSystemTime(2000);
	await f.emit("message_end", { message });
	await f.emit("turn_end", { message });
	// Both latencies start at the message timestamp, not a warming request.
	// Reasoning is a subset of output; no thinking delta is needed to count it.
	expect(f.entries).toEqual([{ customType: METRIC_ENTRY, data: { version: 3, ttftMs: 500, firstTextMs: 500, rateMs: 1000, outputTokens: 100, stopReason: "stop", rateBasis: "request" } }]);
	expect(f.statuses.at(-1)).toBe("· ⏱ 0.50s · 100 tok/s");
});

test("a thinking delta after visible text still counts reasoning as streamed", async () => {
	const f = fixture(true);
	await f.emit("session_start", {});
	setSystemTime(1000);
	const message = { role: "assistant", timestamp: 1000, api: "anthropic-messages", stopReason: "stop", usage: { output: 100, reasoning: 20 }, content: [{ type: "text", text: "answer" }] };
	await f.emit("message_start", { message });
	setSystemTime(1500);
	await f.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "answer" } });
	setSystemTime(1700);
	await f.emit("message_update", { assistantMessageEvent: { type: "thinking_delta" } });
	setSystemTime(2000);
	await f.emit("message_end", { message });
	await f.emit("turn_end", { message });
	// Stream basis keeps rateMs at the emitted window (500); ignoring the late
	// thinking delta would misread hidden reasoning and use the full 1000ms request.
	expect(f.entries).toEqual([{ customType: METRIC_ENTRY, data: { version: 3, ttftMs: 500, firstTextMs: 500, rateMs: 500, outputTokens: 100, stopReason: "stop", rateBasis: "stream" } }]);
});

test("thinking and blank text do not end the wait for visible text", async () => {
	const f = fixture(true);
	await f.emit("session_start", {});
	const message = { role: "assistant", timestamp: 1000, api: "openai-completions", stopReason: "stop", usage: { output: 100, reasoning: 20 }, content: [{ type: "text", text: "answer" }] };
	await f.emit("message_start", { message });
	for (const [time, type, delta] of [[1200, "thinking_delta", "hmm"], [1300, "text_delta", "\n"], [1800, "text_delta", "answer"], [1900, "text_delta", "!"]] as const) {
		setSystemTime(time);
		await f.emit("message_update", { assistantMessageEvent: { type, delta } });
	}
	setSystemTime(2000);
	await f.emit("message_end", { message });
	await f.emit("turn_end", { message });
	expect(f.entries).toEqual([{ customType: METRIC_ENTRY, data: { version: 3, ttftMs: 200, firstTextMs: 800, rateMs: 800, outputTokens: 100, stopReason: "stop", rateBasis: "stream" } }]);
	const saved = JSON.parse(JSON.stringify(f.entries[0]!.data));
	expect(f.row(saved)?.render(100).join("\n")).toContain("0.80s · 125 tok/s");
	expect(f.statuses.at(-1)).toBe("· ⏱ 0.80s · 125 tok/s");
});

test("rows follow visible text, not turn endings", async () => {
	const f = fixture(true);
	await f.emit("session_start", {});
	setSystemTime(1000);
	const toolTurn = { role: "assistant", timestamp: 1000, api: "anthropic-messages", stopReason: "toolUse", usage: { output: 100, reasoning: 0 }, content: [{ type: "text", text: "running it" }, { type: "toolCall", toolName: "bash" }] };
	await f.emit("message_start", { message: toolTurn });
	setSystemTime(1200);
	await f.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "running it" } });
	setSystemTime(1500);
	await f.emit("message_end", { message: toolTurn });
	await f.emit("turn_end", { message: toolTurn });
	const silentTurn = { role: "assistant", timestamp: 2000, api: "anthropic-messages", stopReason: "toolUse", usage: { output: 50, reasoning: 0 }, content: [{ type: "toolCall", toolName: "bash" }] };
	await f.emit("message_start", { message: silentTurn });
	setSystemTime(2100);
	await f.emit("message_update", { assistantMessageEvent: { type: "thinking_delta" } });
	setSystemTime(2300);
	await f.emit("message_end", { message: silentTurn });
	await f.emit("turn_end", { message: silentTurn });
	expect(f.entries).toEqual([{ customType: METRIC_ENTRY, data: { version: 3, ttftMs: 200, firstTextMs: 200, rateMs: 300, outputTokens: 100, stopReason: "toolUse", rateBasis: "stream" } }]);
});
