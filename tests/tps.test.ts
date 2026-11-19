import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	activeFromBranch,
	aggregatesFromBranch,
	chooseRateBasis,
	emptyAggregates,
	entryMetricLine,
	fmtTps,
	hasVisibleText,
	isUsableMetric,
	METRIC_ENTRY,
	metricFromTiming,
	readGlobalState,
	recordInFlight,
	RESET_ENTRY,
	STATE_ENTRY,
	summaryLine,
	writeGlobalState,
	type Metric,
	type PendingTiming,
} from "../extensions/index.ts";

/** Build a session-branch entry list from (customType, data) pairs. */
const branch = (...custom: Array<[string, unknown]>): SessionEntry[] =>
	custom.map(([customType, data]) => ({ type: "custom", customType, data }) as unknown as SessionEntry);

const metric = (overrides: Partial<Metric> = {}): Metric => ({
	version: 3,
	ttftMs: 1000,
	rateMs: 10_000,
	outputTokens: 272,
	stopReason: "stop",
	rateBasis: "stream",
	...overrides,
});

const assistantMessage = (overrides: Partial<AssistantMessage> = {}): AssistantMessage =>
	({
		role: "assistant",
		api: "anthropic-messages",
		content: [{ type: "text", text: "hello" }],
		usage: { output: 100, reasoning: 0 },
		stopReason: "stop",
		...overrides,
	}) as unknown as AssistantMessage;

const timing = (overrides: Partial<PendingTiming> = {}): PendingTiming => ({
	requestStartMs: 1000,
	firstDeltaMs: 1500,
	firstTextMs: 1500,
	sawMoreOutput: true,
	...overrides,
});

describe("isUsableMetric", () => {
	test("rejects malformed persisted numeric fields before aggregation", () => {
		for (const field of ["ttftMs", "firstTextMs", "rateMs", "outputTokens"] as const) {
			for (const value of [null, "100", NaN, Infinity]) {
				const invalid = { ...metric(), [field]: value };
				expect(entryMetricLine(invalid)).toBeUndefined();
				expect(aggregatesFromBranch(branch([METRIC_ENTRY, invalid]))).toEqual(emptyAggregates());
			}
		}
	});
	test("accepts completed stream endings, including tool-call turns", () => {
		expect(isUsableMetric(metric())).toBe(true);
		expect(isUsableMetric(metric({ firstTextMs: 1500 }))).toBe(true);
		expect(isUsableMetric(metric({ stopReason: "length" }))).toBe(true);
		expect(isUsableMetric(metric({ stopReason: "toolUse" }))).toBe(true);
	});
	test("rejects failures, aborts, and unknown endings", () => {
		expect(isUsableMetric(metric({ stopReason: "aborted" }))).toBe(false);
		expect(isUsableMetric(metric({ stopReason: "error" }))).toBe(false);
		expect(isUsableMetric(metric({ stopReason: "pending" }))).toBe(false);
		expect(isUsableMetric(metric({ stopReason: "unknown" }))).toBe(false);
	});
	test("rejects missing TTFT, non-positive rates, and empty token counts", () => {
		expect(isUsableMetric(metric({ ttftMs: undefined }))).toBe(false);
		expect(isUsableMetric(metric({ firstTextMs: 900 }))).toBe(false);
		expect(isUsableMetric(metric({ rateMs: 0 }))).toBe(false);
		expect(isUsableMetric(metric({ outputTokens: 0 }))).toBe(false);
	});
	test("rejects other metric versions", () => {
		// Metrics from older extension versions stored in sessions must not count.
		expect(isUsableMetric(metric({ version: 2 } as Partial<Metric> & { version: number } as Metric))).toBe(false);
	});
});

describe("hasVisibleText", () => {
	const withContent = (content: unknown[]) => assistantMessage({ content } as Partial<AssistantMessage>);
	test("true for prose, including a turn that also calls tools", () => {
		expect(hasVisibleText(assistantMessage())).toBe(true);
		expect(hasVisibleText(withContent([{ type: "text", text: "hi" }, { type: "toolCall", toolName: "bash" }]))).toBe(true);
	});
	test("false for tool-only, thinking-only, blank, and empty turns", () => {
		expect(hasVisibleText(withContent([{ type: "toolCall", toolName: "bash" }]))).toBe(false);
		expect(hasVisibleText(withContent([{ type: "thinking", thinking: "hmm" }]))).toBe(false);
		expect(hasVisibleText(withContent([{ type: "text", text: "  \n" }]))).toBe(false);
		expect(hasVisibleText(withContent([]))).toBe(false);
	});
});

describe("chooseRateBasis", () => {
	test("uses stream timing for multiple chunks without reported reasoning", () => {
		expect(chooseRateBasis(true, 0)).toBe("stream");
	});
	test("uses request timing for externally reported reasoning or a single chunk", () => {
		expect(chooseRateBasis(true, 512)).toBe("request");
		expect(chooseRateBasis(false, 0)).toBe("request");
	});
});

