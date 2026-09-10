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
	fmtSeconds,
	fmtTps,
	isUsableMetric,
	METRIC_ENTRY,
	metricFromTiming,
	metricLine,
	readGlobalState,
	record,
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
		usage: { output: 100, reasoning: 0 },
		stopReason: "stop",
		...overrides,
	}) as unknown as AssistantMessage;

const timing = (overrides: Partial<PendingTiming> = {}): PendingTiming => ({
	requestStartMs: 1000,
	firstDeltaMs: 1500,
	sawThinkingDelta: false,
	api: "anthropic-messages",
	...overrides,
});

describe("isUsableMetric", () => {
	test("accepts a completed visible response", () => {
		expect(isUsableMetric(metric())).toBe(true);
		expect(isUsableMetric(metric({ stopReason: "length" }))).toBe(true);
	});
	test("rejects tool calls, failures, aborts, and empty streams", () => {
		expect(isUsableMetric(metric({ stopReason: "toolUse" }))).toBe(false);
		expect(isUsableMetric(metric({ stopReason: "aborted" }))).toBe(false);
		expect(isUsableMetric(metric({ stopReason: "error" }))).toBe(false);
		expect(isUsableMetric(metric({ stopReason: "unknown" }))).toBe(false);
	});
	test("rejects missing TTFT, non-positive rates, and empty token counts", () => {
		expect(isUsableMetric(metric({ ttftMs: undefined }))).toBe(false);
		expect(isUsableMetric(metric({ rateMs: 0 }))).toBe(false);
		expect(isUsableMetric(metric({ outputTokens: 0 }))).toBe(false);
	});
	test("rejects other metric versions", () => {
		// Metrics from older extension versions stored in sessions must not count.
		expect(isUsableMetric(metric({ version: 2 } as Partial<Metric> & { version: number } as Metric))).toBe(false);
	});
});

describe("chooseRateBasis", () => {
	test("streams when the provider reports no reasoning tokens", () => {
		expect(chooseRateBasis(undefined, false, 0)).toBe("stream");
		expect(chooseRateBasis("anthropic-messages", false, 0)).toBe("stream");
	});
	test("requests for Responses APIs that can hide reasoning from the stream", () => {
		for (const api of ["openai-responses", "openai-codex-responses", "azure-openai-responses"]) {
			expect(chooseRateBasis(api, false, 512)).toBe("request");
			// A visible summary does not mean the reasoning tokens were streamed.
			expect(chooseRateBasis(api, true, 512)).toBe("request");
		}
	});
	test("streams for other APIs when a thinking delta was seen", () => {
		expect(chooseRateBasis("anthropic-messages", true, 512)).toBe("stream");
		expect(chooseRateBasis("google-generative-ai", true, 512)).toBe("stream");
	});
	test("requests for other APIs when reasoning happened off-stream", () => {
		expect(chooseRateBasis("anthropic-messages", false, 512)).toBe("request");
	});
});

describe("record / aggregates", () => {
	test("record skips unusable metrics", () => {
		const agg = emptyAggregates();
		record(agg, metric({ outputTokens: 0 }));
		expect(agg).toEqual(emptyAggregates());
	});
	test("record accumulates tokens, rate time, and TTFT", () => {
		const agg = emptyAggregates();
		record(agg, metric({ outputTokens: 100, rateMs: 2000 }));
		record(agg, metric({ outputTokens: 300, rateMs: 6000, ttftMs: 500 }));
		expect(agg).toEqual({ totalTokens: 400, totalRateMs: 8000, ttftSumMs: 1500, ttftCount: 2 });
	});
});

