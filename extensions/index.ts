/**
 * pi-tps: per-request latency (TTFT) and throughput (tokens/sec) for
 * assistant messages, with session averages in the footer.
 *
 * - Measures latency from the provider request start to the first thinking/text
 *   delta event.
 * - Measures throughput over the emitted stream, or over the full request when
 *   the provider hides reasoning tokens from the stream.
 * - Per-message timing renders as one line directly below each completed
 *   assistant response.
 * - Toggle with /tps [on|off|status|reset]. State persists in the session,
 *   so it survives reloads and is restored on the correct branch after /tree.
 *   The last-set value is also saved under the agent config directory
 *   (pi-tps.json) so new sessions start with it.
 * - The footer only shows averages once the session has measurements; an
 *   enabled session with nothing measured yet adds no status text.
 */

import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const STATE_ENTRY = "tps-state";
export const METRIC_ENTRY = "tps-metric";
export const RESET_ENTRY = "tps-reset";
export const STATUS_KEY = "tps";
// Last-set on/off value shared across sessions, mirroring pi-fast-mode.
const GLOBAL_STATE_PATH = join(getAgentDir(), "extensions", "pi-tps.json");

/** APIs that can report hidden reasoning tokens even while emitting reasoning summaries. */
const REQUEST_BASIS_APIS = new Set(["openai-responses", "openai-codex-responses", "azure-openai-responses"]);

export interface Metric {
	version: 3;
	ttftMs: number | undefined;
	rateMs: number;
	outputTokens: number;
	stopReason: string;
	rateBasis: "stream" | "request";
}

export interface Aggregates {
	totalTokens: number;
	totalRateMs: number;
	ttftSumMs: number;
	ttftCount: number;
}

/** In-flight request timing, captured between message_start and message_end. */
export interface PendingTiming {
	requestStartMs: number;
	firstDeltaMs: number | undefined;
	sawThinkingDelta: boolean;
	api: string | undefined;
}

export const emptyAggregates = (): Aggregates => ({
	totalTokens: 0,
	totalRateMs: 0,
	ttftSumMs: 0,
	ttftCount: 0,
});

export function isUsableMetric(m: Metric): boolean {
	return (
		m.version === 3 &&
		m.ttftMs !== undefined &&
		m.ttftMs >= 0 &&
		m.rateMs > 0 &&
		m.outputTokens > 0 &&
		(m.stopReason === "stop" || m.stopReason === "length")
	);
}

export function chooseRateBasis(
	api: string | undefined,
	sawThinkingDelta: boolean,
	reasoningTokens: number,
): "stream" | "request" {
	if (reasoningTokens <= 0) return "stream";

	// Responses-style APIs can report hidden reasoning tokens even when they
	// emit a reasoning summary. Include the full request window for that output.
	// Azure uses the same Responses protocol and reasoning token accounting as
	// OpenAI (openai-responses-shared), so it gets the same treatment.
	if (api !== undefined && REQUEST_BASIS_APIS.has(api)) return "request";

	// For other APIs, a thinking delta means reasoning was part of the emitted
	// stream. Without one, assume reported reasoning happened before first text.
	return sawThinkingDelta ? "stream" : "request";
}

export function record(agg: Aggregates, m: Metric): void {
	if (!isUsableMetric(m)) return;
	agg.totalTokens += m.outputTokens;
	agg.totalRateMs += m.rateMs;
	agg.ttftSumMs += m.ttftMs ?? 0;
	agg.ttftCount += 1;
}

