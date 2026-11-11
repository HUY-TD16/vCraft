import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../src/common/application/ports/transaction-runner';
import type {
  IdempotencyScopeKey,
  PersistedIdempotencyRecord,
  TradingCurrentStateDto,
} from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';
import type { IIdempotencyRecordRepository } from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import {
  IdempotencyConflictError,
  InvalidTradingInputError,
  ConcurrencyConflictError,
  TRADING_INVARIANTS,
} from '../../../../src/modules/trading/domain';
import {
  validateUuidV4,
  normalizeUuidV4,
  canonicalizeJson,
  computeCanonicalFingerprint,
} from '../../../../src/modules/trading/domain/utilities/idempotency.utilities';
import {
  TradingIdempotencyService,
  type ExecuteWithIdempotencyInput,
} from '../../../../src/modules/trading/application/services/trading-idempotency.service';

// ============================================================================
// Mock Fixtures & Test Harness
// ============================================================================

interface MockTxRunnerContext {
  txRunner: TransactionRunner;
  dummyTx: TransactionContext;
  runSpy: ReturnType<typeof vi.fn>;
}

function createMockTxRunner(): MockTxRunnerContext {
  const dummyTx = { __brand: 'mock-tx' } as unknown as TransactionContext;
  const runSpy = vi.fn().mockImplementation(
    async <T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> => {
      return work(dummyTx);
    },
  );
  return {
    txRunner: { run: runSpy },
    dummyTx,
    runSpy,
  };
}

interface MockIdempotencyRepoContext {
  repo: IIdempotencyRecordRepository;
  findByScopeSpy: ReturnType<typeof vi.fn>;
  findAndVerifyReplaySpy: ReturnType<typeof vi.fn>;
  saveSpy: ReturnType<typeof vi.fn>;
  deleteExpiredBeforeSpy: ReturnType<typeof vi.fn>;
}

function createMockIdempotencyRepo(): MockIdempotencyRepoContext {
  const findByScopeSpy = vi.fn();
  const findAndVerifyReplaySpy = vi.fn();
  const saveSpy = vi.fn();
  const deleteExpiredBeforeSpy = vi.fn();

  const repo: IIdempotencyRecordRepository = {
    findByScope: findByScopeSpy,
    findAndVerifyReplay: findAndVerifyReplaySpy,
    save: saveSpy,
    deleteExpiredBefore: deleteExpiredBeforeSpy,
  };

  return {
    repo,
    findByScopeSpy,
    findAndVerifyReplaySpy,
    saveSpy,
    deleteExpiredBeforeSpy,
  };
}

// ============================================================================
// 1. UUID v4 Validation Unit Tests
// ============================================================================

