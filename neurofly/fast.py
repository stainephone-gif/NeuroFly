"""Numba kernel: the same dynamics as :meth:`FlyBrain.step`, many steps per call.

Two tricks make it run in real time on one CPU core:

* only "awake" neurons are touched. A neuron sleeps when it sits at rest
  with no synaptic input (|v - v_0| and |g| below ``eps``), which is the
  case for >95 % of the brain at any moment; it wakes up when a spike
  reaches it or when it is stimulated;
* spikes are delivered by walking the presynaptic column of the CSC
  matrix, so cost is proportional to the number of synapses actually
  carrying a spike, not to the size of the brain.

Everything else (integration, thresholds, delays, refractory blocking,
Poisson kicks, reset order) is identical to the NumPy path, which stays
as the reference and the fallback when numba is not installed.
"""

from __future__ import annotations

import numpy as np

try:
    from numba import njit
    AVAILABLE = True
except ImportError:  # pragma: no cover
    AVAILABLE = False

    def njit(*a, **k):  # type: ignore
        def deco(f):
            return f
        return deco if not (a and callable(a[0])) else a[0]


@njit(cache=True)
def seed(s: int) -> None:
    np.random.seed(s)


@njit(cache=True)
def run_window(
    n_steps, k0,
    v, g, last_spike, rfc_steps, silenced, gain,
    stim_idx, stim_prob,
    awake, awake_list, n_awake, spk_buf,
    indptr, indices, data,
    e_indptr, e_indices, e_data,
    ring, ring_len, D,
    A, B, C, v0, vth, vrst, w_syn, kick, eps,
    out_t, out_i,
):
    n_out = 0
    L = D + 1
    cap = out_i.shape[0]
    for s in range(n_steps):
        k = k0 + s
        # 1. integrate awake neurons, detect spikes, compact the awake list
        n_spk = 0
        j = 0
        for a in range(n_awake):
            i = awake_list[a]
            refr = (k - last_spike[i]) < rfc_steps[i]
            if not refr:
                vi = v0 + (v[i] - v0) * A + B * g[i]
                gi = g[i] * C
                v[i] = vi
                g[i] = gi
                if vi > vth:
                    spk_buf[n_spk] = i
                    n_spk += 1
            if refr or stim_prob[i] > 0.0 or abs(v[i] - v0) > eps or abs(g[i]) > eps:
                awake_list[j] = i
                j += 1
            else:
                awake[i] = False
        n_awake = j
        # 2. deliver spikes emitted D steps ago (refractory targets ignore them)
        slot = k % L
        for a in range(ring_len[slot]):
            pre = ring[slot, a]
            if silenced[pre]:
                continue
            gp = gain[pre] * w_syn
            for p in range(indptr[pre], indptr[pre + 1]):
                t = indices[p]
                if (k - last_spike[t]) < rfc_steps[t]:
                    continue
                g[t] += gp * data[p]
                if not awake[t]:
                    awake[t] = True
                    awake_list[n_awake] = t
                    n_awake += 1
            for p in range(e_indptr[pre], e_indptr[pre + 1]):
                t = e_indices[p]
                if (k - last_spike[t]) < rfc_steps[t]:
                    continue
                g[t] += gp * e_data[p]
                if not awake[t]:
                    awake[t] = True
                    awake_list[n_awake] = t
                    n_awake += 1
        ws = (k + D) % L
        for a in range(n_spk):
            ring[ws, a] = spk_buf[a]
        ring_len[ws] = n_spk
        # 3. Poisson kicks
        for a in range(stim_idx.shape[0]):
            i = stim_idx[a]
            if np.random.random() < stim_prob[i]:
                if not ((k - last_spike[i]) < rfc_steps[i]):
                    v[i] += kick
        # 4. reset the neurons that spiked
        for a in range(n_spk):
            i = spk_buf[a]
            v[i] = vrst
            g[i] = 0.0
            last_spike[i] = k
            if n_out < cap:
                out_t[n_out] = k
                out_i[n_out] = i
                n_out += 1
    return n_awake, n_out
