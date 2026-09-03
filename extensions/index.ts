/**
 * pi-tps: per-request latency (TTFT) and throughput (tokens/sec) for
 * assistant messages, with session averages in the footer.
 *
 * - Measures latency from the provider request start to the first thinking/text
 *   delta event.
 * - Measures throughput over the emitted stream, or over the full request when
 *   the provider hides reasoning tokens.
 * - Per-message timing renders as one line directly below each completed
 *   assistant response.
 * - Toggle with /tps [on|off|status|reset]. State persists in the session,
 *   so it survives reloads and is restored on the correct branch after /tree.
 *   The last-set value is also saved to ~/.pi/agent/extensions/pi-tps.json
 *   so new sessions start with it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_ENTRY = "tps-state";
const METRIC_ENTRY = "tps-metric";
const STATUS_KEY = "tps";
// Last-set on/off value shared across sessions, mirroring pi-fast-mode.
const GLOBAL_STATE_PATH = join(homedir(), ".pi", "agent", "extensions", "pi-tps.json");

interface Metric {
	version: 3;
	ttftMs: number | undefined;
	rateMs: number;
	outputTokens: number;
	stopReason: string;
	rateBasis: "stream" | "request";
}

interface Aggregates {
	totalTokens: number;
	totalRateMs: number;
	ttftSumMs: number;
	ttftCount: number;
}

const emptyAggregates = (): Aggregates => ({
	totalTokens: 0,
	totalRateMs: 0,
	ttftSumMs: 0,
	ttftCount: 0,
});

function isUsableMetric(m: Metric): boolean {
	return (
		m.version === 3 &&
		m.ttftMs !== undefined &&
		m.ttftMs >= 0 &&
		m.rateMs > 0 &&
		m.outputTokens > 0 &&
		(m.stopReason === "stop" || m.stopReason === "length")
	);
}

function chooseRateBasis(
	api: string | undefined,
	sawThinkingDelta: boolean,
	reasoningTokens: number,
): "stream" | "request" {
	if (reasoningTokens <= 0) return "stream";

	// OpenAI Responses can report hidden reasoning tokens even when it emits a
	// reasoning summary. Include the full request window for that output.
	if (api === "openai-responses" || api === "openai-codex-responses") return "request";

	// For other APIs, a thinking delta means reasoning was part of the emitted
	// stream. Without one, assume reported reasoning happened before first text.
	return sawThinkingDelta ? "stream" : "request";
}

function record(agg: Aggregates, m: Metric): void {
	if (!isUsableMetric(m)) return;
	agg.totalTokens += m.outputTokens;
	agg.totalRateMs += m.rateMs;
	agg.ttftSumMs += m.ttftMs!;
	agg.ttftCount += 1;
}

function fmtSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(2)}s`;
}

function fmtTps(tokens: number, ms: number): string {
	if (ms <= 0) return "?";
	const tps = tokens / (ms / 1000);
	return tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1);
}

function readGlobalState(): boolean | undefined {
	try {
		const parsed = JSON.parse(readFileSync(GLOBAL_STATE_PATH, "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const active = (parsed as { active?: unknown }).active;
		return typeof active === "boolean" ? active : undefined;
	} catch {
		// Missing or unreadable file: treat as never set.
		return undefined;
	}
}

function writeGlobalState(active: boolean): void {
	try {
		mkdirSync(dirname(GLOBAL_STATE_PATH), { recursive: true });
		writeFileSync(GLOBAL_STATE_PATH, `${JSON.stringify({ active }, null, 2)}\n`, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[${STATUS_KEY}] failed to save global timing state: ${message}`);
	}
}

export default function (pi: ExtensionAPI) {
	let active = false;
	let requestStartMs: number | undefined;
	let pending:
		| {
			requestStartMs: number;
			firstDeltaMs: number | undefined;
			sawThinkingDelta: boolean;
			api: string | undefined;
		}
		| undefined;
	let pendingMetrics: Metric[] = [];
	let agg = emptyAggregates();

	function aggregatesFromBranch(ctx: ExtensionContext): Aggregates {
		const result = emptyAggregates();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === METRIC_ENTRY && entry.data) {
				record(result, entry.data as Metric);
			}
		}
		return result;
	}

	function activeFromBranch(ctx: ExtensionContext): boolean | undefined {
		let saved: boolean | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data) {
				saved = (entry.data as { active?: boolean }).active === true;
			}
		}
		return saved;
	}

	function updateFooter(ctx: ExtensionContext): void {
		if (!active) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (agg.ttftCount === 0) {
			// Armed but no completed responses yet (e.g. a new session
				// seeded on from the global value, or right after /tps reset).
				// Keep a visible indicator so "on" reads as on, mirroring
				// /fast's persistent footer status.
			ctx.ui.setStatus(STATUS_KEY, "⏱ on");
			return;
		}
		ctx.ui.setStatus(
			STATUS_KEY,
			`⏱ ${fmtSeconds(agg.ttftSumMs / agg.ttftCount)} · ${fmtTps(agg.totalTokens, agg.totalRateMs)} tok/s`,
		);
	}

	pi.on("before_provider_request", async () => {
		if (active) requestStartMs = Date.now();
	});

	pi.on("message_start", async (event) => {
		if (!active) return;
		if (event.message.role !== "assistant") return;
		const now = Date.now();
		pending = {
			requestStartMs: requestStartMs ?? now,
			firstDeltaMs: undefined,
			sawThinkingDelta: false,
			api: event.message.api,
		};
		requestStartMs = undefined;
	});

	pi.on("message_update", async (event) => {
		if (!pending || pending.firstDeltaMs !== undefined) return;
		const t = event.assistantMessageEvent.type;
		if (t === "thinking_delta") {
			pending.firstDeltaMs = Date.now();
			pending.sawThinkingDelta = true;
		} else if (t === "text_delta") {
			pending.firstDeltaMs = Date.now();
		}
	});

	pi.on("message_end", async (event, ctx) => {
		const started = pending;
		pending = undefined;
		if (!started) return;
		const message = event.message as AssistantMessage;
		if (message.role !== "assistant") return;

		const now = Date.now();
		const firstDeltaMs = started.firstDeltaMs;
		const streamMs = firstDeltaMs !== undefined ? now - firstDeltaMs : 0;
		const requestMs = now - started.requestStartMs;
		const reasoningTokens = message.usage?.reasoning ?? 0;
		const rateBasis = chooseRateBasis(started.api ?? message.api, started.sawThinkingDelta, reasoningTokens);
		const metric: Metric = {
			version: 3,
			ttftMs: firstDeltaMs !== undefined ? firstDeltaMs - started.requestStartMs : undefined,
			rateMs: rateBasis === "request" ? requestMs : streamMs,
			// pi-ai defines reasoning as a subset of output, not an additional count.
			outputTokens: message.usage?.output ?? 0,
			stopReason: message.stopReason ?? "unknown",
			rateBasis,
		};
		// Only completed visible responses have meaningful latency/throughput.
		// Tool-call, failed, aborted, and empty streams must not create rows or
		// contaminate the session averages.
		if (!isUsableMetric(metric)) return;

		record(agg, metric);
		pendingMetrics.push(metric);
		updateFooter(ctx);
	});

	function flushMetric(): void {
		const metric = pendingMetrics.shift();
		if (metric) pi.appendEntry(METRIC_ENTRY, metric);
	}

	pi.on("turn_end", async (event) => {
		if (event.message.role === "assistant") flushMetric();
	});

	// Preserve a partial metric if an agent run ends without a turn_end event.
	pi.on("agent_end", async () => {
		while (pendingMetrics.length > 0) flushMetric();
	});

	pi.registerCommand("tps", {
		description: "Toggle request timing; /tps [on|off|status|reset]",
		getArgumentCompletions: (prefix) => {
			const values = ["on", "off", "status", "reset"];
			const items = values.filter((v) => v.startsWith(prefix.trim().toLowerCase()));
			return items.length ? items.map((v) => ({ value: v, label: v })) : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			switch (arg) {
				case "":
					active = !active;
					break;
				case "on":
				case "off":
					active = arg === "on";
					break;
				case "reset":
					agg = emptyAggregates();
					updateFooter(ctx);
					ctx.ui.notify("Timing averages reset.", "info");
					return;
				case "status":
					break;
				default:
					ctx.ui.notify("Usage: /tps [on|off|status|reset]", "error");
					return;
			}
			pi.appendEntry(STATE_ENTRY, { active });
			writeGlobalState(active);
			if (active) agg = aggregatesFromBranch(ctx);
			updateFooter(ctx);
			ctx.ui.notify(`Request timing ${active ? "on" : "off"}.`, "info");
		},
	});

	// One fixed line per message. The /tps toggle controls visibility for
	// existing and future rows alike; there is no alternate display format.
	pi.registerEntryRenderer(METRIC_ENTRY, (entry, _opts, theme) => {
		const m = entry.data as Metric;
		if (!active || !isUsableMetric(m)) return new Text("");
		return new Text(theme.fg("dim", `⏱ ${fmtSeconds(m.ttftMs!)} · ${fmtTps(m.outputTokens, m.rateMs)} tok/s`));
	});

	pi.on("session_start", async (_event, ctx) => {
		const saved = activeFromBranch(ctx);
		// Sessions without recorded state seed from the global value so they
		// start as /tps was last set; once recorded, the session entry wins.
		active = saved ?? readGlobalState() ?? false;
		if (saved === undefined) pi.appendEntry(STATE_ENTRY, { active });
		agg = aggregatesFromBranch(ctx);
		updateFooter(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		active = activeFromBranch(ctx) ?? active;
		agg = aggregatesFromBranch(ctx);
		updateFooter(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
