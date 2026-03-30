import { CoralSwapClient } from "@/client";
import { PRECISION } from "@/config";
import { ValidationError, InsufficientLiquidityError } from "@/errors";
import { validateAddress } from "@/utils/validation";

/**
 * TWAP Oracle data point from cumulative price accumulators.
 */
export interface TWAPObservation {
  price0CumulativeLast: bigint;
  price1CumulativeLast: bigint;
  blockTimestampLast: number;
}

/**
 * Computed TWAP price over a time window.
 */
export interface TWAPResult {
  pairAddress: string;
  token0: string;
  token1: string;
  price0TWAP: bigint;
  price1TWAP: bigint;
  timeWindow: number;
  startObservation: TWAPObservation;
  endObservation: TWAPObservation;
}

export interface TWAPAnalysisResult {
  windowLedgers: number;
  price0Avg: bigint;
  price1Avg: bigint;
}

export interface VolatilityScoreResult {
  score: number;
  stddev: number;
  samples: number;
}

const MAX_I128 = (1n << 127n) - 1n;

function validateI128(value: bigint, name: string): void {
  if (value < -MAX_I128 - 1n || value > MAX_I128) {
    throw new ValidationError(`${name} is out of i128 bounds`, {
      value: value.toString(),
    });
  }
}

const ORACLE_LIMITS = {
  minWindowLedgers: 1,
  maxWindowLedgers: 100_000,
} as const;

/**
 * Oracle module -- TWAP price feeds from CoralSwap pairs.
 *
 * Reads cumulative price accumulators from pair contracts to compute
 * Time-Weighted Average Prices. Useful for DeFi integrations that
 * need manipulation-resistant price feeds.
 */
export class OracleModule {
  private client: CoralSwapClient;
  private observationCache: Map<string, TWAPObservation[]> = new Map();

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Read the current cumulative price observation from a pair.
   *
   * @param pairAddress - The address of the pair contract
   * @returns The current cumulative price observation
   * @example
   * const obs = await client.oracle.observe('C...');
   */
  async observe(pairAddress: string): Promise<TWAPObservation> {
    const pair = this.client.pair(pairAddress);
    const prices = await pair.getCumulativePrices();

    const observation: TWAPObservation = {
      price0CumulativeLast: prices.price0CumulativeLast,
      price1CumulativeLast: prices.price1CumulativeLast,
      blockTimestampLast: prices.blockTimestampLast,
    };

    // Cache observation for TWAP calculation
    const key = pairAddress;
    const existing = this.observationCache.get(key) ?? [];
    existing.push(observation);
    // Keep only last 100 observations
    if (existing.length > 100) {
      existing.splice(0, existing.length - 100);
    }
    this.observationCache.set(key, existing);

    return observation;
  }

  /**
   * Compute TWAP between two observations.
   *
   * Requires at least two observations separated by time. Call observe()
   * at different times to collect data, then compute the TWAP.
   *
   * @param startObs - The earlier observation
   * @param endObs - The later observation
   * @returns An object containing computed TWAP prices
   * @throws {ValidationError} If the end observation time is not after the start observation time
   * @example
   * const twap = client.oracle.computeTWAP(obs1, obs2);
   */
  computeTWAP(
    startObs: TWAPObservation,
    endObs: TWAPObservation,
  ): { price0TWAP: bigint; price1TWAP: bigint; timeWindow: number } {
    const timeElapsed = endObs.blockTimestampLast - startObs.blockTimestampLast;

    if (timeElapsed <= 0) {
      throw new ValidationError(
        "End observation must be after start observation",
        {
          startTimestamp: startObs.blockTimestampLast,
          endTimestamp: endObs.blockTimestampLast,
        },
      );
    }

    const price0TWAP =
      (endObs.price0CumulativeLast - startObs.price0CumulativeLast) /
      BigInt(timeElapsed);

    const price1TWAP =
      (endObs.price1CumulativeLast - startObs.price1CumulativeLast) /
      BigInt(timeElapsed);

    return { price0TWAP, price1TWAP, timeWindow: timeElapsed };
  }

  /**
   * Get the TWAP for a pair using cached observations.
   *
   * If insufficient observations exist, takes a new one and returns null
   * (caller must wait and retry).
   *
   * @param pairAddress - The address of the pair contract
   * @returns The TWAP result or null if minimum 2 observations aren't met
   * @example
   * const twap = await client.oracle.getTWAP('C...');
   */
  async getTWAP(pairAddress: string): Promise<TWAPResult | null> {
    // Take a fresh observation
    await this.observe(pairAddress);

    const observations = this.observationCache.get(pairAddress);
    if (!observations || observations.length < 2) {
      return null; // Need at least 2 observations
    }

    const startObs = observations[0];
    const endObs = observations[observations.length - 1];

    if (endObs.blockTimestampLast <= startObs.blockTimestampLast) {
      return null;
    }

    const pair = this.client.pair(pairAddress);
    const tokens = await pair.getTokens();
    const { price0TWAP, price1TWAP, timeWindow } = this.computeTWAP(
      startObs,
      endObs,
    );

    return {
      pairAddress,
      token0: tokens.token0,
      token1: tokens.token1,
      price0TWAP,
      price1TWAP,
      timeWindow,
      startObservation: startObs,
      endObservation: endObs,
    };
  }

