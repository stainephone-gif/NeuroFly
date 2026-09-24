"""Every synapse of the brain as a point in space.

Built once from ``fafb_783_synapses.parquet`` (2 GB, public FlyWire 783
archive) into three memory-mapped arrays next to it::

    synapses_783.pre.npy   uint32  presynaptic model index, sorted
    synapses_783.post.npy  uint32  postsynaptic model index
    synapses_783.xyz.npy   float32 (m, 3) position in um
    synapses_783.offsets.npy  int64 (n+1,) CSR offsets by presynaptic neuron
    synapses_783.bypost.npy   uint32 permutation sorting synapses by post
    synapses_783.post_offsets.npy  int64 (n+1,)

Only the slices a screen asks for are read, so a weak machine copes.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

from .data import _fetch, default_data_dir

PARQUET = "fafb_783_synapses.parquet"
URL = "https://storage.googleapis.com/lee-lab_brain-and-nerve-cord-fly-connectome/compiled_data/fafb_783/" + PARQUET
STEM = "synapses_783"


def build_index(ids: np.ndarray, data_dir: Path | str | None = None) -> Path:
    import pyarrow.compute as pc
    import pyarrow.parquet as pq

    d = (Path(data_dir) if data_dir else default_data_dir()) / "archive"
    d.mkdir(parents=True, exist_ok=True)
    src = d / PARQUET
    if not src.exists():
        print(f"downloading {URL} (2 GB)", file=sys.stderr)
        _fetch(URL, src)
    ids = np.asarray(ids, dtype=np.int64)
    order = np.argsort(ids)
    sorted_ids = ids[order]

    f = pq.ParquetFile(src)
    pre_parts, post_parts, xyz_parts = [], [], []
    for rg in range(f.metadata.num_row_groups):
        t = f.read_row_group(rg, columns=["pre", "post", "x", "y", "z"])
        pre = pc.cast(t["pre"], "int64").to_numpy()
        post = pc.cast(t["post"], "int64").to_numpy()
        pi = np.searchsorted(sorted_ids, pre)
        pj = np.searchsorted(sorted_ids, post)
        pi = np.minimum(pi, len(ids) - 1)
        pj = np.minimum(pj, len(ids) - 1)
        ok = (sorted_ids[pi] == pre) & (sorted_ids[pj] == post)
        pre_parts.append(order[pi[ok]].astype(np.uint32))
        post_parts.append(order[pj[ok]].astype(np.uint32))
        xyz = np.stack([t["x"].to_numpy(), t["y"].to_numpy(), t["z"].to_numpy()], axis=1)[ok]
        xyz_parts.append((xyz / 1000.0).astype(np.float32))
        if rg % 50 == 0:
            print(f"  row group {rg}/{f.metadata.num_row_groups}", file=sys.stderr)
    pre = np.concatenate(pre_parts); post = np.concatenate(post_parts); xyz = np.concatenate(xyz_parts)
    print(f"  {len(pre)} synapses between model neurons; sorting...", file=sys.stderr)
    o = np.argsort(pre, kind="stable")
    pre, post, xyz = pre[o], post[o], xyz[o]
    n = len(ids)
    offsets = np.zeros(n + 1, dtype=np.int64)
    np.cumsum(np.bincount(pre, minlength=n), out=offsets[1:])
    bypost = np.argsort(post, kind="stable").astype(np.uint32)
    post_offsets = np.zeros(n + 1, dtype=np.int64)
    np.cumsum(np.bincount(post, minlength=n), out=post_offsets[1:])
    np.save(d / f"{STEM}.pre.npy", pre)
    np.save(d / f"{STEM}.post.npy", post)
    np.save(d / f"{STEM}.xyz.npy", xyz)
    np.save(d / f"{STEM}.offsets.npy", offsets)
    np.save(d / f"{STEM}.bypost.npy", bypost)
    np.save(d / f"{STEM}.post_offsets.npy", post_offsets)
    print("synapse index built", file=sys.stderr)
    return d


class SynapseIndex:
    """Memory-mapped access to synapse positions by neuron."""

    def __init__(self, ids: np.ndarray, data_dir: Path | str | None = None, build: bool = True):
        d = (Path(data_dir) if data_dir else default_data_dir()) / "archive"
        if not (d / f"{STEM}.offsets.npy").exists():
            if not build:
                raise FileNotFoundError("synapse index not built; run `neurofly archive --synapses`")
            build_index(ids, data_dir)
        self.pre = np.load(d / f"{STEM}.pre.npy", mmap_mode="r")
        self.post = np.load(d / f"{STEM}.post.npy", mmap_mode="r")
        self.xyz = np.load(d / f"{STEM}.xyz.npy", mmap_mode="r")
        self.offsets = np.load(d / f"{STEM}.offsets.npy")
        self.bypost = np.load(d / f"{STEM}.bypost.npy", mmap_mode="r")
        self.post_offsets = np.load(d / f"{STEM}.post_offsets.npy")

    def __len__(self) -> int:
        return int(self.offsets[-1])

    def outputs(self, i: int) -> tuple[np.ndarray, np.ndarray]:
        """``(xyz, post)`` of every synapse neuron ``i`` makes onto others."""
        a, b = self.offsets[i], self.offsets[i + 1]
        return np.asarray(self.xyz[a:b]), np.asarray(self.post[a:b])

    def inputs(self, j: int) -> tuple[np.ndarray, np.ndarray]:
        """``(xyz, pre)`` of every synapse neuron ``j`` receives."""
        a, b = self.post_offsets[j], self.post_offsets[j + 1]
        rows = np.sort(np.asarray(self.bypost[a:b]))
        return np.asarray(self.xyz[rows]), np.asarray(self.pre[rows])

    def between(self, i: int, j: int) -> np.ndarray:
        """Positions of the synapses from ``i`` to ``j``."""
        xyz, post = self.outputs(i)
        return xyz[post == j]
