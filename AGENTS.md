# pi-tps

Per-request TTFT and tokens-per-second timing for Pi, with session averages in the footer.

## Stack

TypeScript, Bun, and the Pi extension API (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`).
Pi loads the TypeScript entrypoint directly; there is no build step.

## Architecture

- `extensions/index.ts` owns Pi lifecycle hooks, timing capture, the `/tps` command, and footer/row rendering.
- Pure functions (`chooseRateBasis`, `isUsableMetric`, `aggregatesFromBranch`, `activeFromBranch`, `recordInFlight`, `entryMetricLine`, global state) are exported for tests and own all policy decisions.
- Timing entries (`tps-metric`) persist as session entries so rows and averages survive reloads and follow the active branch after `/tree`. `tps-reset` markers keep `/tps reset` durable; they render nothing.
- Row visibility is closure state seeded from the shared on/off file, because Pi rebuilds the transcript before `session_start` on `/reload`, `/resume`, and `/fork`; `session_start` then restores it from the branch.
- Throughput uses the emitted stream, or the full request window when the provider reports hidden reasoning tokens (`openai-responses`, `openai-codex-responses`, `azure-openai-responses`).
- The extension never changes request handling; it only observes request/message events and renders.

## Testing

```bash
bun run check
```

Run `git diff --check` before committing. Keep tests deterministic; use temporary directories for global-state paths.

## Integration discipline

Merge only a coherent, independently usable change with a tested contract. Before merging, run `bun run check` and inspect the complete diff. When changing rate-basis or aggregation policy, keep `chooseRateBasis`, `isUsableMetric`, `aggregatesFromBranch`, `recordInFlight`, and `entryMetricLine` covered by tests.