describe("recordInFlight", () => {
	test("adds a metric measured this turn on top of the persisted averages", () => {
		const agg = aggregatesFromBranch(
			branch([METRIC_ENTRY, metric({ outputTokens: 100, rateMs: 2000, ttftMs: 1000 })]),
		);
		recordInFlight(agg, metric({ outputTokens: 25, rateMs: 500, ttftMs: 250 }));
		expect(agg).toEqual({ ...emptyAggregates(), totalTokens: 125, totalRateMs: 2500, rateBasis: "stream", ttftSumMs: 1250, ttftCount: 2 });
	});
	test("rebuilds the same average as a reload after /tps reset", () => {
		const fresh = metric({ outputTokens: 40, rateMs: 2000, ttftMs: 500, firstTextMs: 1500, rateBasis: "request" });
		const agg = emptyAggregates();
		recordInFlight(agg, undefined);
		recordInFlight(agg, fresh);
		expect(agg).toEqual(aggregatesFromBranch(branch([RESET_ENTRY, {}], [METRIC_ENTRY, fresh])));
	});
});

describe("activeFromBranch", () => {
	test("last state entry on the branch wins", () => {
		expect(
			activeFromBranch(
				branch(
					[STATE_ENTRY, { active: true }],
					["other", { active: false }],
					[STATE_ENTRY, { active: false }],
				),
			),
		).toBe(false);
	});
	test("missing state returns undefined", () => {
		expect(activeFromBranch([])).toBeUndefined();
		expect(activeFromBranch(branch(["other", { active: true }]))).toBeUndefined();
	});
	test("ignores malformed state entries", () => {
		expect(activeFromBranch(branch([STATE_ENTRY, null]))).toBeUndefined();
		expect(activeFromBranch(branch([STATE_ENTRY, { active: true }], [STATE_ENTRY, { active: "false" }]))).toBe(true);
	});
});

describe("aggregatesFromBranch", () => {
	test("aggregates every usable metric on the branch", () => {
		const agg = aggregatesFromBranch(
			branch(
				[METRIC_ENTRY, metric({ outputTokens: 100, rateMs: 2000 })],
				[METRIC_ENTRY, metric({ outputTokens: 50, rateMs: 1000 })],
			),
		);
		expect(agg).toEqual({ ...emptyAggregates(), totalTokens: 150, totalRateMs: 3000, rateBasis: "stream", ttftSumMs: 2000, ttftCount: 2 });
	});
	test("ignores unusable metrics and other entry types", () => {
		const agg = aggregatesFromBranch(
			branch(
				[METRIC_ENTRY, metric({ stopReason: "aborted" })],
				["other", metric()],
			),
		);
		expect(agg).toEqual(emptyAggregates());
	});
	test("a reset marker clears everything recorded before it", () => {
		const agg = aggregatesFromBranch(
			branch(
				[METRIC_ENTRY, metric({ outputTokens: 100, rateMs: 2000 })],
				[METRIC_ENTRY, metric({ firstTextMs: 1500 })],
				[RESET_ENTRY, {}],
				[METRIC_ENTRY, metric({ outputTokens: 25, rateMs: 500, ttftMs: 250, firstTextMs: 400, rateBasis: "request" })],
			),
		);
		expect(agg).toEqual({ ...emptyAggregates(), totalTokens: 25, totalRateMs: 500, rateBasis: "request", textSumMs: 400, textCount: 1 });
	});
	test("a reset marker with null data still clears", () => {
		const agg = aggregatesFromBranch(branch([METRIC_ENTRY, metric()], [RESET_ENTRY, null]));
		expect(agg).toEqual(emptyAggregates());
	});
	test("multiple resets keep only metrics after the latest", () => {
		const agg = aggregatesFromBranch(
			branch(
				[METRIC_ENTRY, metric({ outputTokens: 100 })],
				[RESET_ENTRY, {}],
				[METRIC_ENTRY, metric({ outputTokens: 200 })],
				[RESET_ENTRY, {}],
				[METRIC_ENTRY, metric({ outputTokens: 300 })],
			),
		);
		expect(agg.totalTokens).toBe(300);
		expect(agg.ttftCount).toBe(1);
	});
});

