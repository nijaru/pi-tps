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

Timing state and measurements persist with the session and follow the active branch after `/reload` or `/tree` navigation. `/tps reset` clears the session averages and stays cleared across reloads and branch navigation. The last on/off value is also saved under the agent config directory (`~/.pi/agent/extensions/pi-tps.json` by default), so new sessions start with timing as it was last set.

Turning timing off clears the footer right away. Rows already in the transcript disappear the next time the transcript is rebuilt (for example after `/reload` or `/tree` navigation).

## Install

```text
pi install npm:@nijaru/pi-tps
```

## License

MIT
