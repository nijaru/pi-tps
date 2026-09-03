# pi-tps

Per-request latency and throughput timing for [pi](https://github.com/earendil-works/pi).

When enabled, pi-tps shows one timing line below each completed assistant response in the transcript. The footer shows the averages for the current session using the same format:

```text
⏱ 8.82s · 27.2 tok/s
```

## Metrics

- **Latency** — time from request start to the first thinking or text token.
- **Throughput** — reported output tokens per second after the first token, or across the full request when reasoning is hidden.

Tool calls and incomplete responses are omitted.

## Usage

```text
/tps          Toggle timing on or off
/tps on       Enable timing
/tps off      Disable timing
/tps status   Show timing status
/tps reset    Clear session averages
```

Timing state and measurements persist with the session and follow the active branch after `/reload` or `/tree` navigation. The last on/off value is also saved to `~/.pi/agent/extensions/pi-tps.json`, so new sessions start with timing as it was last set.

## Install

```text
pi install git:github.com/nijaru/pi-tps
```

## License

MIT
