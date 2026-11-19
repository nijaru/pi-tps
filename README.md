# pi-tps

Per-request latency and throughput timing for [pi](https://github.com/earendil-works/pi).

When enabled, pi-tps shows one timing line below each completed assistant response that streams visible text, including responses that also call tools:

```text
⏱ 8.82s · 27.2 tok/s (stream)
```

## Metrics

- **Latency** — time from provider invocation (the assistant message timestamp) to the first non-blank text delta. Thinking does not stop this clock, whether Pi shows or hides thinking blocks. It includes provider-side request preparation and the wait for reasoning, but not Pi’s earlier credential lookup.
- **Throughput** — reported output tokens divided by the elapsed time. `stream` starts at the first text, thinking, or tool-call output. `request` starts at provider invocation when the provider reports a positive reasoning token count: even a streamed thinking block may be a summary, so pi-tps cannot tell how much reasoning happened before the first output. It also uses `request` when all output arrives in a single chunk. The output count already includes any reported reasoning tokens.

These throughput windows measure different things; neither is a visible-text-only generation rate.

The footer shows mean visible-text latency and pooled throughput (total output tokens divided by total measured time) for the active branch since the last reset. A `mixed` footer combines both timing windows; don’t use it to compare raw generation speeds.

Previously saved rows retain their original latency to the first thinking or text delta. The footer uses that older latency only until visible-text measurements exist; it never blends the two latency definitions. Throughput includes both old and new rows.

Codemode follows the same rules as any other tool: a response with prose and a tool call can get a row, but tool-only responses, tool execution, and nested model calls are not timed. Responses without a non-blank text delta and failed or aborted responses are also omitted.

## Usage

```text
/tps          Toggle timing on or off
/tps on       Enable timing
/tps off      Disable timing
/tps status   Show timing status
/tps reset    Clear session averages
```

Timing state and measurements persist with the session and follow the active branch after `/reload` or `/tree` navigation. `/tps reset` clears the session averages and stays cleared across reloads and branch navigation. The last on/off value is also saved under the agent config directory (`~/.pi/agent/extensions/pi-tps.json` by default), so new sessions start with timing as it was last set. If that default cannot be saved, the toggle reports an error and leaves the session unchanged.

Turning timing off discards any unfinished measurement and clears the footer right away. Saved timing rows remain visible, including after `/reload`, `/resume`, and `/tree` navigation.

## Install

```text
pi install npm:@nijaru/pi-tps
```

## License

MIT