describe("global state", () => {
	test("writeGlobalState then readGlobalState round-trips", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tps-"));
		try {
			const path = join(dir, "pi-tps.json");
			writeGlobalState(true, path);
			expect(readGlobalState(path)).toBe(true);
			writeGlobalState(false, path);
			expect(readGlobalState(path)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("writeGlobalState creates missing parent directories", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tps-"));
		try {
			const path = join(dir, "nested", "deeper", "pi-tps.json");
			writeGlobalState(true, path);
			expect(readGlobalState(path)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("missing or malformed file reads as never set", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tps-"));
		try {
			expect(readGlobalState(join(dir, "missing.json"))).toBeUndefined();
			const malformed = join(dir, "malformed.json");
			writeFileSync(malformed, "{ not json");
			expect(readGlobalState(malformed)).toBeUndefined();
			const nonBoolean = join(dir, "non-boolean.json");
			writeFileSync(nonBoolean, JSON.stringify({ active: "yes" }));
			expect(readGlobalState(nonBoolean)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("metricFromTiming", () => {
	test("uses the stream window after the first delta", () => {
		expect(metricFromTiming(timing(), assistantMessage(), 6000)).toEqual({
			version: 3,
			ttftMs: 500,
			firstTextMs: 500,
			rateMs: 4500,
			outputTokens: 100,
			stopReason: "stop",
			rateBasis: "stream",
		});
	});
	test("uses the request window for a response delivered in one output chunk", () => {
		const m = metricFromTiming(timing({ sawMoreOutput: false }), assistantMessage(), 1500.01);
		expect(m.rateBasis).toBe("request");
		expect(m.rateMs).toBeCloseTo(500.01);
	});
	test("uses the full request window when reasoning is hidden", () => {
		const m = metricFromTiming(
			timing(),
			assistantMessage({ api: "openai-responses", usage: { output: 100, reasoning: 40 } as AssistantMessage["usage"] }),
			6000,
		);
		expect(m.ttftMs).toBe(500);
		expect(m).toHaveProperty("firstTextMs", 500);
		expect(m.outputTokens).toBe(100); // reasoning is already included
		expect(entryMetricLine(m)).toBe("⏱ 0.50s · 20.0 tok/s (request)");
		expect(m.rateMs).toBe(5000);
		expect(m.rateBasis).toBe("request");
	});
	test("includes the full request if reasoning includes both streamed text and redacted blocks", () => {
		const message = assistantMessage({
			content: [{ type: "thinking", thinking: "hidden", redacted: true }, { type: "text", text: "answer" }],
			usage: { output: 100, reasoning: 40 } as AssistantMessage["usage"],
		});
		expect(metricFromTiming(timing(), message, 6000).rateBasis).toBe("request");
	});
	test("keeps the tool-call ending for a turn that also emitted text", () => {
		const m = metricFromTiming(
			timing(),
			assistantMessage({
				stopReason: "toolUse",
				content: [{ type: "text", text: "hi" }, { type: "toolCall", toolName: "bash" }] as AssistantMessage["content"],
			}),
			6000,
		);
		expect(m.stopReason).toBe("toolUse");
		expect(isUsableMetric(m)).toBe(true);
	});
	test("leaves TTFT undefined and rate zero when no delta arrived", () => {
		const m = metricFromTiming(timing({ firstDeltaMs: undefined, firstTextMs: undefined }), assistantMessage(), 6000);
		expect(m.ttftMs).toBeUndefined();
		expect(m.rateMs).toBe(0);
	});
});

describe("entryMetricLine", () => {
	test("preserves the original latency value in old saved rows", () => {
		const saved = JSON.parse(JSON.stringify(metric()));
		expect(entryMetricLine(saved)).toBe("⏱ 1.00s · 27.2 tok/s (stream)");
	});
	test("returns undefined for non-objects, unusable metrics, and older versions", () => {
		// Session files are user-editable; none of these may render or throw.
		for (const data of [undefined, null, "⏱ 1.00s", 3, true, [], {}, metric({ stopReason: "aborted" }), { ...metric(), version: 2 }]) {
			expect(entryMetricLine(data)).toBeUndefined();
		}
	});
});

describe("summaryLine", () => {
	test("shows nothing before the first measurement", () => {
		expect(summaryLine(emptyAggregates())).toBeUndefined();
	});
	test("shows averages once measurements exist", () => {
		expect(summaryLine(aggregatesFromBranch(branch([METRIC_ENTRY, metric({ ttftMs: 8820 })])))).toBe(
			"⏱ 8.82s · 27.2 tok/s (stream)",
		);
	});
	test("prefers visible-text latency without blending legacy timing into the footer", () => {
		const saved = metric({ outputTokens: 100, rateMs: 1000, ttftMs: 500 });
		const fresh = metric({ outputTokens: 100, rateMs: 3000, ttftMs: 1000, firstTextMs: 2000, rateBasis: "request" });
		const later = { ...fresh, firstTextMs: 4000, rateMs: 5000 };
		const agg = aggregatesFromBranch(branch([METRIC_ENTRY, saved]));
		recordInFlight(agg, fresh);
		recordInFlight(agg, later);
		expect(agg).toEqual(aggregatesFromBranch(branch([METRIC_ENTRY, saved], [METRIC_ENTRY, fresh], [METRIC_ENTRY, later])));
		expect(summaryLine(agg)).toBe("⏱ 3.00s · 33.3 tok/s (mixed)");
	});
});

describe("formatting", () => {
	test("fmtTps rounds fast streams to integers and never divides by zero", () => {
		expect(fmtTps(272, 10_000)).toBe("27.2");
		expect(fmtTps(2500, 10_000)).toBe("250");
		expect(fmtTps(0, 10_000)).toBe("0.0");
		expect(fmtTps(100, 0)).toBe("?");
	});
});
