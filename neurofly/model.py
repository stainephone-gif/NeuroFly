"""Leaky integrate-and-fire network with alpha synapses (NumPy backend).

The dynamics reproduce the Brian2 model of Shiu et al. (Nature 2024)
step by step, so results can be compared with the original code:

* membrane:  ``dv/dt = (v_0 - v + g) / t_mbr``   (frozen while refractory)
* synapse:   ``dg/dt = -g / tau``                  (frozen while refractory)
* spike when ``v > v_th``; then ``v = v_rst`` and ``g = 0``
* every spike of presynaptic neuron *i* adds ``w_syn * W[j, i]`` mV to
  ``g`` of each target *j* after a delay ``t_dly``
* while refractory a neuron ignores *all* input (Brian2 blocks writes to
  ``(unless refractory)`` variables), so spikes that arrive in that
  window are simply lost
* "activated" neurons get a Poisson train of large kicks to ``v``
  (``w_syn * f_poi`` mV, enough for one spike each) at a chosen rate and
  lose their refractory period, as in optogenetic activation
* "silenced" neurons keep spiking but their outgoing synapses are muted,
  as in the original ``silence()`` which zeroes weights *from* them

Both differential equations are linear, so each 0.1 ms step is
integrated exactly (Brian2 ``method='linear'``) instead of by Euler.
The order inside one step also follows Brian2's default schedule:
integrate -> detect spikes -> deliver delayed synaptic input and Poisson
kicks -> reset the neurons that spiked.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np
import pandas as pd
import scipy.sparse as sp

NeuronRef = int  # FlyWire root id (>= 2**40) or matrix index (< 2**40)
_INDEX_LIMIT = 1 << 40


@dataclass
class Params:
    """Model constants (ms, mV). Defaults are ``default_params`` of Shiu et al."""

    dt: float = 0.1       # integration step, ms
    v_0: float = -52.0    # resting potential, mV
    v_rst: float = -52.0  # reset potential after a spike, mV
    v_th: float = -45.0   # spike threshold, mV
    t_mbr: float = 20.0   # membrane time constant, ms
    tau: float = 5.0      # synaptic time constant, ms
    t_rfc: float = 2.2    # refractory period, ms
    t_dly: float = 1.8    # synaptic delay, ms
    w_syn: float = 0.275  # weight of one synapse, mV (the one free parameter)
    f_poi: float = 250.0  # Poisson kick = w_syn * f_poi mV
    eps: float = 0.2      # mV; below this a neuron counts as "at rest" (fast path only; 3 % of the 7 mV gap to threshold)

    def steps(self, t_ms: float) -> int:
        return int(round(t_ms / self.dt))


class SpikeRecord:
    """Spikes of one run: parallel arrays of times (ms) and neuron indices."""

    def __init__(self, t_ms: np.ndarray, index: np.ndarray, ids: np.ndarray, duration_ms: float, trial: int = 0):
        self.t_ms = np.asarray(t_ms, dtype=np.float64)
        self.index = np.asarray(index, dtype=np.int64)
        self.ids = ids
        self.duration_ms = float(duration_ms)
        self.trial = trial

    def __len__(self) -> int:
        return len(self.t_ms)

    def __repr__(self) -> str:
        return f"SpikeRecord({len(self)} spikes, {self.n_active} active neurons, {self.duration_ms:g} ms)"

    @property
    def n_active(self) -> int:
        return int(np.unique(self.index).size)

    def counts(self) -> pd.Series:
        """Spike count per neuron (index = FlyWire id), active neurons only."""
        idx, cnt = np.unique(self.index, return_counts=True)
        return pd.Series(cnt, index=pd.Index(self.ids[idx], name="flywire_id"), name="count")

    def rates(self) -> pd.Series:
        """Mean firing rate in Hz per neuron, sorted from most to least active."""
        r = self.counts() / (self.duration_ms / 1000.0)
        r.name = "rate_hz"
        return r.sort_values(ascending=False)

    def rate_of(self, neuron: NeuronRef) -> float:
        """Firing rate (Hz) of one neuron, 0 if it was silent."""
        rates = self.rates()
        key = neuron if neuron >= _INDEX_LIMIT else int(self.ids[neuron])
        return float(rates.get(key, 0.0))

    def to_frame(self) -> pd.DataFrame:
        """One row per spike, same columns as the Shiu et al. output."""
        return pd.DataFrame(
            {
                "t": self.t_ms / 1000.0,  # seconds, as in the original
                "time_ms": self.t_ms,
                "trial": self.trial,
                "neuron_index": self.index,
                "flywire_id": self.ids[self.index],
            }
        )

    @staticmethod
    def mean_rates(records: Sequence["SpikeRecord"]) -> pd.DataFrame:
        """Mean and std of per-neuron rates across several trials."""
        table = pd.concat([r.rates() for r in records], axis=1).fillna(0.0)
        out = pd.DataFrame({"rate_hz": table.mean(axis=1), "std_hz": table.std(axis=1, ddof=0)})
        return out.sort_values("rate_hz", ascending=False)


class FlyBrain:
    """The whole-brain network. See the module docstring for the dynamics.

    Parameters
    ----------
    weights
        ``n x n`` sparse matrix of signed synapse counts, ``weights[post, pre]``.
        Stored internally as CSC so a presynaptic column is one contiguous slice.
    ids
        FlyWire root id of each index.
    params
        Model constants; defaults reproduce Shiu et al.
    seed
        Seed of the Poisson generator. ``None`` gives a fresh random stream.
    """

    def __init__(
        self,
        weights: sp.spmatrix,
        ids: Iterable[int],
        params: Params | None = None,
        seed: int | None = None,
        release: str = "",
    ):
        self.p = params or Params()
        self.release = str(release)  # FlyWire release the ids belong to (informational)
        W = sp.csc_matrix(weights, dtype=np.float32)
        W.sum_duplicates()
        self.W = W
        self.n = W.shape[0]
        self.ids = np.asarray(list(ids), dtype=np.int64)
        if len(self.ids) != self.n:
            raise ValueError("ids and weight matrix size differ")
        self.id2idx = {int(i): k for k, i in enumerate(self.ids)}
        self.rng = np.random.default_rng(seed)

        p = self.p
        # exact integration of the linear system over one step
        self._A = np.exp(-p.dt / p.t_mbr)
        self._C = np.exp(-p.dt / p.tau)
        self._B = p.tau / (p.tau - p.t_mbr) * (self._C - self._A)
        self.delay_steps = max(1, p.steps(p.t_dly))
        self._base_rfc_steps = p.steps(p.t_rfc)

        # manipulations (survive reset())
        self.stim_rate = np.zeros(self.n)           # Hz, per neuron
        self.silenced = np.zeros(self.n, dtype=bool)
        self.rfc_steps = np.full(self.n, self._base_rfc_steps, dtype=np.int64)
        # synapses added by hand: pre index -> (post indices, signed counts)
        self.extra: dict[int, tuple[np.ndarray, np.ndarray]] = {}
        self._extra_dirty = True
        # per-neuron multiplier on all outgoing synapses (1 = connectome as is)
        self.gain = np.ones(self.n, dtype=np.float64)

        # fast path (numba): set of neurons that are not at rest
        from . import fast as _fast
        self.fast = _fast.AVAILABLE
        self.awake = np.zeros(self.n, dtype=bool)
        self._awake_list = np.zeros(self.n, dtype=np.int64)
        self._n_awake = 0
        self._awake_dirty = True
        self._spk_buf = np.zeros(self.n, dtype=np.int64)
        if seed is not None and self.fast:
            _fast.seed(int(seed))

        self.reset()

    # ----------------------------------------------------------------- utils
    def index(self, neurons: NeuronRef | Iterable[NeuronRef]) -> np.ndarray:
        """Matrix indices for FlyWire ids and/or indices (any mix)."""
        if isinstance(neurons, (int, np.integer)):
            neurons = [neurons]
        out = []
        for nrn in neurons:
            nrn = int(nrn)
            if nrn >= _INDEX_LIMIT:
                if nrn not in self.id2idx:
                    raise KeyError(f"FlyWire id {nrn} is not in this connectome release")
                out.append(self.id2idx[nrn])
            else:
                if not 0 <= nrn < self.n:
                    raise IndexError(f"neuron index {nrn} out of range")
                out.append(nrn)
        return np.asarray(out, dtype=np.int64)

    @property
    def t_ms(self) -> float:
        return self.k * self.p.dt

    # --------------------------------------------------------- manipulations
    def activate(self, neurons: NeuronRef | Iterable[NeuronRef], rate_hz: float = 150.0) -> None:
        """Drive neurons with Poisson kicks at ``rate_hz`` (0 removes the drive)."""
        idx = self.index(neurons)
        self.stim_rate[idx] = rate_hz
        self.rfc_steps[idx] = 0 if rate_hz > 0 else self._base_rfc_steps
        self._refresh_stim()

    def deactivate(self, neurons: NeuronRef | Iterable[NeuronRef] | None = None) -> None:
        """Remove Poisson drive from the given neurons (all if ``None``)."""
        idx = self.index(neurons) if neurons is not None else np.flatnonzero(self.stim_rate)
        self.stim_rate[idx] = 0.0
        self.rfc_steps[idx] = self._base_rfc_steps
        self._refresh_stim()

    def silence(self, neurons: NeuronRef | Iterable[NeuronRef]) -> None:
        """Mute all outgoing synapses of the given neurons (a digital lesion)."""
        self.silenced[self.index(neurons)] = True

    def unsilence(self, neurons: NeuronRef | Iterable[NeuronRef] | None = None) -> None:
        if neurons is None:
            self.silenced[:] = False
        else:
            self.silenced[self.index(neurons)] = False

    def connect(self, pre: NeuronRef, post: NeuronRef | Iterable[NeuronRef], n_synapses: float = 10, sign: int = 1) -> None:
        """Add a hand-made connection from ``pre`` to ``post``.

        ``n_synapses`` sets the strength in units of one synapse (``w_syn``),
        ``sign`` +1 for excitatory, -1 for inhibitory. Repeated calls for
        the same pair add up. Extra connections are kept in ``self.extra``
        and are separate from the connectome, so ``disconnect`` restores
        the original wiring exactly.
        """
        i = int(self.index(pre)[0])
        posts = self.index(post)
        old_post, old_w = self.extra.get(i, (np.empty(0, np.int64), np.empty(0, np.float32)))
        new_post = np.concatenate([old_post, posts])
        new_w = np.concatenate([old_w, np.full(posts.size, sign * float(n_synapses), dtype=np.float32)])
        # merge duplicates
        uniq, inv = np.unique(new_post, return_inverse=True)
        merged = np.zeros(uniq.size, dtype=np.float32)
        np.add.at(merged, inv, new_w)
        keep = merged != 0
        if keep.any():
            self.extra[i] = (uniq[keep], merged[keep])
        else:
            self.extra.pop(i, None)
        self._extra_dirty = True

    def disconnect(self, pre: NeuronRef | None = None, post: NeuronRef | None = None) -> None:
        """Remove hand-made connections (all, all from ``pre``, or one pair)."""
        self._extra_dirty = True
        if pre is None:
            self.extra.clear()
            return
        i = int(self.index(pre)[0])
        if i not in self.extra:
            return
        if post is None:
            del self.extra[i]
            return
        j = int(self.index(post)[0])
        posts, w = self.extra[i]
        keep = posts != j
        if keep.any():
            self.extra[i] = (posts[keep], w[keep])
        else:
            del self.extra[i]

    def _extra_csc(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Hand-made synapses as CSC arrays (indptr, indices, data)."""
        if self._extra_dirty or not hasattr(self, "_e_indptr"):
            indptr = np.zeros(self.n + 1, dtype=np.int64)
            idx, dat = [], []
            for i in sorted(self.extra):
                posts, w = self.extra[i]
                indptr[i + 1] = len(posts)
                idx.append(posts)
                dat.append(w)
            np.cumsum(indptr, out=indptr)
            self._e_indptr = indptr
            self._e_indices = np.concatenate(idx).astype(np.int64) if idx else np.zeros(0, np.int64)
            self._e_data = np.concatenate(dat).astype(np.float32) if dat else np.zeros(0, np.float32)
            self._extra_dirty = False
        return self._e_indptr, self._e_indices, self._e_data

    def n_extra(self) -> int:
        return sum(len(p) for p, _ in self.extra.values())

    def synapses_of(self, neuron: NeuronRef, direction: str = "out") -> tuple[np.ndarray, np.ndarray]:
        """Connectome partners of a neuron: ``(indices, signed synapse counts)``.

        ``direction`` "out" lists postsynaptic targets, "in" presynaptic
        sources. Hand-made connections are included for "out".
        """
        i = int(self.index(neuron)[0])
        W = self.W
        if direction == "out":
            sl = slice(W.indptr[i], W.indptr[i + 1])
            idx, w = W.indices[sl].astype(np.int64), W.data[sl].astype(np.float32)
            if i in self.extra:
                idx = np.concatenate([idx, self.extra[i][0]])
                w = np.concatenate([w, self.extra[i][1]])
            return idx, w
        if not hasattr(self, "_Wr"):
            self._Wr = W.tocsr()
        sl = slice(self._Wr.indptr[i], self._Wr.indptr[i + 1])
        return self._Wr.indices[sl].astype(np.int64), self._Wr.data[sl].astype(np.float32)

    def clear(self) -> None:
        """Remove every manipulation and reset the state."""
        self.deactivate()
        self.unsilence()
        self.disconnect()
        self.reset()

    def _refresh_stim(self) -> None:
        self._stim_idx = np.flatnonzero(self.stim_rate)
        self._stim_prob = self.stim_rate[self._stim_idx] * self.p.dt / 1000.0
        self._stim_prob_all = self.stim_rate * self.p.dt / 1000.0
        self._awake_dirty = True

    # ------------------------------------------------------------------ state
    def reset(self) -> None:
        """Put every neuron back to rest and empty the delay line."""
        p = self.p
        self.k = 0
        self.v = np.full(self.n, p.v_0, dtype=np.float64)
        self.g = np.zeros(self.n, dtype=np.float64)
        self.last_spike = np.full(self.n, -(1 << 40), dtype=np.int64)
        # delay line: slot s holds the neurons that spiked D steps before it is read
        self._ring = np.zeros((self.delay_steps + 1, self.n), dtype=np.int64)
        self._ring_len = np.zeros(self.delay_steps + 1, dtype=np.int64)
        self._refresh_stim()

    def inject_spikes(self, neurons: NeuronRef | Iterable[NeuronRef], steps_ago: int = 1) -> None:
        """Pretend the given neurons spiked ``steps_ago`` steps ago (testing aid)."""
        idx = self.index(neurons)
        slot = (self.k - steps_ago + self.delay_steps) % (self.delay_steps + 1)
        self._ring[slot, : idx.size] = idx
        self._ring_len[slot] = idx.size

    # ------------------------------------------------------------- dynamics
    def step(self) -> np.ndarray:
        """Advance one ``dt``; return indices of neurons that spiked."""
        p = self.p
        k = self.k
        v, g = self.v, self.g

        # 0. neurons still in their refractory period are frozen
        # Brian2: not_refractory = timestep(t - lastspike, dt) >= timestep(t_rfc, dt)
        refr = (k - self.last_spike) < self.rfc_steps
        ridx = np.flatnonzero(refr)
        if ridx.size:
            v_keep = v[ridx].copy()
            g_keep = g[ridx].copy()

        # 1. exact integration over dt
        v -= p.v_0
        v *= self._A
        v += self._B * g
        v += p.v_0
        g *= self._C
        if ridx.size:
            v[ridx] = v_keep
            g[ridx] = g_keep

        # 2. threshold
        spk = np.flatnonzero(v > p.v_th)
        if ridx.size and spk.size:
            spk = spk[~refr[spk]]

        # 3a. synaptic input from spikes emitted delay_steps ago.
        # Brian2 drops every write to an "(unless refractory)" variable of a
        # refractory neuron, so input arriving in that window is lost.
        L = self.delay_steps + 1
        slot = k % L
        pre = self._ring[slot, : self._ring_len[slot]]
        if pre.size:
            pre = pre[~self.silenced[pre]]
            if pre.size:
                inc = self._outgoing(pre)
                if self.extra:
                    for i in pre:
                        hit = self.extra.get(int(i))
                        if hit is not None:
                            inc[hit[0]] += hit[1] * self.gain[i]
                if ridx.size:
                    inc[ridx] = 0.0
                g += p.w_syn * inc
        ws = (k + self.delay_steps) % L
        self._ring[ws, : spk.size] = spk
        self._ring_len[ws] = spk.size

        # 3b. Poisson kicks to activated neurons (same refractory rule)
        if self._stim_idx.size:
            hit = self.rng.random(self._stim_idx.size) < self._stim_prob
            if ridx.size:
                hit &= ~refr[self._stim_idx]
            if hit.any():
                v[self._stim_idx[hit]] += p.w_syn * p.f_poi

        # 4. reset spiking neurons
        if spk.size:
            v[spk] = p.v_rst
            g[spk] = 0.0
            self.last_spike[spk] = k

        self.k = k + 1
        self._awake_dirty = True
        return spk

    def _outgoing(self, pre: np.ndarray) -> np.ndarray:
        """Sum of the presynaptic columns of ``W`` for the given neurons."""
        W = self.W
        starts = W.indptr[pre]
        lens = W.indptr[pre + 1] - starts
        total = int(lens.sum())
        if total == 0:
            return np.zeros(self.n)
        # positions of every stored entry of the selected columns
        pos = np.repeat(starts - np.cumsum(lens) + lens, lens) + np.arange(total)
        weights = W.data[pos] * np.repeat(self.gain[pre], lens)
        return np.bincount(W.indices[pos], weights=weights, minlength=self.n)

    def _refresh_awake(self) -> None:
        p = self.p
        refr = (self.k - self.last_spike) < self.rfc_steps
        awake = refr | (np.abs(self.v - p.v_0) > p.eps) | (np.abs(self.g) > p.eps) | (self.stim_rate > 0)
        self.awake = awake
        idx = np.flatnonzero(awake)
        self._awake_list[: idx.size] = idx
        self._n_awake = int(idx.size)
        self._awake_dirty = False

    def run_fast(self, n_steps: int, max_spikes: int | None = None) -> tuple[np.ndarray, np.ndarray]:
        """Advance ``n_steps`` with the numba kernel; returns ``(step, index)`` of spikes."""
        from . import fast as _fast

        p = self.p
        if self._awake_dirty:
            self._refresh_awake()
        e_indptr, e_indices, e_data = self._extra_csc()
        cap = max_spikes or max(200_000, 400 * n_steps)
        if getattr(self, "_out_cap", 0) < cap:
            self._out_t = np.empty(cap, dtype=np.int64)
            self._out_i = np.empty(cap, dtype=np.int64)
            self._out_cap = cap
        out_t, out_i = self._out_t, self._out_i
        W = self.W
        n_awake, n_out = _fast.run_window(
            int(n_steps), int(self.k),
            self.v, self.g, self.last_spike, self.rfc_steps, self.silenced, self.gain,
            self._stim_idx, self._stim_prob_all,
            self.awake, self._awake_list, int(self._n_awake), self._spk_buf,
            W.indptr, W.indices, W.data,
            e_indptr, e_indices, e_data,
            self._ring, self._ring_len, int(self.delay_steps),
            float(self._A), float(self._B), float(self._C), float(p.v_0), float(p.v_th), float(p.v_rst),
            float(p.w_syn), float(p.w_syn * p.f_poi), float(p.eps),
            out_t, out_i,
        )
        self._n_awake = int(n_awake)
        self.k += int(n_steps)
        return out_t[:n_out].copy(), out_i[:n_out].copy()

    @property
    def n_awake(self) -> int:
        if self._awake_dirty:
            self._refresh_awake()
        return self._n_awake

    def run(self, t_ms: float, record: bool = True, progress: bool = False, trial: int = 0) -> SpikeRecord:
        """Simulate ``t_ms`` milliseconds from the current state."""
        n_steps = self.p.steps(t_ms)
        k0 = self.k
        times, idxs = [], []
        if self.fast:
            chunk = 1000
            done = 0
            while done < n_steps:
                m = min(chunk, n_steps - done)
                st, ix = self.run_fast(m)
                if record and ix.size:
                    times.append(st * self.p.dt)
                    idxs.append(ix)
                done += m
                if progress and (done % max(chunk, n_steps // 10) == 0 or done == n_steps):
                    print(f"  {100 * done // n_steps:3d}%  t = {self.t_ms:8.1f} ms", flush=True)
        else:
            report = max(1, n_steps // 10) if progress else 0
            for i in range(n_steps):
                spk = self.step()
                if record and spk.size:
                    idxs.append(spk)
                    times.append(np.full(spk.size, (self.k - 1) * self.p.dt))
                if report and (i + 1) % report == 0:
                    print(f"  {100 * (i + 1) // n_steps:3d}%  t = {self.t_ms:8.1f} ms", flush=True)
        if idxs:
            t = np.concatenate(times) - k0 * self.p.dt
            ix = np.concatenate(idxs)
        else:
            t = np.empty(0)
            ix = np.empty(0, dtype=np.int64)
        return SpikeRecord(t, ix, self.ids, n_steps * self.p.dt, trial=trial)

    def run_trials(self, t_ms: float, n_trials: int, progress: bool = False) -> list[SpikeRecord]:
        """Independent trials from rest with the same manipulations."""
        out = []
        for i in range(n_trials):
            self.reset()
            if progress:
                print(f"trial {i + 1}/{n_trials}", flush=True)
            out.append(self.run(t_ms, progress=progress, trial=i))
        return out
