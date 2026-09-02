/**
 * pi-req-timer: per-request latency (TTFT) and throughput (tokens/sec) for
 * assistant messages, with session averages in the footer.
 *
 * - Measures TTFT from message_start to the first thinking/text delta event.
 * - Measures TPS as (output + reasoning tokens) / stream duration after the
 *   first token. Tokens are used only for the weighted average; they are not
 *   displayed anywhere (the footer already reports token usage).
 * - Per-message timing renders as a collapsible transcript entry, collapsed by
 *   default like thinking blocks (ctrl+o expands).
 * - Toggle with /timer [on|off|status|reset]. State persists in the session,
 *   so it survives reloads and is restored on the correct branch after /tree.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";

const STATE_ENTRY = "req-timer-state";
const METRIC_ENTRY = "req-timer";
const STATUS_KEY = "req-timer";

interface Metric {
	ttftMs: number | undefined;
	streamMs: number;
	tokens: number;
	stopReason: string;
}

interface Aggregates {
	totalTokens: number;
	totalStreamMs: number;
	ttftSumMs: number;
	ttftCount: number;
}

const emptyAggregates = (): Aggregates => ({
	totalTokens: 0,
	totalStreamMs: 0,
	ttftSumMs: 0,
	ttftCount: 0,
});

function record(agg: Aggregates, m: Metric): void {
	agg.totalTokens += m.tokens;
	agg.totalStreamMs += m.streamMs;
	if (m.ttftMs !== undefined && m.ttftMs >= 0) {
		agg.ttftSumMs += m.ttftMs;
		agg.ttftCount += 1;
	}
}

function fmtSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(2)}s`;
}

function fmtTps(tokens: number, ms: number): string {
	if (ms <= 0) return "?";
	const tps = tokens / (ms / 1000);
	return tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1);
}

export default function (pi: ExtensionAPI) {
	let active = false;
	let pending: { startMs: number; firstDeltaMs: number | undefined } | undefined;
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

	function updateFooter(ctx: ExtensionContext): void {
		if (!active || agg.ttftCount === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(
			STATUS_KEY,
			`⏱ ttft ${fmtSeconds(agg.ttftSumMs / agg.ttftCount)} · tps ${fmtTps(agg.totalTokens, agg.totalStreamMs)}`,
		);
	}

	pi.on("message_start", async (event) => {
		if (!active) return;
		if (event.message.role !== "assistant") return;
		pending = { startMs: Date.now(), firstDeltaMs: undefined };
	});

	pi.on("message_update", async (event) => {
		if (!pending || pending.firstDeltaMs !== undefined) return;
		const t = event.assistantMessageEvent.type;
		if (t === "text_delta" || t === "thinking_delta") {
			pending.firstDeltaMs = Date.now();
		}
	});

	pi.on("message_end", async (event, ctx) => {
		const started = pending;
		pending = undefined;
		if (!started) return;
		const message = event.message as AssistantMessage;
		if (message.role !== "assistant") return;

		const metric: Metric = {
			ttftMs: started.firstDeltaMs !== undefined ? started.firstDeltaMs - started.startMs : undefined,
			streamMs: started.firstDeltaMs !== undefined ? Date.now() - started.firstDeltaMs : 0,
			tokens: (message.usage?.output ?? 0) + (message.usage?.reasoning ?? 0),
			stopReason: message.stopReason ?? "unknown",
		};
		// Empty streams (abort/error before the first token) have nothing to time.
		if (metric.ttftMs === undefined && metric.tokens === 0) return;

		record(agg, metric);
		pi.appendEntry(METRIC_ENTRY, metric);
		updateFooter(ctx);
	});

	pi.registerCommand("timer", {
		description: "Toggle request timing (TTFT/TPS); /timer [on|off|status|reset]",
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
					ctx.ui.notify("Usage: /timer [on|off|status|reset]", "error");
					return;
			}
			pi.appendEntry(STATE_ENTRY, { active });
			if (active) agg = aggregatesFromBranch(ctx);
			updateFooter(ctx);
			ctx.ui.notify(`Request timing ${active ? "on" : "off"}.`, "info");
		},
	});

	// One fixed line per message; the /timer toggle controls visibility entirely.
	// Abnormal stop reasons get a suffix since they change how to read the numbers.
	pi.registerEntryRenderer(METRIC_ENTRY, (entry, _opts, theme) => {
		const m = entry.data as Metric;
		const ttft = m.ttftMs !== undefined ? fmtSeconds(m.ttftMs) : "n/a";
		const suffix = m.stopReason !== "stop" ? ` · ${m.stopReason}` : "";
		return new Text(theme.fg("dim", `⏱ ttft ${ttft} · ${fmtTps(m.tokens, m.streamMs)} tok/s${suffix}`));
	});

	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data) {
				active = (entry.data as { active?: boolean }).active === true;
			}
		}
		agg = aggregatesFromBranch(ctx);
		updateFooter(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		agg = aggregatesFromBranch(ctx);
		updateFooter(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
