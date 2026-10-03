"""Event-loop lag watchdog for the worker (all async Hatchet tasks share ONE asyncio loop: market ticks, analysts,
the durable event listener stream). Diagnoses stalls instead of guessing:

  beat task   on the loop: sleeps 1 s, records the lag (how late it woke up). Lag > LOOP_WARN_S (2 s) logs a
              warning with every asyncio task's stack.
  sentinel    a daemon THREAD: when the loop has not beaten for LOOP_WARN_S, it prints the loop thread's Python
              stack while the stall is happening (the blocking call). It also times its own sleeps: if the thread
              itself woke up late, the whole process (or the Docker VM) was paused, not just the loop.
  DESK_LOOP_DEBUG=1  also turns on asyncio debug mode: every callback / task step slower than
              LOOP_SLOW_CALLBACK_S (0.25 s) is logged by asyncio with its task name.

max_lag(since) / stats(since): the lag samples of a time window (close_session reports the session's numbers).
"""
import asyncio
import os
import sys
import threading
import time
import traceback
from collections import deque

WARN_S = float(os.environ.get("LOOP_WARN_S", "2"))
SLOW_CALLBACK_S = float(os.environ.get("LOOP_SLOW_CALLBACK_S", "0.25"))
DEBUG = os.environ.get("DESK_LOOP_DEBUG", "0") == "1"
INTERVAL_S = 1.0

_samples: deque = deque(maxlen=3600)   # (wall time, lag s), one per second: the last hour
_last_beat = time.monotonic()
_started = False


def _log(msg: str) -> None:
    print(f"[loopwatch] {msg}", file=sys.stderr, flush=True)


def _task_stacks() -> str:
    out = []
    for t in list(asyncio.all_tasks())[:200]:
        frames = t.get_stack(limit=1)
        where = f"{frames[-1].f_code.co_filename.rsplit('/', 3)[-1]}:{frames[-1].f_lineno} {frames[-1].f_code.co_name}" if frames else "-"
        out.append(f"  {t.get_name()}: {where}")
    return "\n".join(sorted(out)[:60])


async def _beat() -> None:
    global _last_beat
    while True:
        t0 = time.monotonic()
        await asyncio.sleep(INTERVAL_S)
        now = time.monotonic()
        lag = max(0.0, now - t0 - INTERVAL_S)
        _last_beat = now
        _samples.append((time.time(), lag))
        if lag > WARN_S:
            _log(f"event loop lag {lag:.2f}s (> {WARN_S:g}s); asyncio tasks:\n{_task_stacks()}")


def _sentinel(loop_thread_id: int) -> None:
    reported = 0.0
    while True:
        t0 = time.monotonic()
        time.sleep(0.5)
        now = time.monotonic()
        if now - t0 > WARN_S:  # this thread did not run either: process / VM paused (or GIL held by C code)
            _log(f"process paused: the watchdog thread slept {now - t0:.2f}s instead of 0.5s (host / Docker VM stall or "
                 "a C call holding the GIL), not an asyncio blocking call")
        stalled = now - _last_beat
        if stalled > WARN_S + INTERVAL_S and _last_beat != reported:
            reported = _last_beat
            frame = sys._current_frames().get(loop_thread_id)
            stack = "".join(traceback.format_stack(frame, limit=25)) if frame else "(no frame)"
            _log(f"event loop blocked for {stalled - INTERVAL_S:.2f}s so far; loop thread is in:\n{stack}")


def start() -> None:
    """Start the watchdog on the running loop (call once, from the worker's loop: Hatchet's lifespan)."""
    global _started, _last_beat
    if _started:
        return
    _started = True
    loop = asyncio.get_running_loop()
    if DEBUG:
        loop.set_debug(True)
        loop.slow_callback_duration = SLOW_CALLBACK_S
        import logging

        logging.getLogger("asyncio").setLevel(logging.WARNING)
    _last_beat = time.monotonic()
    loop.create_task(_beat(), name="loopwatch")
    threading.Thread(target=_sentinel, args=(threading.get_ident(),), name="loopwatch", daemon=True).start()
    _log(f"started (warn > {WARN_S:g}s, asyncio debug {'on, slow callback > %gs' % SLOW_CALLBACK_S if DEBUG else 'off'})")


def stats(since: float) -> dict:
    """Lag over samples taken after `since` (time.time()): {"samples", "max_s", "p99_s", "over_1s"}."""
    lags = sorted(lag for ts, lag in list(_samples) if ts >= since)
    if not lags:
        return {"samples": 0, "max_s": 0.0, "p99_s": 0.0, "over_1s": 0}
    return {"samples": len(lags), "max_s": round(lags[-1], 3), "p99_s": round(lags[int(0.99 * (len(lags) - 1))], 3),
            "over_1s": sum(1 for x in lags if x > 1.0)}