  /**
   * Get the current spot price from reserves (not TWAP).
   *
   * @param pairAddress - The address of the pair contract
   * @returns Spot price ratios for both tokens
   * @throws {InsufficientLiquidityError} If reserves are zero
   * @example
   * const spot = await client.oracle.getSpotPrice('C...');
   */
  async getSpotPrice(pairAddress: string): Promise<{
    price0Per1: bigint;
    price1Per0: bigint;
  }> {
    const pair = this.client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();

    if (reserve0 === 0n || reserve1 === 0n) {
      throw new InsufficientLiquidityError(pairAddress);
    }

    return {
      price0Per1: (reserve0 * PRECISION.PRICE_SCALE) / reserve1,
      price1Per0: (reserve1 * PRECISION.PRICE_SCALE) / reserve0,
    };
  }

  async analyzeTwap(pair: string, windows: number[]): Promise<TWAPAnalysisResult[]> {
    validateAddress(pair, "pair");

    for (const windowLedgers of windows) {
      if (!Number.isFinite(windowLedgers) || !Number.isInteger(windowLedgers)) {
        throw new ValidationError("window must be an integer", { windowLedgers });
      }
      if (windowLedgers <= 0) {
        throw new ValidationError("window must be greater than 0", { windowLedgers });
      }
      if (windowLedgers < ORACLE_LIMITS.minWindowLedgers || windowLedgers > ORACLE_LIMITS.maxWindowLedgers) {
        throw new ValidationError("window is outside oracle limits", {
          windowLedgers,
          minWindowLedgers: ORACLE_LIMITS.minWindowLedgers,
          maxWindowLedgers: ORACLE_LIMITS.maxWindowLedgers,
        });
      }
    }

    const endObservation = await this.observe(pair);
    const observations = this.observationCache.get(pair) ?? [];

    return Promise.all(
      windows.map(async (windowLedgers) => {
        const targetTimestamp = endObservation.blockTimestampLast - windowLedgers;

        let startObservation: TWAPObservation | undefined;
        for (let i = observations.length - 1; i >= 0; i--) {
          const obs = observations[i];
          if (obs.blockTimestampLast <= targetTimestamp) {
            startObservation = obs;
            break;
          }
        }

        if (!startObservation) {
          throw new ValidationError("Insufficient observations for requested window", {
            windowLedgers,
            latestTimestamp: endObservation.blockTimestampLast,
            earliestTimestamp: observations[0]?.blockTimestampLast,
          });
        }

        const { price0TWAP, price1TWAP } = this.computeTWAP(startObservation, endObservation);

        validateI128(price0TWAP, "price0Avg");
        validateI128(price1TWAP, "price1Avg");

        if (price0TWAP <= 0n || price1TWAP <= 0n) {
          throw new ValidationError("Computed TWAP is outside oracle limits", {
            windowLedgers,
            price0Avg: price0TWAP.toString(),
            price1Avg: price1TWAP.toString(),
          });
        }

        return {
          windowLedgers,
          price0Avg: price0TWAP,
          price1Avg: price1TWAP,
        };
      }),
    );
  }

  async getVolatilityScore(pair: string, windowCount: number): Promise<VolatilityScoreResult> {
    validateAddress(pair, "pair");

    if (!Number.isFinite(windowCount) || !Number.isInteger(windowCount)) {
      throw new ValidationError("windowCount must be an integer", { windowCount });
    }
    if (windowCount < 2) {
      throw new ValidationError("windowCount must be at least 2", { windowCount });
    }

    const windows = Array.from({ length: windowCount }, (_, i) => i + 1);
    const analysis = await this.analyzeTwap(pair, windows);

    const samples = Math.max(0, analysis.length - 1);
    if (samples === 0) {
      return { score: 0, stddev: 0, samples: 0 };
    }

    const deltas: number[] = [];
    let maxAbsDelta = 0;

    for (let i = 1; i < analysis.length; i++) {
      const delta = analysis[i].price0Avg - analysis[i - 1].price0Avg;
      const absDelta = delta < 0n ? -delta : delta;

      if (absDelta > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new ValidationError("Volatility delta exceeds MAX_SAFE_INTEGER", {
          delta: delta.toString(),
          windowCount,
        });
      }

      const deltaNum = Number(delta);
      deltas.push(deltaNum);
      const absNum = Math.abs(deltaNum);
      if (absNum > maxAbsDelta) maxAbsDelta = absNum;
    }

    const mean = deltas.reduce((acc, v) => acc + v, 0) / deltas.length;
    const variance = deltas.reduce((acc, v) => {
      const diff = v - mean;
      return acc + diff * diff;
    }, 0) / deltas.length;
    const stddev = Math.sqrt(variance);

    const score = maxAbsDelta === 0
      ? 0
      : Math.max(0, Math.min(100, (stddev / maxAbsDelta) * 100));

    return { score, stddev, samples: deltas.length };
  }

  /**
   * Clear cached observations for a pair or all pairs.
   *
   * @param pairAddress - Optional specific pair to clear, clears all if omitted
   * @example
   * client.oracle.clearCache('C...');
   */
  clearCache(pairAddress?: string): void {
    if (pairAddress) {
      this.observationCache.delete(pairAddress);
    } else {
      this.observationCache.clear();
    }
  }

  /**
   * Get cached observation count for a pair.
   *
   * @param pairAddress - The address of the pair contract
   * @returns Number of cached observations
   * @example
   * const count = client.oracle.getObservationCount('C...');
   */
  getObservationCount(pairAddress: string): number {
    return this.observationCache.get(pairAddress)?.length ?? 0;
  }
}
