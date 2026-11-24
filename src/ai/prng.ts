/**
 * Deterministic Mulberry32 PRNG with Box-Muller Gaussian sampling and Fisher-Yates shuffling.
 * Used across PPO initialization, exploration, rollout batching, and domain randomization.
 */
export class SeededPRNG {
  private state: number;
  private hasSpare = false;
  private spare = 0;
  public readonly initialSeed: number;

  constructor(seed = 42) {
    this.initialSeed = seed >>> 0;
    this.state = this.initialSeed || 0x9e3779b9;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Standard or scaled normal sample via Box-Muller transform. */
  gaussian(mean = 0, std = 1): number {
    if (this.hasSpare) {
      this.hasSpare = false;
      return mean + std * this.spare;
    }
    const u1 = Math.max(1e-7, this.next());
    const u2 = this.next();
    const mag = Math.sqrt(-2.0 * Math.log(u1));
    const z0 = mag * Math.cos(2.0 * Math.PI * u2);
    const z1 = mag * Math.sin(2.0 * Math.PI * u2);
    this.spare = z1;
    this.hasSpare = true;
    return mean + std * z0;
  }

  /** In-place Fisher-Yates shuffle. */
  shuffleInPlace(arr: Int32Array | number[], length = arr.length): void {
    for (let i = length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }
}