describe("recordInFlight", () => {
	test("adds a metric measured this turn on top of the persisted averages", () => {
		const agg = aggregatesFromBranch(
			branch([METRIC_ENTRY, metric({ outputTokens: 100, rateMs: 2000, ttftMs: 1000 })]),
		);
		recordInFlight(agg, [metric({ outputTokens: 25, rateMs: 500, ttftMs: 250 })]);
		expect(agg).toEqual({ totalTokens: 125, totalRateMs: 2500, ttftSumMs: 1250, ttftCount: 2 });
	});
	test("rebuilds the same average as a reload after /tps reset", () => {
		const fresh = metric({ outputTokens: 40, rateMs: 2000, ttftMs: 500 });
		const agg = emptyAggregates();
		recordInFlight(agg, [fresh]);
		expect(agg).toEqual(aggregatesFromBranch(branch([RESET_ENTRY, {}], [METRIC_ENTRY, fresh])));
	});
	test("skips unusable in-flight metrics", () => {
		const agg = emptyAggregates();
		recordInFlight(agg, [metric({ stopReason: "toolUse" }), metric({ ttftMs: undefined })]);
		expect(agg).toEqual(emptyAggregates());
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
	test("null data does not crash the scan", () => {
		expect(activeFromBranch(branch([STATE_ENTRY, null]))).toBeUndefined();
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
		expect(agg).toEqual({ totalTokens: 150, totalRateMs: 3000, ttftSumMs: 2000, ttftCount: 2 });
	});
	test("ignores unusable metrics and other entry types", () => {
		const agg = aggregatesFromBranch(
			branch(
				[METRIC_ENTRY, metric({ stopReason: "toolUse" })],
				["other", metric()],
			),
		);
		expect(agg).toEqual(emptyAggregates());
	});
	test("a reset marker clears everything recorded before it", () => {
		const agg = aggregatesFromBranch(
			branch(
				[METRIC_ENTRY, metric({ outputTokens: 100, rateMs: 2000 })],
				[RESET_ENTRY, {}],
				[METRIC_ENTRY, metric({ outputTokens: 25, rateMs: 500, ttftMs: 250 })],
			),
		);
		expect(agg).toEqual({ totalTokens: 25, totalRateMs: 500, ttftSumMs: 250, ttftCount: 1 });
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
			rateMs: 4500,
			outputTokens: 100,
			stopReason: "stop",
			rateBasis: "stream",
		});
	});
	test("uses the full request window when reasoning is hidden", () => {
		const m = metricFromTiming(
			timing({ api: "openai-responses" }),
			assistantMessage({ usage: { output: 100, reasoning: 40 } as AssistantMessage["usage"] }),
			6000,
		);
		expect(m.ttftMs).toBe(500);
		expect(m.rateMs).toBe(5000);
		expect(m.rateBasis).toBe("request");
	});
	test("leaves TTFT undefined and rate zero when no delta arrived", () => {
		const m = metricFromTiming(timing({ firstDeltaMs: undefined }), assistantMessage(), 6000);
		expect(m.ttftMs).toBeUndefined();
		expect(m.rateMs).toBe(0);
	});
});

describe("metricLine", () => {
	test("formats a usable metric", () => {
		expect(metricLine(metric())).toBe("⏱ 1.00s · 27.2 tok/s");
	});
	test("returns undefined for unusable metrics", () => {
		expect(metricLine(metric({ stopReason: "toolUse" }))).toBeUndefined();
	});
});

describe("entryMetricLine", () => {
	test("formats a usable persisted metric", () => {
		expect(entryMetricLine(metric())).toBe("⏱ 1.00s · 27.2 tok/s");
	});
	test("returns undefined for malformed data instead of throwing", () => {
		for (const data of [undefined, null, "⏱ 1.00s", 3, true, []]) {
			expect(entryMetricLine(data)).toBeUndefined();
		}
	});
	test("returns undefined for unusable or older metric data", () => {
		expect(entryMetricLine({})).toBeUndefined();
		expect(entryMetricLine(metric({ stopReason: "toolUse" }))).toBeUndefined();
		expect(entryMetricLine({ ...metric(), version: 2 })).toBeUndefined();
	});
});

describe("summaryLine", () => {
	test("shows nothing before the first measurement", () => {
		expect(summaryLine(emptyAggregates())).toBeUndefined();
	});
	test("shows averages once measurements exist", () => {
		expect(summaryLine({ totalTokens: 272, totalRateMs: 10_000, ttftSumMs: 8820, ttftCount: 1 })).toBe(
			"⏱ 8.82s · 27.2 tok/s",
		);
	});
});

describe("formatting", () => {
	test("fmtSeconds renders two decimals", () => {
		expect(fmtSeconds(8820)).toBe("8.82s");
		expect(fmtSeconds(500)).toBe("0.50s");
	});
	test("fmtTps rounds fast streams to integers and keeps one decimal below 100", () => {
		expect(fmtTps(272, 10_000)).toBe("27.2");
		expect(fmtTps(2500, 10_000)).toBe("250");
		expect(fmtTps(0, 10_000)).toBe("0.0");
	});
	test("fmtTps never divides by zero", () => {
		expect(fmtTps(100, 0)).toBe("?");
	});
});
