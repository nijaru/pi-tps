# pi-req-timer

Per-request latency and throughput timing for [pi](https://github.com/earendil-works/pi).

When enabled, pi-req-timer shows one timing line below each completed assistant response in the transcript. The footer shows the averages for the current session using the same format:

```text
⏱ 8.82s · 27.2 tok/s
```

## Metrics

- **Latency** — time from request start to the first thinking or text token.
- **Throughput** — reported output tokens per second after the first token, or across the full request when reasoning is hidden.

Tool calls and incomplete responses are omitted.

## Usage

```text
/timer          Toggle timing on or off
/timer on       Enable timing
/timer off      Disable timing
/timer status   Show timing status
/timer reset    Clear session averages
```

Timing state and measurements persist with the session and follow the active branch after `/reload` or `/tree` navigation.

## Install

```text
pi install git:github.com/nijaru/pi-req-timer
```

## License

MIT
