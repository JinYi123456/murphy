"""Batched Philox-4x32-10 counter RNG on torch tensors.

The TypeScript reference (`src/engine/prng.ts`) decomposes every 32x32 -> 64
multiply into 16-bit limbs so that each intermediate is exactly representable
in an IEEE-754 double. The same decomposition is reproduced here with int64
tensors, so a draw for (scenario, position, lane) is bit-identical between the
browser, a CPU and an AMD Instinct GPU: no framework RNG is ever consulted,
and a draw never depends on the batch a scenario happens to sit in.
"""

from __future__ import annotations

import torch

M0 = 0xD2511F53
M1 = 0xCD9E8D57
BUMP0 = 0x9E3779B9
BUMP1 = 0xBB67AE85

MASK32 = 0xFFFFFFFF
LIMB16 = 0xFFFF
TWO32 = 4294967296.0

_ROUNDS = 10


def _as_int64(values, device) -> torch.Tensor:
    t = torch.as_tensor(values, dtype=torch.int64, device=device)
    return t.contiguous()


def _mul32x32(k: int, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """32x32 -> 64 unsigned multiply with a python scalar key.

    `k` and `x` are both < 2**32. Splitting `x` into 16-bit limbs keeps every
    product below 2**48, which is exact in int64 (and was exact in the double
    implementation the fixtures were generated with).
    """
    lo16 = x & LIMB16
    hi16 = x >> 16
    tl = k * lo16
    th = k * hi16
    mid = (tl >> 16) + th
    hi = mid >> 16
    lo = ((mid & LIMB16) << 16) | (tl & LIMB16)
    return hi, lo


def _round(c0, c1, c2, c3, k0, k1):
    hi0, lo0 = _mul32x32(M0, c0)
    hi1, lo1 = _mul32x32(M1, c2)
    return (
        hi0 ^ c1 ^ k0,
        lo0,
        hi1 ^ c0 ^ k1,
        lo1,
    )


def philox10(c0, c1, c2, c3, k0, k1):
    """Ten Philox rounds over int64 tensors; returns four u32-valued tensors.

    The four counter lanes and the key may be tensors of any broadcastable
    shape; the key lanes are widened to scalars when they are python ints.
    """
    for _ in range(_ROUNDS):
        c0, c1, c2, c3 = _round(c0, c1, c2, c3, k0, k1)
        k0 = (k0 + BUMP0) & MASK32
        k1 = (k1 + BUMP1) & MASK32
    return c0, c1, c2, c3


def draw_u32(
    key: tuple[int, int],
    scn: torch.Tensor,
    pos: torch.Tensor,
    lane: int,
) -> torch.Tensor:
    """u32 draw for every (scenario, position) pair on `lane`.

    Counter packing is (scn mod 2**32, scn div 2**32, pos mod 2**32, lane) and
    the returned word is `lane & 3`, matching `drawU32` exactly: the lane both
    perturbs the counter and selects the output word.
    """
    k0, k1 = int(key[0]), int(key[1])
    c0 = scn & MASK32
    c1 = (scn >> 32) & MASK32
    c2 = pos & MASK32
    c3 = torch.full_like(scn, lane & MASK32)
    words = philox10(c0, c1, c2, c3, k0, k1)
    return words[lane & 3] & MASK32


def draws(
    key: tuple[int, int],
    scn_tensor: torch.Tensor,
    pos_tensor: torch.Tensor,
    lane: int,
) -> torch.Tensor:
    """Uniform float64 in [0, 1) for each row of the batch.

    u32 / 2**32 is exact: the numerator is below 2**53 and the denominator is a
    power of two, so this conversion carries no rounding relative to the
    reference.
    """
    u = draw_u32(key, scn_tensor, pos_tensor, lane)
    return u.to(torch.float64) / TWO32


def _utf16_units(text: str) -> list[int]:
    """UTF-16 code units, because `charCodeAt` in the reference is not UTF-8."""
    raw = text.encode("utf-16-le")
    return [raw[i] | (raw[i + 1] << 8) for i in range(0, len(raw), 2)]


def seed_to_key(seed: str | int) -> tuple[int, int]:
    """Split a seed into a 64-bit Philox key, mirroring `seedToKey` in TS.

    The two mixing chains are the reference's murmur-style scramble with its
    13/17-bit rotations; they are scalar work done once per run, so the bit
    twiddling is done in python rather than on the device.
    """
    if isinstance(seed, int):
        text = f"n{seed & MASK32}"
    else:
        text = seed

    h1 = BUMP0
    h2 = BUMP1
    for i, ch in enumerate(_utf16_units(text)):
        h1 = ((h1 ^ ch) * 0x85EBCA6B) & MASK32
        h1 = ((h1 << 13) | (h1 >> 19)) & MASK32
        h2 = ((h2 ^ (ch + i)) * 0xC2B2AE35) & MASK32
        h2 = ((h2 << 17) | (h2 >> 15)) & MASK32

    h1 = (h1 ^ h2) & MASK32
    h2 = (h2 ^ ((h1 + BUMP0) & MASK32)) & MASK32
    return h1, h2


def scenario_indices(batch: int, device: torch.device | str = "cpu") -> torch.Tensor:
    """The pairing key: scenario i always draws from cell row i."""
    return torch.arange(batch, dtype=torch.int64, device=device)


def positions(values, device: torch.device | str = "cpu") -> torch.Tensor:
    """Broadcast a per-step scalar stream position across the batch."""
    t = _as_int64(values, device)
    return t
