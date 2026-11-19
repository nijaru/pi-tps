/** Visible-text latency and output throughput for completed Pi responses. */

import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const STATE_ENTRY = "tps-state";
export const METRIC_ENTRY = "tps-metric";
export const RESET_ENTRY = "tps-reset";
export const STATUS_KEY = "tps";
// Last-set on/off value shared across sessions, mirroring pi-fast-mode.
const GLOBAL_STATE_PATH = join(getAgentDir(), "extensions", "pi-tps.json");

/** Turn endings that completed the stream and are worth timing. */
const COMPLETED_STOP_REASONS = new Set(["stop", "length", "toolUse"]);

type RateBasis = "stream" | "request";

export interface Metric {
	version: 3;
	/** First observed output latency (thinking/text only in previously saved rows). */
	ttftMs: number | undefined;
	/** First non-blank text delta latency. Absent from legacy saved metrics. */
	firstTextMs?: number;
	rateMs: number;
	outputTokens: number;
	stopReason: string;
	rateBasis: RateBasis;
}

export interface Aggregates {
	totalTokens: number;
	totalRateMs: number;
	rateBasis?: RateBasis | "mixed";
	textSumMs: number;
	textCount: number;
	/** Legacy latency only; do not average first-token and first-text measurements together. */
	ttftSumMs: number;
	ttftCount: number;
}

/** In-flight request timing, captured between message_start and message_end. */
export interface PendingTiming {
	requestStartMs: number;
	firstDeltaMs: number | undefined;
	firstTextMs: number | undefined;
	sawMoreOutput: boolean;
}

export const emptyAggregates = (): Aggregates => ({
	totalTokens: 0,
	totalRateMs: 0,
	textSumMs: 0,
	textCount: 0,
	ttftSumMs: 0,
	ttftCount: 0,
});

export function isUsableMetric(data: unknown): data is Metric & { ttftMs: number } {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
	const m = data as Partial<Metric>;
	return (
		m.version === 3 &&
		typeof m.ttftMs === "number" && Number.isFinite(m.ttftMs) && m.ttftMs >= 0 &&
		(m.firstTextMs === undefined || (
			typeof m.firstTextMs === "number" && Number.isFinite(m.firstTextMs) && m.firstTextMs >= m.ttftMs
		)) &&
		typeof m.rateMs === "number" && Number.isFinite(m.rateMs) && m.rateMs > 0 &&
		typeof m.outputTokens === "number" && Number.isFinite(m.outputTokens) && m.outputTokens > 0 &&
		(m.rateBasis === "stream" || m.rateBasis === "request") &&
		(typeof m.stopReason === "string" && COMPLETED_STOP_REASONS.has(m.stopReason))
	);
}

/** Whether the finished message streamed prose the user can see. */
export function hasVisibleText(message: AssistantMessage): boolean {
	return message.content.some((part) => part.type === "text" && part.text.trim().length > 0);
}

export function chooseRateBasis(sawMoreOutput: boolean, reasoningTokens: number): RateBasis {
	// A thinking delta can be a summary; Pi's normalized events don't establish
	// that every reported reasoning token was streamed. A single output chunk
	// also gives us no observable generation interval after its arrival.
	return reasoningTokens > 0 || !sawMoreOutput ? "request" : "stream";
}

function record(agg: Aggregates, m: unknown): void {
	if (!isUsableMetric(m)) return;
	agg.totalTokens += m.outputTokens;
	agg.totalRateMs += m.rateMs;
	agg.rateBasis = agg.rateBasis === undefined || agg.rateBasis === m.rateBasis ? m.rateBasis : "mixed";
	if (m.firstTextMs !== undefined) {
		agg.textSumMs += m.firstTextMs;
		agg.textCount += 1;
	} else {
		agg.ttftSumMs += m.ttftMs;
		agg.ttftCount += 1;
	}
}

