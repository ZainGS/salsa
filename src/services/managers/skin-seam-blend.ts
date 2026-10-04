/**
 * skin-seam-blend.ts — smooth the skin-weight SEAMS of a procedural body (audit 2026-09-28 C1, Phase 1).
 *
 * The body generator assigns weights per ring, so neighbouring rings can be bound to completely different bones — the
 * torso's arm socket is `chest+spine` while the first arm ring 1.2 cm away is `shoulder+clavicle`. A triangle spanning
 * two vertices that share NO bone flips inside-out the moment the joint turns (the crushed armpit). This pass finds
 * every such edge and mixes each endpoint `amount` of the way toward the average weights of its across-seam
 * neighbours, keeping the top 4 influences. It touches ONLY seam vertices — everywhere else is unchanged.
 *
 * Measured (docs/specs/character-skin-weights.md): at 0.5, folds across the test poses drop 74 → 38, A-pose armpit and
 * elbow folds → 0. GLOBAL smoothing was tried and rejected — it made collapse 4× worse.
 *
 * `amount <= 0` returns exactly the classic 2-influence packing (bit-identical), so saved characters are unchanged.
 */

export interface PackedSkinWeights {
  jointIndices: Uint8Array;    // 4 per vertex
  jointWeights: Float32Array;  // 4 per vertex, sum = 1
}

/** Pack the generator's 2-influence arrays exactly as before (the classic path). */
export function packTwoInfluences(
  vcount: number, j0: ArrayLike<number>, w0: ArrayLike<number>, j1: ArrayLike<number>, w1: ArrayLike<number>,
): PackedSkinWeights {
  const jointIndices = new Uint8Array(vcount * 4);
  const jointWeights = new Float32Array(vcount * 4);
  for (let i = 0; i < vcount; i++) {
    const o = i * 4;
    jointIndices[o] = j0[i]; jointIndices[o + 1] = j1[i];
    jointWeights[o] = w0[i]; jointWeights[o + 1] = w1[i];
  }
  return { jointIndices, jointWeights };
}

export function seamBlendWeights(
  vcount: number,
  indices: ArrayLike<number>,
  j0: ArrayLike<number>, w0: ArrayLike<number>, j1: ArrayLike<number>, w1: ArrayLike<number>,
  jointCount: number,
  amount: number,
): PackedSkinWeights {
  if (!(amount > 0)) return packTwoInfluences(vcount, j0, w0, j1, w1);
  const a = Math.min(1, amount);
  const J = jointCount;

  // Dense per-vertex weight field (vcount × J — ~3k × 20 for a body, trivially small).
  const W = new Float32Array(vcount * J);
  for (let i = 0; i < vcount; i++) {
    W[i * J + j0[i]] += w0[i];
    W[i * J + j1[i]] += w1[i];
  }
  const EPS = 1e-4;
  const shareBone = (p: number, q: number): boolean => {
    for (let j = 0; j < J; j++) if (W[p * J + j] > EPS && W[q * J + j] > EPS) return true;
    return false;
  };

  // Across-seam neighbours: vertices joined by an edge but sharing no bone.
  const across: number[][] = Array.from({ length: vcount }, () => []);
  const seen = new Set<number>();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const tri = [indices[t], indices[t + 1], indices[t + 2]];
    for (let x = 0; x < 3; x++) {
      for (let y = x + 1; y < 3; y++) {
        const p = tri[x], q = tri[y];
        const key = p < q ? p * vcount + q : q * vcount + p;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!shareBone(p, q)) { across[p].push(q); across[q].push(p); }
      }
    }
  }

  // Blend seam vertices toward their across-seam neighbours (reads the ORIGINAL field — order-independent).
  const N = new Float32Array(W);
  for (let i = 0; i < vcount; i++) {
    const nb = across[i];
    if (!nb.length) continue;
    for (let j = 0; j < J; j++) {
      let s = 0;
      for (const q of nb) s += W[q * J + j];
      N[i * J + j] = (1 - a) * W[i * J + j] + a * (s / nb.length);
    }
  }

  // Top 4 per vertex (ties → lower joint index, so the result is deterministic), renormalized.
  const jointIndices = new Uint8Array(vcount * 4);
  const jointWeights = new Float32Array(vcount * 4);
  const order: number[] = [];
  for (let i = 0; i < vcount; i++) {
    order.length = 0;
    for (let j = 0; j < J; j++) if (N[i * J + j] > 0) order.push(j);
    order.sort((x, y) => (N[i * J + y] - N[i * J + x]) || (x - y));
    const top = order.slice(0, 4);
    let sum = 0;
    for (const j of top) sum += N[i * J + j];
    if (sum <= 0) { jointIndices[i * 4] = j0[i]; jointWeights[i * 4] = 1; continue; }
    top.forEach((j, k) => { jointIndices[i * 4 + k] = j; jointWeights[i * 4 + k] = N[i * J + j] / sum; });
  }
  return { jointIndices, jointWeights };
}
