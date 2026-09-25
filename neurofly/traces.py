"""What a day of visitors leaves behind in the brain.

The connectome model has no learning of its own, so the installation adds
three explicit, documented rules. Each is a curatorial choice, not
biology, and every number is a parameter:

* **Stimulation is a moment.** An activation started by a visitor fades
  after ``hold_s`` seconds of wall time, like a hand lifted from a
  button. Otherwise by evening everything would be on.
* **Lesions and new connections stay.** Silenced neurons and hand-made
  synapses persist until someone removes them or the day is reset.
* **Use leaves a trace.** Every spike a neuron fires makes all of its
  outgoing synapses a little stronger (``alpha`` per spike, capped at
  ``gain_max``), and the trace decays back toward 1 with a time constant
  of ``tau_h`` hours. Paths that visitors used today carry signals better
  tonight than they did this morning.

Everything (manipulations, gains, the journal of actions) is saved to
``data/state/`` every ``save_every_s`` seconds and restored on start, so a
power cut or restart does not wipe the day.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from .model import FlyBrain


@dataclass
class TraceParams:
    hold_s: float = 20.0        # wall seconds a visitor's activation lasts (0 = forever)
    alpha: float = 1e-4         # gain added to a neuron's outputs per spike
    gain_max: float = 1.6       # ceiling of the trace
    tau_h: float = 8.0          # hours for the trace to decay by 1/e
    save_every_s: float = 30.0
    journal_max: int = 20000


class Traces:
    def __init__(self, brain: FlyBrain, params: TraceParams, state_dir: Path | str, fresh: bool = False):
        self.brain = brain
        self.p = params
        self.dir = Path(state_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.journal: list[dict] = []
        self.expires: dict[int, float] = {}   # stimulated neuron -> wall time it switches off
        self.started = time.time()
        self.last_save = time.time()
        self.day_spikes = 0
        if not fresh:
            self.load()

    # ------------------------------------------------------------ journal
    def log(self, action: str, **detail) -> dict:
        entry = {"t": time.time(), "model_ms": self.brain.t_ms, "action": action, **detail}
        self.journal.append(entry)
        if len(self.journal) > self.p.journal_max:
            del self.journal[: len(self.journal) - self.p.journal_max]
        return entry

    def summary(self) -> dict:
        counts: dict[str, int] = {}
        for e in self.journal:
            counts[e["action"]] = counts.get(e["action"], 0) + 1
        g = self.brain.gain
        return {
            "actions": len(self.journal),
            "by_action": counts,
            "since": self.journal[0]["t"] if self.journal else self.started,
            "recent": self.journal[-8:],
            "traced_neurons": int((g > 1.001).sum()),
            "gain_max": float(g.max()),
            "gain_mean_traced": float(g[g > 1.001].mean()) if (g > 1.001).any() else 1.0,
            "day_spikes": self.day_spikes,
        }

    # ------------------------------------------------------- per window
    def after_window(self, spiked: np.ndarray, window_ms: float) -> list[int]:
        """Update traces and expire activations. Returns neurons switched off."""
        b, p = self.brain, self.p
        self.day_spikes += int(spiked.size)
        if p.alpha > 0 and spiked.size:
            hit, n = np.unique(spiked, return_counts=True)
            b.gain[hit] = np.minimum(p.gain_max, b.gain[hit] + p.alpha * n)
        self._pending_ms = getattr(self, "_pending_ms", 0.0) + window_ms
        if p.tau_h > 0 and self._pending_ms >= 1000.0:
            decay = np.exp(-(self._pending_ms / 1000.0) / (p.tau_h * 3600.0))
            self._pending_ms = 0.0
            traced = b.gain != 1.0
            if traced.any():
                g = 1.0 + (b.gain[traced] - 1.0) * decay
                g[np.abs(g - 1.0) < 1e-6] = 1.0
                b.gain[traced] = g
        expired = []
        if self.expires:
            now = time.time()
            expired = [i for i, t in self.expires.items() if t <= now]
            if expired:
                b.deactivate(expired)
                for i in expired:
                    self.expires.pop(i, None)
        return expired

    def hold(self, idx, hold_s: float | None = None) -> None:
        h = self.p.hold_s if hold_s is None else hold_s
        if h <= 0:
            for i in idx:
                self.expires.pop(int(i), None)
            return
        until = time.time() + h
        for i in idx:
            self.expires[int(i)] = until

    def release(self, idx=None) -> None:
        if idx is None:
            self.expires.clear()
        else:
            for i in idx:
                self.expires.pop(int(i), None)

    # ------------------------------------------------------ persistence
    def save(self, force: bool = False) -> None:
        if not force and time.time() - self.last_save < self.p.save_every_s:
            return
        b = self.brain
        state = {
            "saved": time.time(),
            "release": b.release,
            "silenced": [int(i) for i in np.flatnonzero(b.silenced)],
            "extra": [[int(pre), int(p), float(w)] for pre, (posts, ws) in b.extra.items() for p, w in zip(posts, ws)],
            "journal": self.journal[-self.p.journal_max:],
            "day_spikes": self.day_spikes,
            "params": asdict(self.p),
        }
        tmp = self.dir / "state.json.tmp"
        tmp.write_text(json.dumps(state))
        tmp.replace(self.dir / "state.json")
        np.save(self.dir / "gain.npy", b.gain)
        self.last_save = time.time()

    def load(self) -> bool:
        f = self.dir / "state.json"
        if not f.exists():
            return False
        try:
            state = json.loads(f.read_text())
        except Exception:
            return False
        b = self.brain
        if state.get("release") not in (None, b.release):
            return False
        b.unsilence()
        if state.get("silenced"):
            b.silence(state["silenced"])
        b.disconnect()
        for pre, post, w in state.get("extra", []):
            b.connect(pre, post, abs(w), 1 if w > 0 else -1)
        self.journal = state.get("journal", [])
        self.day_spikes = int(state.get("day_spikes", 0))
        g = self.dir / "gain.npy"
        if g.exists():
            arr = np.load(g)
            if arr.shape == b.gain.shape:
                b.gain[:] = arr
        return True

    def new_day(self) -> None:
        """Forget everything: manipulations, traces, journal."""
        self.brain.clear()
        self.brain.gain[:] = 1.0
        self.journal.clear()
        self.expires.clear()
        self.day_spikes = 0
        self.started = time.time()
        self.save(force=True)
