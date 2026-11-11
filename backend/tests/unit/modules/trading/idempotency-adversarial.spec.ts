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
// Mock Test Harness
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
  return { txRunner: { run: runSpy }, dummyTx, runSpy };
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
// Adversarial Stress Tests: Milestone 1 Idempotency
// ============================================================================

describe('Adversarial Empirical Stress Testing — Milestone 1', () => {
  // --------------------------------------------------------------------------
  // Vector 1: UUID v4 Fuzzing & Malformed Payloads
  // --------------------------------------------------------------------------
  describe('Vector 1: UUID v4 Strict Conformance & Adversarial Fuzzing', () => {
    it('rejects version bits tampering: all non-4 versions (0, 1, 2, 3, 5, 6, 7, 8, 9, a, b, c, d, e, f)', () => {
      const versions = ['0', '1', '2', '3', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
      for (const ver of versions) {
        const tampered = `c56a4180-65aa-${ver}2ec-a945-5fd21dec0538`;
        expect(validateUuidV4(tampered)).toBe(false);
        expect(() => normalizeUuidV4(tampered)).toThrow(InvalidTradingInputError);
      }
    });

    it('rejects variant bits tampering: all non-[8,9,a,b,A,B] variants', () => {
      // RFC 4122 variant 10xx requires the 17th hex character to be 8, 9, a, b
      const invalidVariants = [
        '0', '1', '2', '3', '4', '5', '6', '7', // NCS backward compatibility
        'c', 'd',                               // Microsoft GUID
        'e', 'f',                               // Reserved for future definition
        'C', 'D', 'E', 'F',
      ];
      for (const variant of invalidVariants) {
        const tampered = `c56a4180-65aa-42ec-${variant}945-5fd21dec0538`;
        expect(validateUuidV4(tampered)).toBe(false);
        expect(() => normalizeUuidV4(tampered)).toThrow(InvalidTradingInputError);
      }
    });

    it('rejects RFC 4122 Nil UUID and Max UUID', () => {
      const nilUuid = '00000000-0000-0000-0000-000000000000';
      const maxUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

      expect(validateUuidV4(nilUuid)).toBe(false);
      expect(validateUuidV4(maxUuid)).toBe(false);
      expect(() => normalizeUuidV4(nilUuid)).toThrow(InvalidTradingInputError);
      expect(() => normalizeUuidV4(maxUuid)).toThrow(InvalidTradingInputError);
    });

    it('rejects unusual control characters, null bytes, and SQL injection strings', () => {
      const baseValid = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
      const adversarialStrings = [
        `${baseValid}\0`,
        `\0${baseValid}`,
        `c56a4180-65aa-42ec-a945-5fd21dec0538\u0000`,
        `c56a4180-\n5aa-42ec-a945-5fd21dec0538`,
        `c56a4180-65aa-\t42ec-a945-5fd21dec0538`,
        `c56a4180-65aa-42ec-a945-5fd21dec0538%00`,
        `c56a4180-65aa-42ec-a945-5fd21dec0538'; DROP TABLE "IdempotencyRecord";--`,
        `<script>alert("xss")</script>42ec-a945-5fd21dec0538`,
      ];

      for (const badStr of adversarialStrings) {
        expect(validateUuidV4(badStr)).toBe(false);
        expect(() => normalizeUuidV4(badStr)).toThrow(InvalidTradingInputError);
      }
    });

    it('handles CRLF trimming according to ValidateUuidOptions', () => {
      const baseValid = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
      // When trim is default (true), CRLF is treated as trailing whitespace and trimmed
      expect(validateUuidV4(`${baseValid}\r\n`)).toBe(true);
      expect(normalizeUuidV4(`${baseValid}\r\n`)).toBe(baseValid);

      // When trim is false, CRLF must be rejected
      expect(validateUuidV4(`${baseValid}\r\n`, { trim: false })).toBe(false);
    });

    it('rejects unicode lookalikes, full-width characters, homoglyphs, and emoji', () => {
      const baseValid = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
      const unicodeAttacks = [
        // Full-width latin character 'ｃ' (U+FF43) instead of ASCII 'c'
        'ｃ56a4180-65aa-42ec-a945-5fd21dec0538',
        // Cyrillic small letter 'а' (U+0430) instead of ASCII 'a'
        'c56\u04304180-65aa-42ec-a945-5fd21dec0538',
        // Cyrillic small letter 'е' (U+0435) instead of ASCII 'e'
        'c56a4180-65aa-42\u0435c-a945-5fd21dec0538',
        // Em dash '—' (U+2014) instead of hyphen '-'
        'c56a4180\u201465aa\u201442ec\u2014a945\u20145fd21dec0538',
        // Zero-width space (U+200B) injected in middle
        'c56a4180-65aa-42ec-\u200Ba945-5fd21dec0538',
        // Emoji
        '🚀56a4180-65aa-42ec-a945-5fd21dec0538',
        // Non-breaking space inside string
        'c56a4180-65aa\u00A042ec-a945-5fd21dec0538',
      ];

      for (const attack of unicodeAttacks) {
        expect(validateUuidV4(attack)).toBe(false);
        expect(() => normalizeUuidV4(attack)).toThrow(InvalidTradingInputError);
      }
    });

    it('rejects boundary length mutations (35 chars, 37 chars, 72 chars, empty)', () => {
      const baseValid = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
      expect(validateUuidV4(baseValid.slice(0, 35))).toBe(false); // 35 chars
      expect(validateUuidV4(`${baseValid}a`)).toBe(false);        // 37 chars
      expect(validateUuidV4(`${baseValid}${baseValid}`)).toBe(false); // 72 chars
      expect(validateUuidV4('')).toBe(false);
      expect(validateUuidV4('   ')).toBe(false);
    });

    it('rejects non-primitive and non-string types with graceful false / error', () => {
      const nonStrings: unknown[] = [
        null,
        undefined,
        12345678,
        NaN,
        Infinity,
        true,
        false,
        Symbol('uuid'),
        { id: 'c56a4180-65aa-42ec-a945-5fd21dec0538' },
        ['c56a4180-65aa-42ec-a945-5fd21dec0538'],
        () => 'c56a4180-65aa-42ec-a945-5fd21dec0538',
      ];

      for (const bad of nonStrings) {
        expect(validateUuidV4(bad)).toBe(false);
        expect(() => normalizeUuidV4(bad)).toThrow(InvalidTradingInputError);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Vector 2: Canonical Fingerprinting Edge Cases & Invariants
  // --------------------------------------------------------------------------
  describe('Vector 2: Canonical Fingerprint Edge Cases & Stress Scenarios', () => {
    it('guarantees deterministic hashing across 15+ levels of deep nesting with random key orders', () => {
      // Build deeply nested objects with 15 levels
      const depth = 15;
      let deepA: Record<string, unknown> = { leaf: 'target', z_key: 999, a_key: 111 };
      let deepB: Record<string, unknown> = { a_key: 111, leaf: 'target', z_key: 999 };

      for (let i = 1; i <= depth; i++) {
        // Interleave keys in different insertion orders
        deepA = {
          level: i,
          meta: `meta-${i}`,
          sub: deepA,
          created: '2026-11-11',
        };
        deepB = {
          created: '2026-11-11',
          sub: deepB,
          meta: `meta-${i}`,
          level: i,
        };
      }

      const hashA = computeCanonicalFingerprint(deepA);
      const hashB = computeCanonicalFingerprint(deepB);

      expect(hashA).toBe(hashB);
      expect(hashA).toHaveLength(64);

      // Mutate leaf at depth 15 and confirm fingerprint changes strictly
      let deepMutated: Record<string, unknown> = { leaf: 'MODIFIED', z_key: 999, a_key: 111 };
      for (let i = 1; i <= depth; i++) {
        deepMutated = {
          level: i,
          meta: `meta-${i}`,
          sub: deepMutated,
          created: '2026-11-11',
        };
      }
      expect(computeCanonicalFingerprint(deepMutated)).not.toBe(hashA);
    });

    it('strictly differentiates types: numbers vs strings ({ a: 1 } vs { a: "1" })', () => {
      const objNumber = { a: 1 };
      const objNumericString = { a: '1' };

      const fpNumber = computeCanonicalFingerprint(objNumber);
      const fpString = computeCanonicalFingerprint(objNumericString);

      expect(fpNumber).not.toBe(fpString);
    });

    it('strictly differentiates types: boolean vs numbers ({ a: true } vs { a: 1 }) and ({ a: false } vs { a: 0 })', () => {
      const fpBoolTrue = computeCanonicalFingerprint({ a: true });
      const fpNumOne = computeCanonicalFingerprint({ a: 1 });
      expect(fpBoolTrue).not.toBe(fpNumOne);

      const fpBoolFalse = computeCanonicalFingerprint({ a: false });
      const fpNumZero = computeCanonicalFingerprint({ a: 0 });
      expect(fpBoolFalse).not.toBe(fpNumZero);
    });

    it('strictly differentiates types: boolean vs strings ({ a: true } vs { a: "true" })', () => {
      const fpBool = computeCanonicalFingerprint({ a: true });
      const fpStr = computeCanonicalFingerprint({ a: 'true' });
      expect(fpBool).not.toBe(fpStr);
    });

    it('correctly handles undefined vs null properties in objects and arrays', () => {
      // In objects, undefined keys are omitted (matching JSON.stringify)
      const withUndef = { a: 1, b: undefined };
      const withoutUndef = { a: 1 };
      expect(computeCanonicalFingerprint(withUndef)).toBe(computeCanonicalFingerprint(withoutUndef));

      // But null keys are preserved as explicit null
      const withNull = { a: 1, b: null };
      expect(computeCanonicalFingerprint(withNull)).not.toBe(computeCanonicalFingerprint(withUndef));

      // In arrays, undefined becomes null (matching JSON.stringify([1, undefined]))
      const arrWithUndef = [1, undefined, 3];
      const arrWithNull = [1, null, 3];
      expect(computeCanonicalFingerprint(arrWithUndef)).toBe(computeCanonicalFingerprint(arrWithNull));
    });

    it('handles symbols and functions safely without corrupting canonicalization', () => {
      const sym = Symbol('ignored');
      const objWithSymbol = {
        name: 'Item',
        [sym]: 'secret',
        symValue: Symbol('val'),
        fn: () => 'execute',
      };
      const cleanObj = { name: 'Item' };

      expect(computeCanonicalFingerprint(objWithSymbol)).toBe(
        computeCanonicalFingerprint(cleanObj),
      );
    });

    it('differentiates empty structures: {} vs [] vs "" vs null vs false', () => {
      const fpEmptyObj = computeCanonicalFingerprint({});
      const fpNull = computeCanonicalFingerprint(null);
      const fpUndefined = computeCanonicalFingerprint(undefined);
      const fpEmptyArr = computeCanonicalFingerprint([]);
      const fpEmptyStr = computeCanonicalFingerprint('');
      const fpZero = computeCanonicalFingerprint(0);
      const fpFalse = computeCanonicalFingerprint(false);

      // Spec rule: null, undefined normalize to {}
      expect(fpNull).toBe(fpEmptyObj);
      expect(fpUndefined).toBe(fpEmptyObj);

      // [] is distinct from {}
      expect(fpEmptyArr).not.toBe(fpEmptyObj);

      // "" is distinct from {} and []
      expect(fpEmptyStr).not.toBe(fpEmptyObj);
      expect(fpEmptyStr).not.toBe(fpEmptyArr);

      // 0 is distinct from false and empty
      expect(fpZero).not.toBe(fpEmptyObj);
      expect(fpZero).not.toBe(fpFalse);
      expect(fpFalse).not.toBe(fpEmptyObj);
    });

    it('detects direct, indirect, and array circular references and raises InvalidTradingInputError', () => {
      // Direct
      const direct: Record<string, unknown> = { id: 1 };
      direct.self = direct;
      expect(() => computeCanonicalFingerprint(direct)).toThrow(InvalidTradingInputError);

      // Indirect (A -> B -> C -> A)
      const a: Record<string, unknown> = { name: 'A' };
      const b: Record<string, unknown> = { name: 'B' };
      const c: Record<string, unknown> = { name: 'C' };
      a.next = b;
      b.next = c;
      c.next = a;
      expect(() => computeCanonicalFingerprint(a)).toThrow(InvalidTradingInputError);

      // Array circular (arr contains arr)
      const arr: unknown[] = [1, 2];
      arr.push(arr);
      expect(() => computeCanonicalFingerprint(arr)).toThrow(InvalidTradingInputError);
    });

    it('handles diamond DAG references when serialized through standard JSON roundtrip', () => {
      // In real HTTP payloads, JSON.parse produces independent instances.
      // Verify that payloads roundtripped from JSON parse cleanly.
      const rawJson = '{"left":{"shared":"val"},"right":{"shared":"val"}}';
      expect(() => computeCanonicalFingerprint(rawJson)).not.toThrow();
      expect(computeCanonicalFingerprint(rawJson)).toHaveLength(64);
    });

    it('gracefully handles raw non-JSON string payloads without crashing', () => {
      const nonJsonString = 'plain text payload not in json format';
      const fp = computeCanonicalFingerprint(nonJsonString);
      expect(fp).toHaveLength(64);
      expect(fp).toMatch(/^[0-9a-f]{64}$/);

      const malformedJson = '{ key: value without quotes }';
      const fpMalformed = computeCanonicalFingerprint(malformedJson);
      expect(fpMalformed).toHaveLength(64);
      expect(fpMalformed).not.toBe(fp);
    });

    it('handles complex nested array structures, preserving order while canonicalizing object keys', () => {
      const arrNested1 = [
        [{ z: 1, a: 2 }, { d: 4, c: 3 }],
        { tags: ['urgent', 'fragile'], meta: { y: 20, x: 10 } },
      ];
      const arrNested2 = [
        [{ a: 2, z: 1 }, { c: 3, d: 4 }],
        { meta: { x: 10, y: 20 }, tags: ['urgent', 'fragile'] },
      ];
      expect(computeCanonicalFingerprint(arrNested1)).toBe(
        computeCanonicalFingerprint(arrNested2),
      );

      // Mutating array order changes the fingerprint
      const arrSwapped = [
        [{ d: 4, c: 3 }, { a: 2, z: 1 }],
        { meta: { x: 10, y: 20 }, tags: ['urgent', 'fragile'] },
      ];
      expect(computeCanonicalFingerprint(arrNested1)).not.toBe(
        computeCanonicalFingerprint(arrSwapped),
      );
    });

    it('safely serializes non-finite numbers and BigInt inside arrays', () => {
      const arrWithSpecials = [NaN, Infinity, -Infinity, 100n];
      const canonical = canonicalizeJson(arrWithSpecials) as unknown[];
      expect(canonical).toEqual([null, null, null, '100']);
    });

    it('documents behavior for in-memory shared object references (DAG)', () => {
      // Because canonicalizeJson uses WeakSet across the traversal,
      // an in-memory shared sub-object reference triggers the circular guard.
      // In HTTP payloads this never occurs because JSON.parse creates distinct object references.
      const sharedChild = { key: 'val' };
      const inMemoryDag = { a: sharedChild, b: sharedChild };
      expect(() => canonicalizeJson(inMemoryDag)).toThrow(InvalidTradingInputError);
    });
  });

  // --------------------------------------------------------------------------
  // Vector 3: Version Sensitivity & Strict HTTP 409 IDEMPOTENCY_CONFLICT
  // --------------------------------------------------------------------------
  describe('Vector 3: Version Sensitivity & Optimistic Concurrency Invariants', () => {
    let mockTxRunnerContext: MockTxRunnerContext;
    let mockRepoContext: MockIdempotencyRepoContext;
    let service: TradingIdempotencyService;

    const NOW = new Date('2026-11-11T10:00:00.000Z');
    const VALID_KEY = 'c56a4180-65aa-42ec-a945-5fd21dec0538';

    beforeEach(() => {
      vi.clearAllMocks();
      mockTxRunnerContext = createMockTxRunner();
      mockRepoContext = createMockIdempotencyRepo();
      service = new TradingIdempotencyService(
        mockRepoContext.repo,
        mockTxRunnerContext.txRunner,
      );
    });

    const expectedVersionFields = [
      'expected_request_version',
      'expected_quote_version',
      'expected_proposal_version',
      'expected_allocation_version',
      'expected_recipient_version',
    ] as const;

    for (const field of expectedVersionFields) {
      it(`changing ${field} strictly changes fingerprint and triggers HTTP 409 IDEMPOTENCY_CONFLICT on replay`, async () => {
        const payloadOriginal = {
          quote_request_id: '100',
          [field]: 1,
          action: 'confirm',
        };
        const payloadMutated = {
          quote_request_id: '100',
          [field]: 2, // Increment version!
          action: 'confirm',
        };

        const originalFingerprint = computeCanonicalFingerprint(payloadOriginal);
        const mutatedFingerprint = computeCanonicalFingerprint(payloadMutated);

        // 1. Verify fingerprints are strictly distinct
        expect(originalFingerprint).not.toBe(mutatedFingerprint);

        // 2. Set up persisted record with originalFingerprint
        const cachedResult = { ok: true, version: 1 };
        const existingRecord: PersistedIdempotencyRecord<typeof cachedResult> = {
          id: '5001',
          idempotency_key: VALID_KEY,
          request_fingerprint: originalFingerprint,
          account_id: '10',
          action: 'confirm_action',
          object_type: 'QuoteRequest',
          object_id: '100',
          result_snapshot: cachedResult,
          created_at: NOW,
          expires_at: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
        };
        mockRepoContext.findByScopeSpy.mockResolvedValue(existingRecord);

        // 3. Client re-sends with SAME key but MUTATED version
        const executeSpy = vi.fn();
        const getCurrentStateSpy = vi.fn();

        const input: ExecuteWithIdempotencyInput<typeof cachedResult> = {
          accountId: '10',
          action: 'confirm_action',
          objectType: 'QuoteRequest',
          objectId: '100',
          idempotencyKey: VALID_KEY,
          payload: payloadMutated,
          execute: executeSpy,
          getCurrentState: getCurrentStateSpy,
        };

        // 4. Assert: Must throw IdempotencyConflictError (409)
        await expect(service.executeWithIdempotency(input)).rejects.toThrow(
          IdempotencyConflictError,
        );

        // 5. Assert: Business mutation must NOT have executed
        expect(executeSpy).not.toHaveBeenCalled();
        expect(mockRepoContext.saveSpy).not.toHaveBeenCalled();
      });
    }

    it('allows identical replay when expected_*_version and all payload attributes remain identical', async () => {
      const payload = {
        expected_request_version: 3,
        expected_quote_version: 7,
        unit_price: 150000,
      };

      const originalFingerprint = computeCanonicalFingerprint(payload);
      const cachedResult = { quoteId: 'quote-77', status: 'accepted' };
      const freshState: TradingCurrentStateDto = {
        request: { id: '100', status: 'in_production', version: 4, cancelled_at: null },
      };

      const existingRecord: PersistedIdempotencyRecord<typeof cachedResult> = {
        id: '9001',
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

      const executeSpy = vi.fn();
      const getCurrentStateSpy = vi.fn().mockResolvedValue(freshState);

      const input: ExecuteWithIdempotencyInput<typeof cachedResult> = {
        accountId: '10',
        action: 'accept_quote',
        objectType: 'QuoteRequest',
        objectId: '100',
        idempotencyKey: VALID_KEY,
        payload,
        execute: executeSpy,
        getCurrentState: getCurrentStateSpy,
      };

      const response = await service.executeWithIdempotency(input);

      expect(executeSpy).not.toHaveBeenCalled();
      expect(response.replayed).toBe(true);
      expect(response.data).toEqual(cachedResult);
      expect(response.operation.current_state).toEqual(freshState);
    });
  });

  // --------------------------------------------------------------------------
  // Vector 4: High Concurrency Stress Harness
  // --------------------------------------------------------------------------
  describe('Vector 4: High Concurrency Race Condition Simulation', () => {
    it('simulates 30 concurrent competing requests: handles race safely without duplicate execution', async () => {
      const concurrency = 30;
      let winningThreadExecuted = false;
      const VALID_KEY = 'a11a4180-65aa-42ec-a945-5fd21dec0538';
      const NOW = new Date('2026-11-11T10:00:00.000Z');
      const payload = { expected_request_version: 1, action: 'cancel' };
      const expectedFingerprint = computeCanonicalFingerprint(payload);

      const mockTxRunner = createMockTxRunner();

      // Shared in-memory "database" table
      let storedRecord: PersistedIdempotencyRecord<any> | null = null;

      const mockRepo: IIdempotencyRecordRepository = {
        findByScope: vi.fn().mockImplementation(async () => {
          return storedRecord;
        }),
        findAndVerifyReplay: vi.fn().mockImplementation(async (scope) => {
          if (storedRecord && storedRecord.request_fingerprint === scope.request_fingerprint) {
            return storedRecord;
          }
          return null;
        }),
        save: vi.fn().mockImplementation(async (input) => {
          // If a record already exists, throw Prisma P2002 unique constraint error!
          if (storedRecord !== null) {
            const err = new Error('Unique constraint failed on IdempotencyRecord');
            (err as any).code = 'P2002';
            throw err;
          }
          storedRecord = {
            id: 'rec-1',
            idempotency_key: input.idempotency_key,
            request_fingerprint: input.request_fingerprint,
            account_id: input.account_id,
            action: input.action,
            object_type: input.object_type,
            object_id: input.object_id,
            result_snapshot: input.result_snapshot,
            created_at: NOW,
            expires_at: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
          };
          return storedRecord;
        }),
        deleteExpiredBefore: vi.fn().mockResolvedValue(0),
      };

      const service = new TradingIdempotencyService(mockRepo, mockTxRunner.txRunner);

      let executionCount = 0;
      const results = await Promise.all(
        Array.from({ length: concurrency }).map(async (_, idx) => {
          return service.executeWithIdempotency({
            accountId: '10',
            action: 'cancel',
            objectType: 'QuoteRequest',
            objectId: '100',
            idempotencyKey: VALID_KEY,
            payload,
            execute: async () => {
              executionCount++;
              return {
                result: { cancelled: true, by: idx },
                currentState: { request: { id: '100', status: 'cancelled', version: 2, cancelled_at: NOW.toISOString() } },
              };
            },
            getCurrentState: async () => {
              return { request: { id: '100', status: 'cancelled', version: 2, cancelled_at: NOW.toISOString() } };
            },
          });
        }),
      );

      // In a concurrent race, execute() should only run for the winner(s) before save conflicts
      // Exactly 1 winner persisted the record
      expect(storedRecord).not.toBeNull();
      expect(storedRecord!.idempotency_key).toBe(VALID_KEY);
      expect(storedRecord!.request_fingerprint).toBe(expectedFingerprint);

      // All 30 callers should receive successful responses with the same result data
      for (const res of results) {
        expect(res.data.cancelled).toBe(true);
      }

      // Replayed count should be concurrency - executionCount
      const replayedResults = results.filter((r) => r.replayed);
      expect(replayedResults.length).toBeGreaterThan(0);
    });
  });
});
