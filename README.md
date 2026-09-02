# pi-req-timer

Per-request latency and throughput timing for [pi](https://github.com/earendil-works/pi).

When enabled, each assistant message gets a one-line timing entry in the transcript:

```
⏱ ttft 0.42s · 45.3 tok/s
```

While active, the footer shows token-weighted session averages:

```
⏱ ttft 0.91s · tps 48
```

## Metrics

- **TTFT** — time from request start to the first thinking or text token.
- **TPS** — (output + reasoning tokens) divided by streaming time after the first token.

Token counts are used for the weighted average but never displayed; the footer already reports token usage. Averages cover the current session branch and are rebuilt from session entries after reload or `/tree` navigation.

## Usage

```
/timer          Toggle on/off
/timer on|off   Set explicitly
/timer status   Show current state
/timer reset    Clear session averages
```

The toggle state persists per session, so it survives restarts and `/tree` navigation.

## Install

```
pi install git:github.com/nijaru/pi-req-timer
```

## Notes

- Only main agent-loop assistant messages are timed. Compaction sub-calls and
  subagents run in separate sessions and are excluded.
- Streams aborted before the first token are skipped.

## License

MIT
