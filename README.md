# pi-tps

Per-request latency and throughput timing for [pi](https://github.com/earendil-works/pi).

When enabled, pi-tps shows one timing line below each completed assistant response that streams visible text, including responses that also call tools:

```text
⏱ 8.82s · 27.2 tok/s
```

## Metrics

- **Latency** — time from provider invocation (the assistant message timestamp) to the first non-blank text delta. Thinking does not stop this clock, whether Pi shows or hides thinking blocks. It includes provider-side request preparation and the wait for reasoning, but not Pi’s earlier credential lookup.
- **Throughput** — reported output tokens divided by the measured window: from the first thinking or text delta to completion, or across the full request when reasoning is hidden. Responses APIs use the full request whenever reasoning tokens are reported, even if a reasoning summary is streamed. Reasoning tokens are already included in output; they are not added again.

These throughput windows measure different things; neither is a visible-text-only generation rate.

The footer shows mean visible-text latency and pooled throughput (total output tokens divided by total measured time) for the active branch since the last reset. Measurement-window details stay out of the display.

Previously saved rows retain their original latency to the first thinking or text delta. The footer uses that older latency only until visible-text measurements exist; it never blends the two latency definitions. Throughput includes both old and new rows.

Tool-only responses, responses without an observed non-blank text delta, and failed or aborted responses are omitted.

## Usage

```text
/tps          Toggle timing on or off
/tps on       Enable timing
/tps off      Disable timing
/tps status   Show timing status
/tps reset    Clear session averages
```

Timing state and measurements persist with the session and follow the active branch after `/reload` or `/tree` navigation. `/tps reset` clears the session averages and stays cleared across reloads and branch navigation. The last on/off value is also saved under the agent config directory (`~/.pi/agent/extensions/pi-tps.json` by default), so new sessions start with timing as it was last set.

Turning timing off stops new measurements and clears the footer right away. Saved timing rows remain visible, including after `/reload`, `/resume`, and `/tree` navigation.

## Install

```text
pi install npm:@nijaru/pi-tps
```

## License

MIT