describe('Idempotency Utilities — UUID v4 Validation (RFC 4122)', () => {
  it('accepts valid RFC 4122 UUID v4 strings in lowercase', () => {
    expect(validateUuidV4('c56a4180-65aa-42ec-a945-5fd21dec0538')).toBe(true);
    expect(validateUuidV4('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(true);
    expect(validateUuidV4('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d')).toBe(true);
  });

  it('accepts valid UUID v4 strings in uppercase and mixed-case', () => {
    expect(validateUuidV4('C56A4180-65AA-42EC-A945-5FD21DEC0538')).toBe(true);
    expect(validateUuidV4('c56A4180-65aa-42EC-a945-5Fd21DeC0538')).toBe(true);
  });

  it('accepts valid UUID v4 with all permissible variant bits (8, 9, a, b)', () => {
    expect(validateUuidV4('00000000-0000-4000-8000-000000000000')).toBe(true);
    expect(validateUuidV4('00000000-0000-4000-9000-000000000000')).toBe(true);
    expect(validateUuidV4('00000000-0000-4000-a000-000000000000')).toBe(true);
    expect(validateUuidV4('00000000-0000-4000-b000-000000000000')).toBe(true);
    expect(validateUuidV4('ffffffff-ffff-4fff-bfff-ffffffffffff')).toBe(true);
  });

  it('trims leading and trailing whitespace by default', () => {
    expect(validateUuidV4('  c56a4180-65aa-42ec-a945-5fd21dec0538  ')).toBe(true);
  });

  it('rejects padded UUID when trim option is explicitly false', () => {
    expect(
      validateUuidV4('  c56a4180-65aa-42ec-a945-5fd21dec0538  ', { trim: false }),
    ).toBe(false);
  });

  it('rejects malformed UUID strings with missing or misplaced hyphens', () => {
    expect(validateUuidV4('c56a418065aa42eca9455fd21dec0538')).toBe(false);
    expect(validateUuidV4('c56a418-065aa-42ec-a945-5fd21dec0538')).toBe(false);
  });

  it('rejects UUID strings with invalid length (too short or too long)', () => {
    expect(validateUuidV4('c56a4180-65aa-42ec-a945-5fd21dec053')).toBe(false);
    expect(validateUuidV4('c56a4180-65aa-42ec-a945-5fd21dec0538a')).toBe(false);
  });

  it('rejects strings containing non-hex characters or special characters', () => {
    expect(validateUuidV4('g56a4180-65aa-42ec-a945-5fd21dec0538')).toBe(false);
    expect(validateUuidV4('c56a4180-65aa-42ec-a945-5fd21dec053!')).toBe(false);
  });

  it('rejects non-v4 UUIDs (v1 timestamp, v3 MD5, v5 SHA-1, Nil UUID, Max UUID)', () => {
    // UUID v1 (version digit is 1)
    expect(validateUuidV4('123e4567-e89b-12d3-a456-426614174000')).toBe(false);
    // UUID v3
    expect(validateUuidV4('c7a8b9e0-1234-3567-89ab-cdef01234567')).toBe(false);
    // UUID v5 (version digit is 5)
    expect(validateUuidV4('886313e1-3b8a-5372-9b90-0c9aee199e5d')).toBe(false);
    // Nil UUID
    expect(validateUuidV4('00000000-0000-0000-0000-000000000000')).toBe(false);
    // Max UUID
    expect(validateUuidV4('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe(false);
    // Invalid variant bits (7 and c, d, e, f)
    expect(validateUuidV4('c56a4180-65aa-42ec-7945-5fd21dec0538')).toBe(false);
    expect(validateUuidV4('c56a4180-65aa-42ec-c945-5fd21dec0538')).toBe(false);
    expect(validateUuidV4('c56a4180-65aa-42ec-d945-5fd21dec0538')).toBe(false);
    expect(validateUuidV4('c56a4180-65aa-42ec-e945-5fd21dec0538')).toBe(false);
    expect(validateUuidV4('c56a4180-65aa-42ec-f945-5fd21dec0538')).toBe(false);
  });

  it('rejects empty strings, whitespace-only strings, and non-string types', () => {
    expect(validateUuidV4('')).toBe(false);
    expect(validateUuidV4('   ')).toBe(false);
    expect(validateUuidV4(null)).toBe(false);
    expect(validateUuidV4(undefined)).toBe(false);
    expect(validateUuidV4(123456789)).toBe(false);
    expect(validateUuidV4({})).toBe(false);
    expect(validateUuidV4([])).toBe(false);
    expect(validateUuidV4(true)).toBe(false);
  });

  describe('normalizeUuidV4', () => {
    it('normalizes valid UUID string by trimming and lowercasing', () => {
      const normalized = normalizeUuidV4('  C56A4180-65AA-42EC-A945-5FD21DEC0538  ');
      expect(normalized).toBe('c56a4180-65aa-42ec-a945-5fd21dec0538');
    });

    it('throws InvalidTradingInputError for non-string or invalid UUID values', () => {
      expect(() => normalizeUuidV4(null)).toThrow(InvalidTradingInputError);
      expect(() => normalizeUuidV4('invalid-uuid')).toThrow(InvalidTradingInputError);
      expect(() => normalizeUuidV4('')).toThrow(InvalidTradingInputError);
    });
  });
});

// ============================================================================
// 2. Canonical Fingerprint Computation Unit Tests
// ============================================================================

describe('Idempotency Utilities — Canonical Fingerprint Computation', () => {
  it('guarantees key ordering invariance for flat objects', () => {
    const objA = { alpha: 1, beta: 'text', gamma: true };
    const objB = { gamma: true, alpha: 1, beta: 'text' };
    const objC = { beta: 'text', gamma: true, alpha: 1 };

    const fpA = computeCanonicalFingerprint(objA);
    const fpB = computeCanonicalFingerprint(objB);
    const fpC = computeCanonicalFingerprint(objC);

    expect(fpA).toBe(fpB);
    expect(fpB).toBe(fpC);
  });

  it('guarantees deep recursive key sorting for nested objects', () => {
    const nestedA = {
      outer: { z: 100, a: 200, inner: { y: 'last', x: 'first' } },
      title: 'QuoteRequest',
    };
    const nestedB = {
      title: 'QuoteRequest',
      outer: { inner: { x: 'first', y: 'last' }, a: 200, z: 100 },
    };

    expect(computeCanonicalFingerprint(nestedA)).toBe(
      computeCanonicalFingerprint(nestedB),
    );
  });

  it('preserves array element order while recursively sorting object keys inside elements', () => {
    // Array order matters: [1, 2, 3] !== [3, 2, 1]
    const arr1 = [1, 2, 3];
    const arr2 = [3, 2, 1];
    expect(computeCanonicalFingerprint(arr1)).not.toBe(
      computeCanonicalFingerprint(arr2),
    );

    // Objects within arrays are key-sorted
    const arrObjA = [{ b: 2, a: 1 }, { d: 4, c: 3 }];
    const arrObjB = [{ a: 1, b: 2 }, { c: 3, d: 4 }];
    expect(computeCanonicalFingerprint(arrObjA)).toBe(
      computeCanonicalFingerprint(arrObjB),
    );

    // But swapping array positions changes the fingerprint
    const arrObjSwapped = [{ d: 4, c: 3 }, { b: 2, a: 1 }];
    expect(computeCanonicalFingerprint(arrObjA)).not.toBe(
      computeCanonicalFingerprint(arrObjSwapped),
    );
  });

  it('differentiates primitives and handles undefined properties in objects identically to JSON.stringify', () => {
    const withUndefined = { a: 1, b: undefined };
    const withoutUndefined = { a: 1 };
    expect(computeCanonicalFingerprint(withUndefined)).toBe(
      computeCanonicalFingerprint(withoutUndefined),
    );

    // Array undefined items convert to null
    const arrWithUndef = { list: [1, undefined, 3] };
    const arrWithNull = { list: [1, null, 3] };
    expect(computeCanonicalFingerprint(arrWithUndef)).toBe(
      computeCanonicalFingerprint(arrWithNull),
    );

    expect(computeCanonicalFingerprint({ active: true })).not.toBe(
      computeCanonicalFingerprint({ active: false }),
    );
    expect(computeCanonicalFingerprint({ count: 10 })).not.toBe(
      computeCanonicalFingerprint({ count: 11 }),
    );
  });

  it('handles BigInt, Date, and non-finite numbers safely', () => {
    const date = new Date('2026-11-11T09:00:00.000Z');
    const payload = {
      amount: 500000n,
      created_at: date,
      invalid_num: NaN,
      infinite_num: Infinity,
    };

    const canonical = canonicalizeJson(payload) as Record<string, unknown>;
    expect(canonical.amount).toBe('500000');
    expect(canonical.created_at).toBe('2026-11-11T09:00:00.000Z');
    expect(canonical.invalid_num).toBeNull();
    expect(canonical.infinite_num).toBeNull();
  });

  it('normalizes null, undefined, and empty objects consistently', () => {
    const emptyHash = computeCanonicalFingerprint({});
    expect(computeCanonicalFingerprint(null)).toBe(emptyHash);
    expect(computeCanonicalFingerprint(undefined)).toBe(emptyHash);
  });

  it('parses raw JSON strings automatically before computing fingerprint', () => {
    const rawJson = '{"z": 10, "a": 20}';
    const parsedObj = { a: 20, z: 10 };
    expect(computeCanonicalFingerprint(rawJson)).toBe(
      computeCanonicalFingerprint(parsedObj),
    );
  });

  it('includes expected_*_version fields so version changes alter the fingerprint', () => {
    const payloadV1 = {
      expected_request_version: 1,
      expected_quote_version: 2,
      note: 'Rush delivery required',
    };
    const payloadV2 = {
      expected_request_version: 2, // Changed version!
      expected_quote_version: 2,
      note: 'Rush delivery required',
    };

    expect(computeCanonicalFingerprint(payloadV1)).not.toBe(
      computeCanonicalFingerprint(payloadV2),
    );

    // Other expected version fields
    const payloadQuoteV1 = { expected_quote_version: 1 };
    const payloadQuoteV2 = { expected_quote_version: 2 };
    expect(computeCanonicalFingerprint(payloadQuoteV1)).not.toBe(
      computeCanonicalFingerprint(payloadQuoteV2),
    );

    const payloadProposalV1 = { expected_proposal_version: 1 };
    const payloadProposalV2 = { expected_proposal_version: 2 };
    expect(computeCanonicalFingerprint(payloadProposalV1)).not.toBe(
      computeCanonicalFingerprint(payloadProposalV2),
    );

    const payloadAllocV1 = { expected_allocation_version: 1 };
    const payloadAllocV2 = { expected_allocation_version: 2 };
    expect(computeCanonicalFingerprint(payloadAllocV1)).not.toBe(
      computeCanonicalFingerprint(payloadAllocV2),
    );

    const payloadRecipV1 = { expected_recipient_version: 1 };
    const payloadRecipV2 = { expected_recipient_version: 2 };
    expect(computeCanonicalFingerprint(payloadRecipV1)).not.toBe(
      computeCanonicalFingerprint(payloadRecipV2),
    );
  });

  it('produces a valid 64-character lowercase SHA-256 hex string', () => {
    const fp = computeCanonicalFingerprint({ id: '100', action: 'accept' });
    expect(fp).toHaveLength(64);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detects circular references and throws InvalidTradingInputError', () => {
    const circularObj: Record<string, unknown> = { name: 'circular' };
    circularObj.self = circularObj;

    expect(() => computeCanonicalFingerprint(circularObj)).toThrow(
      InvalidTradingInputError,
    );
  });
});

// ============================================================================
// 3. TradingIdempotencyService Unit Tests
// ============================================================================

describe('TradingIdempotencyService', () => {
  let mockTxRunnerContext: MockTxRunnerContext;
  let mockRepoContext: MockIdempotencyRepoContext;
  let service: TradingIdempotencyService;

  const NOW = new Date('2026-11-11T10:00:00.000Z');
  const VALID_KEY = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
  const BASE_PAYLOAD = {
    expected_request_version: 1,
    delivery_address: '10 Hang Gai, Ha Noi',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTxRunnerContext = createMockTxRunner();
    mockRepoContext = createMockIdempotencyRepo();
    service = new TradingIdempotencyService(
      mockRepoContext.repo,
      mockTxRunnerContext.txRunner,
    );
  });

  it('1. Initial Request: executes business mutation and saves idempotency record in the same transaction', async () => {
    // Arrange
    mockRepoContext.findByScopeSpy.mockResolvedValue(null);

    const mutationResult = { id: 'quote-100', status: 'buyer_accepted' };
    const mutationState: TradingCurrentStateDto = {
      request: { id: '100', status: 'buyer_accepted', version: 2, cancelled_at: null },
    };

    const executeSpy = vi.fn().mockResolvedValue({
      result: mutationResult,
      currentState: mutationState,
    });
    const getCurrentStateSpy = vi.fn();

    const savedRecord: PersistedIdempotencyRecord<typeof mutationResult> = {
      id: '2001',
      idempotency_key: VALID_KEY,
      request_fingerprint: computeCanonicalFingerprint(BASE_PAYLOAD),
      account_id: '10',
      action: 'accept_quote',
      object_type: 'QuoteRequest',
      object_id: '100',
      result_snapshot: mutationResult,
      created_at: NOW,
      expires_at: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    };
    mockRepoContext.saveSpy.mockResolvedValue(savedRecord);

    const input: ExecuteWithIdempotencyInput<typeof mutationResult> = {
      accountId: '10',
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      objectId: '100',
      idempotencyKey: VALID_KEY,
      payload: BASE_PAYLOAD,
      now: NOW,
      execute: executeSpy,
      getCurrentState: getCurrentStateSpy,
    };

    // Act
    const response = await service.executeWithIdempotency(input);

    // Assert
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith(mockTxRunnerContext.dummyTx);

    expect(mockRepoContext.saveSpy).toHaveBeenCalledTimes(1);
    expect(mockRepoContext.saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: '10',
        action: 'accept_quote',
        object_type: 'QuoteRequest',
        object_id: '100',
        idempotency_key: VALID_KEY,
        request_fingerprint: computeCanonicalFingerprint(BASE_PAYLOAD),
        result_snapshot: mutationResult,
      }),
      mockTxRunnerContext.dummyTx,
      undefined,
    );

    expect(getCurrentStateSpy).not.toHaveBeenCalled();

    expect(response.data).toEqual(mutationResult);
    expect(response.result).toEqual(mutationResult);
    expect(response.replayed).toBe(false);
    expect(response.recordId).toBe('2001');
    expect(response.currentState).toEqual(mutationState);
    expect(response.operation).toEqual({
      id: '2001',
      replayed: false,
      committed_at: NOW.toISOString(),
      current_state: mutationState,
    });
  });

  it('2. Business Error Rollback: does NOT save idempotency record when business operation throws', async () => {
    // Arrange
    mockRepoContext.findByScopeSpy.mockResolvedValue(null);

    const businessError = new ConcurrencyConflictError(
      'Target entity version mismatch',
      { invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY },
    );
    const executeSpy = vi.fn().mockRejectedValue(businessError);
    const getCurrentStateSpy = vi.fn();

    const input: ExecuteWithIdempotencyInput<unknown> = {
      accountId: '10',
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      objectId: '100',
      idempotencyKey: VALID_KEY,
      payload: BASE_PAYLOAD,
      execute: executeSpy,
      getCurrentState: getCurrentStateSpy,
    };

    // Act & Assert
    await expect(service.executeWithIdempotency(input)).rejects.toThrow(
      ConcurrencyConflictError,
    );

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(mockRepoContext.saveSpy).not.toHaveBeenCalled();
  });

  it('3. Idempotent Replay: returns cached snapshot with fresh current_state and does NOT call execute', async () => {
    // Arrange
    const cachedResult = { id: 'quote-100', status: 'buyer_accepted' };
    const originalFingerprint = computeCanonicalFingerprint(BASE_PAYLOAD);

    const existingRecord: PersistedIdempotencyRecord<typeof cachedResult> = {
      id: '2001',
      idempotency_key: VALID_KEY,
      request_fingerprint: originalFingerprint,
      account_id: '10',
      action: 'accept_quote',
      object_type: 'QuoteRequest',
      object_id: '100',
      result_snapshot: cachedResult,
      created_at: NOW,
      expires_at: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    };
    mockRepoContext.findByScopeSpy.mockResolvedValue(existingRecord);

    const freshState: TradingCurrentStateDto = {
      request: { id: '100', status: 'in_production', version: 5, cancelled_at: null },
    };

    const executeSpy = vi.fn();
    const getCurrentStateSpy = vi.fn().mockResolvedValue(freshState);

    const input: ExecuteWithIdempotencyInput<typeof cachedResult> = {
      accountId: '10',
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      objectId: '100',
      idempotencyKey: VALID_KEY,
      payload: BASE_PAYLOAD, // Same payload and version!
      execute: executeSpy,
      getCurrentState: getCurrentStateSpy,
    };

    // Act
    const response = await service.executeWithIdempotency(input);

    // Assert
    expect(executeSpy).not.toHaveBeenCalled();
    expect(mockRepoContext.saveSpy).not.toHaveBeenCalled();
    expect(getCurrentStateSpy).toHaveBeenCalledTimes(1);
    expect(getCurrentStateSpy).toHaveBeenCalledWith(mockTxRunnerContext.dummyTx);

    expect(response.data).toEqual(cachedResult);
    expect(response.replayed).toBe(true);
    expect(response.operation).toEqual({
      id: '2001',
      replayed: true,
      committed_at: NOW.toISOString(),
      current_state: freshState,
    });
  });

  it('4. Idempotency Conflict: throws IdempotencyConflictError (409) when key is reused with different payload', async () => {
    // Arrange
    const cachedResult = { id: 'quote-100', status: 'buyer_accepted' };
    const originalFingerprint = computeCanonicalFingerprint(BASE_PAYLOAD);

    const existingRecord: PersistedIdempotencyRecord<typeof cachedResult> = {
      id: '2001',
      idempotency_key: VALID_KEY,
      request_fingerprint: originalFingerprint,
      account_id: '10',
      action: 'accept_quote',
      object_type: 'QuoteRequest',
      object_id: '100',
      result_snapshot: cachedResult,
      created_at: NOW,
      expires_at: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    };
    mockRepoContext.findByScopeSpy.mockResolvedValue(existingRecord);

    const differentPayload = {
      expected_request_version: 2, // Changed version!
      delivery_address: 'Different address',
    };

    const executeSpy = vi.fn();
    const getCurrentStateSpy = vi.fn();

    const input: ExecuteWithIdempotencyInput<typeof cachedResult> = {
      accountId: '10',
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      objectId: '100',
      idempotencyKey: VALID_KEY,
      payload: differentPayload,
      execute: executeSpy,
      getCurrentState: getCurrentStateSpy,
    };

    // Act & Assert
    await expect(service.executeWithIdempotency(input)).rejects.toThrow(
      IdempotencyConflictError,
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(mockRepoContext.saveSpy).not.toHaveBeenCalled();
  });

  it('5. Concurrent Race Condition: safely catches P2002 conflict and falls back to replay verification', async () => {
    // Arrange
    mockRepoContext.findByScopeSpy.mockResolvedValue(null);

    const mutationResult = { id: 'quote-100', status: 'buyer_accepted' };
    const mutationState: TradingCurrentStateDto = {
      request: { id: '100', status: 'buyer_accepted', version: 2, cancelled_at: null },
    };

    const executeSpy = vi.fn().mockResolvedValue({
      result: mutationResult,
      currentState: mutationState,
    });
    const getCurrentStateSpy = vi.fn().mockResolvedValue(mutationState);

    // Simulate Prisma P2002 error on save()
    const p2002Error = new Error('Unique constraint failed on IdempotencyRecord');
    (p2002Error as unknown as { code: string }).code = 'P2002';
    mockRepoContext.saveSpy.mockRejectedValue(p2002Error);

    // After P2002, findAndVerifyReplay retrieves the record committed by the winning concurrent thread
    const committedRecord: PersistedIdempotencyRecord<typeof mutationResult> = {
      id: '2001',
      idempotency_key: VALID_KEY,
      request_fingerprint: computeCanonicalFingerprint(BASE_PAYLOAD),
      account_id: '10',
      action: 'accept_quote',
      object_type: 'QuoteRequest',
      object_id: '100',
      result_snapshot: mutationResult,
      created_at: NOW,
      expires_at: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    };
    mockRepoContext.findAndVerifyReplaySpy.mockResolvedValue(committedRecord);

    const input: ExecuteWithIdempotencyInput<typeof mutationResult> = {
      accountId: '10',
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      objectId: '100',
      idempotencyKey: VALID_KEY,
      payload: BASE_PAYLOAD,
      execute: executeSpy,
      getCurrentState: getCurrentStateSpy,
    };

    // Act
    const response = await service.executeWithIdempotency(input);

    // Assert
    expect(response.operation.replayed).toBe(true);
    expect(response.data).toEqual(mutationResult);
    expect(mockRepoContext.findAndVerifyReplaySpy).toHaveBeenCalledTimes(1);
  });

  it('6. Concurrent Race Condition with Mismatched Payload: catches P2002 and throws IdempotencyConflictError', async () => {
    // Arrange
    mockRepoContext.findByScopeSpy.mockResolvedValue(null);

    const executeSpy = vi.fn().mockResolvedValue({
      result: { ok: true },
      currentState: { request: { id: '100', status: 'buyer_accepted', version: 2, cancelled_at: null } },
    });

    const p2002Error = new Error('Unique constraint failed');
    (p2002Error as unknown as { code: string }).code = 'P2002';
    mockRepoContext.saveSpy.mockRejectedValue(p2002Error);

    // findAndVerifyReplay returns null because incoming fingerprint did not match
    mockRepoContext.findAndVerifyReplaySpy.mockResolvedValue(null);

    // findByScope finds the winning record with DIFFERENT fingerprint
    mockRepoContext.findByScopeSpy.mockResolvedValue({
      id: '2001',
      idempotency_key: VALID_KEY,
      request_fingerprint: 'completely-different-fingerprint',
      account_id: '10',
      action: 'accept_quote',
      object_type: 'QuoteRequest',
      object_id: '100',
      result_snapshot: { ok: true },
      created_at: NOW,
      expires_at: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    });

    const input: ExecuteWithIdempotencyInput<unknown> = {
      accountId: '10',
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      objectId: '100',
      idempotencyKey: VALID_KEY,
      payload: BASE_PAYLOAD,
      execute: executeSpy,
      getCurrentState: vi.fn(),
    };

    // Act & Assert
    await expect(service.executeWithIdempotency(input)).rejects.toThrow(
      IdempotencyConflictError,
    );
  });

  it('7. TTL Expiration Cleanup: cleanupExpired() calls deleteExpiredBefore and returns deleted count', async () => {
    // Arrange
    const cutoff = new Date('2026-11-10T10:00:00.000Z');
    mockRepoContext.deleteExpiredBeforeSpy.mockResolvedValue(12);

    // Act
    const deletedCount = await service.cleanupExpired(cutoff);

    // Assert
    expect(deletedCount).toBe(12);
    expect(mockRepoContext.deleteExpiredBeforeSpy).toHaveBeenCalledTimes(1);
    expect(mockRepoContext.deleteExpiredBeforeSpy).toHaveBeenCalledWith(
      cutoff,
      mockTxRunnerContext.dummyTx,
    );

    // Act without cutoff (defaults to current date)
    await service.cleanupExpired();
    expect(mockRepoContext.deleteExpiredBeforeSpy).toHaveBeenCalledTimes(2);
  });

  it('8. Scope Isolation: ensures distinct accounts or actions with the same key do not collide', async () => {
    // Arrange
    mockRepoContext.findByScopeSpy.mockImplementation(
      async (scope: IdempotencyScopeKey) => {
        // Only account_id 10 has a recorded key
        if (scope.account_id === '10') {
          return {
            id: '2001',
            idempotency_key: VALID_KEY,
            request_fingerprint: computeCanonicalFingerprint(BASE_PAYLOAD),
            account_id: '10',
            action: 'accept_quote',
            object_type: 'QuoteRequest',
            object_id: '100',
            result_snapshot: { accepted: true },
            created_at: NOW,
            expires_at: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
          };
        }
        return null;
      },
    );

    const executeSpy = vi.fn().mockResolvedValue({
      result: { accepted: true },
      currentState: { request: { id: '100', status: 'buyer_accepted', version: 2, cancelled_at: null } },
    });
    mockRepoContext.saveSpy.mockResolvedValue({
      id: '2002',
      idempotency_key: VALID_KEY,
      request_fingerprint: computeCanonicalFingerprint(BASE_PAYLOAD),
      account_id: '20', // Different account!
      action: 'accept_quote',
      object_type: 'QuoteRequest',
      object_id: '100',
      result_snapshot: { accepted: true },
      created_at: NOW,
      expires_at: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    });

    const inputAccount20: ExecuteWithIdempotencyInput<{ accepted: boolean }> = {
      accountId: '20', // Account 20 sends the same idempotency key
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      objectId: '100',
      idempotencyKey: VALID_KEY,
      payload: BASE_PAYLOAD,
      execute: executeSpy,
      getCurrentState: vi.fn(),
    };

    // Act
    const res = await service.executeWithIdempotency(inputAccount20);

    // Assert: Account 20 is NOT treated as a replay of Account 10; mutation executes normally
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(res.operation.replayed).toBe(false);
  });

  it('9. Input Validation: rejects invalid scope parameters with InvalidTradingInputError', async () => {
    const validBase: ExecuteWithIdempotencyInput<unknown> = {
      accountId: '10',
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      objectId: '100',
      idempotencyKey: VALID_KEY,
      payload: BASE_PAYLOAD,
      execute: vi.fn(),
      getCurrentState: vi.fn(),
    };

    // Missing account_id
    await expect(
      service.executeWithIdempotency({ ...validBase, accountId: undefined, account_id: undefined }),
    ).rejects.toThrow(InvalidTradingInputError);

    // Invalid account_id (negative)
    await expect(
      service.executeWithIdempotency({ ...validBase, accountId: '-5' }),
    ).rejects.toThrow(InvalidTradingInputError);

    // Empty action
    await expect(
      service.executeWithIdempotency({ ...validBase, action: '   ' }),
    ).rejects.toThrow(InvalidTradingInputError);

    // Empty object_type
    await expect(
      service.executeWithIdempotency({ ...validBase, objectType: '' }),
    ).rejects.toThrow(InvalidTradingInputError);

    // Missing object_id
    await expect(
      service.executeWithIdempotency({ ...validBase, objectId: undefined, object_id: undefined }),
    ).rejects.toThrow(InvalidTradingInputError);

    // Empty idempotency_key
    await expect(
      service.executeWithIdempotency({ ...validBase, idempotencyKey: ' ' }),
    ).rejects.toThrow(InvalidTradingInputError);

    // Idempotency key exceeding 128 characters
    const longKey = 'a'.repeat(129);
    await expect(
      service.executeWithIdempotency({ ...validBase, idempotencyKey: longKey }),
    ).rejects.toThrow(InvalidTradingInputError);
  });
});