export function fmtSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(2)}s`;
}

export function fmtTps(tokens: number, ms: number): string {
	if (ms <= 0) return "?";
	const tps = tokens / (ms / 1000);
	return tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1);
}

/** Add metrics measured this turn that are not yet persisted as branch entries. */
export function recordInFlight(agg: Aggregates, inFlight: readonly Metric[]): void {
	for (const metric of inFlight) record(agg, metric);
}

/** One line for a finished request, or undefined when it is not worth showing. */
export function metricLine(m: Metric): string | undefined {
	if (!isUsableMetric(m)) return undefined;
	return `⏱ ${fmtSeconds(m.ttftMs ?? 0)} · ${fmtTps(m.outputTokens, m.rateMs)} tok/s`;
}

/** One line for a persisted metric entry, or undefined when there is nothing to show. */
export function entryMetricLine(data: unknown): string | undefined {
	// Session files are user-editable, so never hand a non-object to metricLine.
	if (typeof data !== "object" || data === null) return undefined;
	return metricLine(data as Metric);
}

/** Footer line for the session: averages, or undefined before the first measurement. */
export function summaryLine(agg: Aggregates): string | undefined {
	if (agg.ttftCount === 0) return undefined;
	return `⏱ ${fmtSeconds(agg.ttftSumMs / agg.ttftCount)} · ${fmtTps(agg.totalTokens, agg.totalRateMs)} tok/s`;
}

/** Turn captured timing plus the finished message into a persistable metric. */
export function metricFromTiming(pending: PendingTiming, message: AssistantMessage, endMs: number): Metric {
	const { firstDeltaMs } = pending;
	const rateBasis = chooseRateBasis(
		pending.api ?? message.api,
		pending.sawThinkingDelta,
		message.usage?.reasoning ?? 0,
	);
	return {
		version: 3,
		ttftMs: firstDeltaMs === undefined ? undefined : firstDeltaMs - pending.requestStartMs,
		rateMs: rateBasis === "request" ? endMs - pending.requestStartMs : firstDeltaMs === undefined ? 0 : endMs - firstDeltaMs,
		// pi-ai defines reasoning as a subset of output, not an additional count.
		outputTokens: message.usage?.output ?? 0,
		stopReason: message.stopReason ?? "unknown",
		rateBasis,
	};
}

export function readGlobalState(path = GLOBAL_STATE_PATH): boolean | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const active = (parsed as { active?: unknown }).active;
		return typeof active === "boolean" ? active : undefined;
	} catch {
		// Missing or unreadable file: treat as never set.
		return undefined;
	}
}

export function writeGlobalState(active: boolean, path = GLOBAL_STATE_PATH): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ active }, null, 2)}\n`, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[${STATUS_KEY}] failed to save global timing state: ${message}`);
	}
}

interface BranchState {
	active: boolean | undefined;
	agg: Aggregates;
}

/** One pass over the branch: latest on/off state plus aggregates honoring the latest reset. */
function scanBranch(entries: readonly SessionEntry[]): BranchState {
	let active: boolean | undefined;
	let agg = emptyAggregates();
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		switch (entry.customType) {
			case STATE_ENTRY:
				// Treat null like missing data so branch scans never cast null to a state.
				if (typeof entry.data === "object" && entry.data !== null) {
					active = (entry.data as { active?: unknown }).active === true;
				}
				break;
			case RESET_ENTRY:
				agg = emptyAggregates();
				break;
			case METRIC_ENTRY:
				if (typeof entry.data === "object" && entry.data !== null) record(agg, entry.data as Metric);
				break;
		}
	}
	return { active, agg };
}

/** Restore the latest on/off state recorded on the active session branch. */
export function activeFromBranch(entries: readonly SessionEntry[]): boolean | undefined {
	return scanBranch(entries).active;
}

/** Recompute session aggregates from the active branch, honoring the latest reset marker. */
export function aggregatesFromBranch(entries: readonly SessionEntry[]): Aggregates {
	return scanBranch(entries).agg;
}

export default function piTps(pi: ExtensionAPI) {
	// Row visibility gating. Seeded from the shared last-set value because pi
	// rebuilds the transcript from session entries before emitting session_start
	// on /reload, /resume, and /fork, where a hardcoded false would hide every
	// persisted row. session_start then replaces it with the branch value.
	let active = readGlobalState() ?? false;
	let requestStartMs: number | undefined;
	let pending: PendingTiming | undefined;
	let pendingMetrics: Metric[] = [];
	let agg = emptyAggregates();

	function updateFooter(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, active ? summaryLine(agg) : undefined);
	}

	pi.on("before_provider_request", async () => {
		if (active) requestStartMs = Date.now();
	});

	pi.on("message_start", async (event) => {
		if (!active || event.message.role !== "assistant") return;
		pending = {
			requestStartMs: requestStartMs ?? Date.now(),
			firstDeltaMs: undefined,
			sawThinkingDelta: false,
			api: event.message.api,
		};
		requestStartMs = undefined;
	});

	pi.on("message_update", async (event) => {
		if (!pending || pending.firstDeltaMs !== undefined) return;
		const type = event.assistantMessageEvent.type;
		if (type === "thinking_delta") {
			pending.firstDeltaMs = Date.now();
			pending.sawThinkingDelta = true;
		} else if (type === "text_delta") {
			pending.firstDeltaMs = Date.now();
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const started = pending;
		pending = undefined;
		if (!started) return;

		const metric = metricFromTiming(started, event.message, Date.now());
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
					// A metric measured earlier in the same turn flushes after this
					// marker, so it survives a reload and counts toward the fresh
					// averages. Re-record it now to keep the live footer consistent.
					recordInFlight(agg, pendingMetrics);
					pi.appendEntry(RESET_ENTRY, {});
					updateFooter(ctx);
					ctx.ui.notify("Timing averages reset.", "info");
					return;
				case "status":
					// Read-only: report without appending a redundant state entry
					// or rewriting the global value.
					ctx.ui.notify(`Request timing ${active ? "on" : "off"}.`, "info");
					return;
				default:
					ctx.ui.notify("Usage: /tps [on|off|status|reset]", "error");
					return;
			}
			pi.appendEntry(STATE_ENTRY, { active });
			writeGlobalState(active);
			if (active) {
				// The branch has no entry yet for a metric measured earlier in the same
				// turn; count it so the live footer matches what a reload recomputes.
				agg = aggregatesFromBranch(ctx.sessionManager.getBranch());
				recordInFlight(agg, pendingMetrics);
			}
			updateFooter(ctx);
			ctx.ui.notify(`Request timing ${active ? "on" : "off"}.`, "info");
		},
	});

	// One fixed line per message. The /tps toggle controls visibility for
	// rows rendered after it changes and for the whole transcript after a
	// reload or /tree rebuild. Returning undefined keeps hidden rows from
	// leaving a blank spacer in the transcript.
	pi.registerEntryRenderer(METRIC_ENTRY, (entry, _opts, theme) => {
		if (!active) return undefined;
		const line = entryMetricLine(entry.data);
		return line === undefined ? undefined : new Text(theme.fg("dim", line));
	});

	// tps-reset entries are durable markers only; without a registered
	// renderer, pi renders nothing for them in the transcript.

	pi.on("session_start", async (_event, ctx) => {
		const state = scanBranch(ctx.sessionManager.getBranch());
		// Sessions without recorded state seed from the global value so they
		// start as /tps was last set; once recorded, the session entry wins.
		active = state.active ?? readGlobalState() ?? false;
		if (state.active === undefined) pi.appendEntry(STATE_ENTRY, { active });
		agg = state.agg;
		updateFooter(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		const state = scanBranch(ctx.sessionManager.getBranch());
		active = state.active ?? active;
		agg = state.agg;
		updateFooter(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