export function fmtSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(2)}s`;
}

export function fmtTps(tokens: number, ms: number): string {
	if (ms <= 0) return "?";
	const tps = tokens / (ms / 1000);
	return tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1);
}

/** Include a completed response whose session row still waits for turn_end. */
export function recordInFlight(agg: Aggregates, metric: Metric | undefined): void {
	if (metric) record(agg, metric);
}

/** One line for a persisted metric entry, or undefined when there is nothing to show. */
export function entryMetricLine(data: unknown): string | undefined {
	// Session files are user-editable, so validate unknown data before formatting.
	if (!isUsableMetric(data)) return undefined;
	return `⏱ ${fmtSeconds(data.firstTextMs ?? data.ttftMs)} · ${fmtTps(data.outputTokens, data.rateMs)} tok/s (${data.rateBasis})`;
}

/** Footer line for the session: averages, or undefined before the first measurement. */
export function summaryLine(agg: Aggregates): string | undefined {
	if (agg.textCount === 0 && agg.ttftCount === 0) return undefined;
	// Prefer visible-text timing without blending it with legacy first-token data.
	const latency = agg.textCount > 0 ? agg.textSumMs / agg.textCount : agg.ttftSumMs / agg.ttftCount;
	return `⏱ ${fmtSeconds(latency)} · ${fmtTps(agg.totalTokens, agg.totalRateMs)} tok/s (${agg.rateBasis})`;
}

/** Turn captured timing plus the finished message into a persistable metric. */
export function metricFromTiming(pending: PendingTiming, message: AssistantMessage, endMs: number): Metric {
	const { firstDeltaMs, firstTextMs } = pending;
	const rateBasis = chooseRateBasis(pending.sawMoreOutput, message.usage?.reasoning ?? 0);
	return {
		version: 3,
		ttftMs: firstDeltaMs === undefined ? undefined : firstDeltaMs - pending.requestStartMs,
		firstTextMs: firstTextMs === undefined ? undefined : firstTextMs - pending.requestStartMs,
		rateMs: firstDeltaMs === undefined ? 0 : endMs - (rateBasis === "request" ? pending.requestStartMs : firstDeltaMs),
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
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = mkdtempSync(join(dir, ".pi-tps-"));
	try {
		const file = join(tmp, "state.json");
		writeFileSync(file, `${JSON.stringify({ active }, null, 2)}\n`, "utf8");
		renameSync(file, path);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
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
			case STATE_ENTRY: {
				const value = (entry.data as { active?: unknown } | null | undefined)?.active;
				if (typeof value === "boolean") active = value;
				break;
			}
			case RESET_ENTRY:
				agg = emptyAggregates();
				break;
			case METRIC_ENTRY:
				record(agg, entry.data);
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
	// On/off controls recording and the footer, not saved transcript evidence.
	let active = readGlobalState() ?? false;
	let pending: PendingTiming | undefined;
	// Pi finishes each assistant turn before starting the next one.
	let completed: Metric | undefined;
	let agg = emptyAggregates();

	function updateFooter(ctx: ExtensionContext): void {
		const line = active ? summaryLine(agg) : undefined;
		ctx.ui.setStatus(STATUS_KEY, line ? `· ${line}` : undefined);
	}

	pi.on("message_start", (event) => {
		if (!active || event.message.role !== "assistant") return;
		// Anchor Pi's invocation timestamp to the monotonic clock once, so wall
		// clock changes during the stream do not skew elapsed time.
		pending = {
			requestStartMs: performance.now() - Math.max(0, Date.now() - event.message.timestamp),
			firstDeltaMs: undefined,
			firstTextMs: undefined,
			sawMoreOutput: false,
		};
	});

	pi.on("message_update", (event) => {
		if (!pending) return;
		const delta = event.assistantMessageEvent;
		const firstText = pending.firstTextMs === undefined && delta.type === "text_delta" && /\S/.test(delta.delta);
		const output = !pending.sawMoreOutput && (
			delta.type === "toolcall_start" ||
			((delta.type === "toolcall_delta" || delta.type === "thinking_delta" || delta.type === "text_delta") && delta.delta.length > 0)
		);
		const firstOutput = output && pending.firstDeltaMs === undefined;
		if (output && !firstOutput) pending.sawMoreOutput = true;
		if (!firstText && !firstOutput) return;
		const now = performance.now();
		if (firstOutput) pending.firstDeltaMs = now;
		if (firstText) pending.firstTextMs = now;
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const started = pending;
		pending = undefined;
		if (!started) return;

		const metric = metricFromTiming(started, event.message, performance.now());
		// Only completed responses with visible prose have meaningful
		// latency/throughput. Tool-only, failed, aborted, and empty streams must
		// not create rows or contaminate the session averages. Require an observed
		// text delta so new metrics never masquerade as legacy first-token data.
		// Text accompanying tool calls is still user-visible and worth timing.
		if (metric.firstTextMs === undefined || !isUsableMetric(metric) || !hasVisibleText(event.message)) return;

		record(agg, metric);
		completed = metric;
		updateFooter(ctx);
	});

	function flushMetric(): void {
		if (!completed) return;
		pi.appendEntry(METRIC_ENTRY, completed);
		completed = undefined;
	}

	pi.on("turn_end", (event) => {
		if (event.message.role === "assistant") flushMetric();
	});

	// Preserve a completed response if the run stopped before turn_end.
	pi.on("agent_end", () => {
		pending = undefined;
		flushMetric();
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
			const previous = active;
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
					recordInFlight(agg, completed);
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
			try {
				writeGlobalState(active);
			} catch {
				active = previous;
				ctx.ui.notify(`Request timing unchanged: could not save ${GLOBAL_STATE_PATH}. Check its file permissions.`, "error");
				return;
			}
			pi.appendEntry(STATE_ENTRY, { active });
			// An unfinished response is discarded on off, even if enabled again
			// before it finishes. Already completed responses are still saved.
			if (!active) pending = undefined;
			updateFooter(ctx);
			ctx.ui.notify(`Request timing ${active ? "on" : "off"}.`, "info");
		},
	});

	// Saved measurements remain visible independently of current recording state.
	// Pi constructs these rows before session_start restores the branch state.
	pi.registerEntryRenderer(METRIC_ENTRY, (entry, _opts, theme) => {
		const line = entryMetricLine(entry.data);
		return line === undefined ? undefined : new Text(theme.fg("dim", line));
	});

	// tps-reset entries are durable markers only; without a registered
	// renderer, pi renders nothing for them in the transcript.

	function restoreBranch(ctx: ExtensionContext): void {
		const state = scanBranch(ctx.sessionManager.getBranch());
		// Sessions without recorded state seed from the global value so they
		// start as /tps was last set; once recorded, the session entry wins.
		active = state.active ?? readGlobalState() ?? false;
		if (state.active === undefined) pi.appendEntry(STATE_ENTRY, { active });
		agg = state.agg;
		updateFooter(ctx);
	}

	pi.on("session_start", (_event, ctx) => restoreBranch(ctx));
	pi.on("session_tree", (_event, ctx) => restoreBranch(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
