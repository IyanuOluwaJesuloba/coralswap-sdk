import { RouterModule } from '../src/modules/router';
import { TradeType } from '../src/types/common';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockPair(
  token0: string,
  token1: string,
  reserve0: bigint,
  reserve1: bigint,
  feeBps: number,
) {
  return {
    getTokens: jest.fn().mockResolvedValue({ token0, token1 }),
    getReserves: jest.fn().mockResolvedValue({ reserve0, reserve1 }),
    getDynamicFee: jest.fn().mockResolvedValue(feeBps),
  };
}

function buildMockClient(
  pairs: Array<{
    address: string;
    token0: string;
    token1: string;
    reserve0: bigint;
    reserve1: bigint;
    feeBps: number;
  }>,
) {
  const pairMap: Record<string, any> = {};
  for (const p of pairs) {
    pairMap[p.address] = mockPair(p.token0, p.token1, p.reserve0, p.reserve1, p.feeBps);
  }

  return {
    factory: {
      getAllPairs: jest.fn().mockResolvedValue(pairs.map((p) => p.address)),
    },
    pair: jest.fn().mockImplementation((addr: string) => pairMap[addr]),
    getPairAddress: jest.fn().mockImplementation(async (a: string, b: string) => {
      const p = pairs.find(
        (pair) => (pair.token0 === a && pair.token1 === b) || (pair.token0 === b && pair.token1 === a),
      );
      return p ? p.address : null;
    }),
    config: { defaultSlippageBps: 50 },
    networkConfig: { networkPassphrase: 'Test SDF Network ; September 2015' },
    getDeadline: jest.fn().mockReturnValue(9999999999),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Valid-looking Stellar contract addresses (C...)
const T_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const T_B = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
const T_C = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M';
const T_D = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4';

describe('RouterModule.findOptimalPath', () => {
  it('finds a direct path when it is the only one', async () => {
    const client = buildMockClient([
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const result = await routerModule.findOptimalPath(T_A, T_B, 1000n);

    expect(result).not.toBeNull();
    expect(result?.path).toEqual([T_A, T_B]);
    expect(result?.quote.amountOut).toBeGreaterThan(0n);
  });

  it('finds the best path among multiple options (direct vs 2-hop)', async () => {
    // Direct path A -> C (low liquidity)
    // 2-hop path A -> B -> C (high liquidity)
    const client = buildMockClient([
      { address: 'P_AC', token0: T_A, token1: T_C, reserve0: 10000n, reserve1: 10000n, feeBps: 30 },
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
      { address: 'P_BC', token0: T_B, token1: T_C, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    // Swap 5000 tokens (significant price impact on A-C, low on A-B-C)
    const result = await routerModule.findOptimalPath(T_A, T_C, 5000n);

    expect(result).not.toBeNull();
    expect(result?.path).toEqual([T_A, T_B, T_C]);
  });

  it('finds the best path among multiple options (3-hop vs direct)', async () => {
    // Direct path A -> D (very low liquidity)
    // 3-hop path A -> B -> C -> D (moderate liquidity)
    const client = buildMockClient([
      { address: 'P_AD', token0: T_A, token1: T_D, reserve0: 1000n, reserve1: 1000n, feeBps: 30 },
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 100000n, reserve1: 100000n, feeBps: 30 },
      { address: 'P_BC', token0: T_B, token1: T_C, reserve0: 100000n, reserve1: 100000n, feeBps: 30 },
      { address: 'P_CD', token0: T_C, token1: T_D, reserve0: 100000n, reserve1: 100000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const result = await routerModule.findOptimalPath(T_A, T_D, 500n);

    expect(result).not.toBeNull();
    expect(result?.path).toEqual([T_A, T_B, T_C, T_D]);
  });

  it('returns null when no path exists', async () => {
    const client = buildMockClient([
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
      { address: 'P_CD', token0: T_C, token1: T_D, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const result = await routerModule.findOptimalPath(T_A, T_D, 1000n);

    expect(result).toBeNull();
  });

  it('respects the maxHops limit (does not find 4-hop+ paths)', async () => {
    // Path: A -> B -> C -> D -> E
    const T_E = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA5'; // Dummy valid key
    const client = buildMockClient([
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
      { address: 'P_BC', token0: T_B, token1: T_C, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
      { address: 'P_CD', token0: T_C, token1: T_D, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
      { address: 'P_DE', token0: T_D, token1: T_E, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const result = await routerModule.findOptimalPath(T_A, T_E, 1000n);

    expect(result).toBeNull(); // Because A-B-C-D-E is 4 hops
  });
});

// ---------------------------------------------------------------------------
// EXACT_OUT pathfinding
// ---------------------------------------------------------------------------

describe('RouterModule.findOptimalPath (EXACT_OUT)', () => {
  it('finds a direct EXACT_OUT path and computes required input', async () => {
    const client = buildMockClient([
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const result = await routerModule.findOptimalPath(T_A, T_B, 1000n, TradeType.EXACT_OUT);

    expect(result).not.toBeNull();
    expect(result?.path).toEqual([T_A, T_B]);
    // For EXACT_OUT the desired output is the amount passed in
    expect(result?.quote.amountOut).toBe(1000n);
    // Required input must be greater than output (due to fees)
    expect(result?.quote.amountIn).toBeGreaterThan(1000n);
  });

  it('selects the path with minimum required input for EXACT_OUT', async () => {
    // Direct path A -> C (low liquidity -> higher input required)
    // 2-hop path A -> B -> C (high liquidity -> lower input required)
    const client = buildMockClient([
      { address: 'P_AC', token0: T_A, token1: T_C, reserve0: 10000n, reserve1: 10000n, feeBps: 30 },
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
      { address: 'P_BC', token0: T_B, token1: T_C, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    // Want exactly 5000 tokens out — high-liquidity 2-hop path should require less input
    const result = await routerModule.findOptimalPath(T_A, T_C, 5000n, TradeType.EXACT_OUT);

    expect(result).not.toBeNull();
    expect(result?.path).toEqual([T_A, T_B, T_C]);
  });

  it('finds a 3-hop EXACT_OUT path when it requires less input', async () => {
    // Direct path A -> D (very low liquidity)
    // 3-hop path A -> B -> C -> D (moderate liquidity)
    const client = buildMockClient([
      { address: 'P_AD', token0: T_A, token1: T_D, reserve0: 1000n, reserve1: 1000n, feeBps: 30 },
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 100000n, reserve1: 100000n, feeBps: 30 },
      { address: 'P_BC', token0: T_B, token1: T_C, reserve0: 100000n, reserve1: 100000n, feeBps: 30 },
      { address: 'P_CD', token0: T_C, token1: T_D, reserve0: 100000n, reserve1: 100000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const result = await routerModule.findOptimalPath(T_A, T_D, 500n, TradeType.EXACT_OUT);

    expect(result).not.toBeNull();
    expect(result?.path).toEqual([T_A, T_B, T_C, T_D]);
  });

  it('returns null when no EXACT_OUT path exists', async () => {
    const client = buildMockClient([
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
      { address: 'P_CD', token0: T_C, token1: T_D, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const result = await routerModule.findOptimalPath(T_A, T_D, 1000n, TradeType.EXACT_OUT);

    expect(result).toBeNull();
  });

  it('amounts array is consistent across hops (reverse computation)', async () => {
    const client = buildMockClient([
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 500000n, reserve1: 500000n, feeBps: 30 },
      { address: 'P_BC', token0: T_B, token1: T_C, reserve0: 500000n, reserve1: 500000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const result = await routerModule.findOptimalPath(T_A, T_C, 1000n, TradeType.EXACT_OUT);

    expect(result).not.toBeNull();
    // The final output should be the requested amount
    expect(result?.quote.amountOut).toBe(1000n);
    // amountIn should be positive and greater than amountOut (fees + slippage)
    expect(result?.quote.amountIn).toBeGreaterThan(0n);
    expect(result?.quote.amountIn).toBeGreaterThan(result!.quote.amountOut);
  });
});

// ---------------------------------------------------------------------------
// Path cache
// ---------------------------------------------------------------------------

describe('RouterModule path cache', () => {
  it('returns cached result on second call without additional RPC calls', async () => {
    const client = buildMockClient([
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const first = await routerModule.findOptimalPath(T_A, T_B, 1000n);
    const rpcCallsAfterFirst = (client.factory.getAllPairs as jest.Mock).mock.calls.length;

    const second = await routerModule.findOptimalPath(T_A, T_B, 1000n);
    const rpcCallsAfterSecond = (client.factory.getAllPairs as jest.Mock).mock.calls.length;

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    // No additional RPC calls on cache hit
    expect(rpcCallsAfterSecond).toBe(rpcCallsAfterFirst);
  });

  it('cache expires after TTL', async () => {
    const client = buildMockClient([
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    // Use a very short TTL for testing
    const routerModule = new RouterModule(client as any, 1);

    await routerModule.findOptimalPath(T_A, T_B, 1000n);
    const callsAfterFirst = (client.factory.getAllPairs as jest.Mock).mock.calls.length;

    // Wait for the cache to expire
    await new Promise((r) => setTimeout(r, 10));

    await routerModule.findOptimalPath(T_A, T_B, 1000n);
    const callsAfterSecond = (client.factory.getAllPairs as jest.Mock).mock.calls.length;

    // Should have made a new RPC call after expiry
    expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);
  });

  it('clearPathCache() forces fresh lookup', async () => {
    const client = buildMockClient([
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    await routerModule.findOptimalPath(T_A, T_B, 1000n);
    const callsAfterFirst = (client.factory.getAllPairs as jest.Mock).mock.calls.length;

    routerModule.clearPathCache();

    await routerModule.findOptimalPath(T_A, T_B, 1000n);
    const callsAfterSecond = (client.factory.getAllPairs as jest.Mock).mock.calls.length;

    expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);
  });

  it('caches separately by tradeType', async () => {
    const client = buildMockClient([
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const exactIn = await routerModule.findOptimalPath(T_A, T_B, 1000n, TradeType.EXACT_IN);
    const exactOut = await routerModule.findOptimalPath(T_A, T_B, 1000n, TradeType.EXACT_OUT);

    // Both should succeed but with different quotes
    expect(exactIn).not.toBeNull();
    expect(exactOut).not.toBeNull();
    // EXACT_IN and EXACT_OUT produce different amountIn/amountOut relationships
    expect(exactIn!.quote.amountIn).not.toEqual(exactOut!.quote.amountIn);
  });
});

// ---------------------------------------------------------------------------
// Zero-liquidity filter
// ---------------------------------------------------------------------------

describe('RouterModule zero-liquidity filter', () => {
  it('filters out paths with zero-reserve hops', async () => {
    // Direct A -> B has zero liquidity, A -> C -> B has liquidity
    const client = buildMockClient([
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 0n, reserve1: 0n, feeBps: 30 },
      { address: 'P_AC', token0: T_A, token1: T_C, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
      { address: 'P_CB', token0: T_C, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const result = await routerModule.findOptimalPath(T_A, T_B, 1000n);

    expect(result).not.toBeNull();
    // Should skip direct A->B (zero liquidity) and use A->C->B
    expect(result?.path).toEqual([T_A, T_C, T_B]);
  });

  it('returns null when all paths have zero liquidity', async () => {
    const client = buildMockClient([
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 0n, reserve1: 0n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const result = await routerModule.findOptimalPath(T_A, T_B, 1000n);

    expect(result).toBeNull();
  });

  it('filters zero-liquidity hops in multi-hop paths', async () => {
    // A -> B -> C where B -> C has zero liquidity
    // A -> D -> C is available with liquidity
    const client = buildMockClient([
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
      { address: 'P_BC', token0: T_B, token1: T_C, reserve0: 0n, reserve1: 0n, feeBps: 30 },
      { address: 'P_AD', token0: T_A, token1: T_D, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
      { address: 'P_DC', token0: T_D, token1: T_C, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const result = await routerModule.findOptimalPath(T_A, T_C, 1000n);

    expect(result).not.toBeNull();
    // Should use A -> D -> C, not A -> B -> C
    expect(result?.path).toEqual([T_A, T_D, T_C]);
  });
});
