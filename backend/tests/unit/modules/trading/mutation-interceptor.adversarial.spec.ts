import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { firstValueFrom, isObservable, of, type Observable } from 'rxjs';
import { type ExecutionContext, type CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

// Foundation & Security imports
import {
  HttpResult,
  ResponseEnvelopeInterceptor,
} from '../../../../src/common/http/interceptors/response-envelope.interceptor';
import { authenticatedActors } from '../../../../src/common/security/guards/authenticated-request';
import type { AuthenticatedActor } from '../../../../src/common/application/types/contract-types';
import { statusByCode } from '../../../../src/common/http/filters/api-problem';
import type { TransactionContext } from '../../../../src/common/application/ports/transaction-runner';

// Trading Domain imports
import {
  ConcurrencyConflictError,
  IdempotencyConflictError,
  InvalidTradingInputError,
  TradingPermissionDeniedError,
  TRADING_INVARIANTS,
} from '../../../../src/modules/trading/domain';

// Trading Application & Interceptor imports
import {
  TradingIdempotencyService,
  type ExecuteWithIdempotencyInput,
} from '../../../../src/modules/trading/application/services/trading-idempotency.service';
import type { TradingCurrentStateDto } from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';

// Target Interceptor & Decorator (Contract Under Test)
import {
  TradingMutationInterceptor,
  TRADING_MUTATION_METADATA_KEY,
  TRADING_TX_REQUEST_KEY,
  type TradingMutationOptions,
} from '../../../../src/modules/trading/adapters/http/interceptors/trading-mutation.interceptor';
import type { ITradingCurrentStateResolver } from '../../../../src/modules/trading/adapters/http/interceptors/trading-current-state.resolver';

// ============================================================================
// Specialized Empirical Challenger Harness
// ============================================================================

interface MockExecutionContextOptions {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  params?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | undefined>;
  actor?: AuthenticatedActor | null;
  user?: unknown;
  handler?: Function;
  controllerClass?: Function;
  statusCode?: number;
}

function createMockExecutionContext(options: MockExecutionContextOptions = {}) {
  const req: any = {
    headers: { ...options.headers },
    body: options.body,
    params: { ...options.params },
    query: { ...options.query },
    user: options.user,
    get(name: string) {
      return this.headers[name.toLowerCase()];
    },
  };

  if (options.actor !== undefined) {
    if (options.actor) {
      authenticatedActors.set(req, options.actor);
    }
  }

  const res: any = {
    statusCode: options.statusCode ?? 200,
    headersSent: false,
    setHeader: vi.fn(),
    getHeader: vi.fn(),
    status: vi.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };

  const handler = options.handler ?? function mockHandler() {};
  const controllerClass = options.controllerClass ?? class MockController {};

  const context: ExecutionContext = {
    switchToHttp: () => ({
      getRequest: () => req as Request,
      getResponse: () => res as Response,
      getNext: () => vi.fn(),
    }),
    getHandler: () => handler,
    getClass: () => controllerClass as any,
    getArgs: () => [req, res] as any,
    getArgByIndex: (idx: number) => (idx === 0 ? req : res),
    getType: () => 'http' as any,
    switchToRpc: () => ({} as any),
    switchToWs: () => ({} as any),
  };

  return { context, req, res, handler, controllerClass };
}

function createMockCallHandler<T = any>(
  resultOrFactory?: T | (() => Observable<T> | T | Promise<T>),
): { callHandler: CallHandler<T>; handleSpy: ReturnType<typeof vi.fn> } {
  const handleSpy = vi.fn().mockImplementation(() => {
    if (typeof resultOrFactory === 'function') {
      const val = (resultOrFactory as Function)();
      if (isObservable(val)) return val;
      return of(val);
    }
    return of(resultOrFactory !== undefined ? resultOrFactory : undefined);
  });

  return {
    callHandler: { handle: handleSpy },
    handleSpy,
  };
}

// ============================================================================
// Adversarial Empirical Challenge Suite
// ============================================================================

describe('Adversarial Empirical Challenge — TradingMutationInterceptor', () => {
  const VALID_UUID_V4 = 'c7a8b9e0-1234-4567-89ab-cdef01234567';
  const VALID_ACTOR: AuthenticatedActor = {
    accountId: '100',
    role: 'client',
    workshopId: null,
    authVersion: 1,
    sessionId: 'sess-test-123',
    sessionLevel: 'normal',
  };

  let mockReflector: Reflector;
  let mockIdempotencyService: TradingIdempotencyService;
  let executeWithIdempotencySpy: ReturnType<typeof vi.fn>;
  let interceptor: TradingMutationInterceptor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReflector = new Reflector();
    executeWithIdempotencySpy = vi.fn();
    mockIdempotencyService = {
      executeWithIdempotency: executeWithIdempotencySpy,
      cleanupExpired: vi.fn(),
    } as unknown as TradingIdempotencyService;

    interceptor = new TradingMutationInterceptor(
      mockReflector,
      mockIdempotencyService,
    );
  });

  // ==========================================================================
  // Dimension 1: Header Variations & RFC 4122 Strict Fuzzing
  // ==========================================================================
  describe('Dimension 1: Header Variations & RFC 4122 Strict UUID v4 Fuzzing', () => {
    const MUTATION_META: TradingMutationOptions = {
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      expectedVersionField: 'expected_request_version',
    };

    beforeEach(() => {
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(MUTATION_META);
    });

    it('rejects missing X-Idempotency-Key header with HTTP 400 INVALID_INPUT', async () => {
      const { context } = createMockExecutionContext({
        headers: {},
        body: { expected_request_version: 1 },
        actor: VALID_ACTOR,
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        InvalidTradingInputError,
      );
      expect(handleSpy).not.toHaveBeenCalled();
      expect(executeWithIdempotencySpy).not.toHaveBeenCalled();
    });

    it('rejects empty string X-Idempotency-Key header', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': '' },
        body: { expected_request_version: 1 },
        actor: VALID_ACTOR,
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        InvalidTradingInputError,
      );
      expect(handleSpy).not.toHaveBeenCalled();
    });

    it('rejects whitespace-only X-Idempotency-Key header (spaces, tabs, newlines)', async () => {
      for (const blank of ['   ', '\t', '\n\r  ', ' \t \r\n ']) {
        const { context } = createMockExecutionContext({
          headers: { 'x-idempotency-key': blank },
          body: { expected_request_version: 1 },
          actor: VALID_ACTOR,
        });
        const { callHandler, handleSpy } = createMockCallHandler();

        await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
          InvalidTradingInputError,
        );
        expect(handleSpy).not.toHaveBeenCalled();
      }
    });

    it('rejects non-v4 UUIDs (v1, v3, v5, nil, invalid version/variant bits)', async () => {
      const adversarialKeys = [
        '00000000-0000-0000-0000-000000000000', // Nil UUID
        '6ba7b810-9dad-11d1-80b4-00c04fd430c8', // UUID v1 (timestamp)
        '6ba7b810-9dad-31d1-80b4-00c04fd430c8', // UUID v3 (MD5)
        '6ba7b810-9dad-51d1-80b4-00c04fd430c8', // UUID v5 (SHA-1)
        'c7a8b9e0-1234-0567-89ab-cdef01234567', // version bit 0
        'c7a8b9e0-1234-2567-89ab-cdef01234567', // version bit 2
        'c7a8b9e0-1234-6567-89ab-cdef01234567', // version bit 6
        'c7a8b9e0-1234-4567-09ab-cdef01234567', // variant bit 0 (NCS backward compat)
        'c7a8b9e0-1234-4567-79ab-cdef01234567', // variant bit 7 (reserved)
        'c7a8b9e0-1234-4567-c9ab-cdef01234567', // variant bit c (Microsoft GUID)
        'c7a8b9e0-1234-4567-e9ab-cdef01234567', // variant bit e (future reserved)
        'c7a8b9e0-1234-4567-89ab-cdef0123456g', // invalid hex 'g'
        'c7a8b9e0-1234-4567-89ab-cdef0123456!', // punctuation
        'c7a8b9e0-1234-4567-89ab-cdef0123456',  // 35 chars (too short)
        'c7a8b9e0-1234-4567-89ab-cdef012345678',// 37 chars (too long)
        "c7a8b9e0-1234-4567-89ab-cdef01234567' OR 1=1--", // injection payload
      ];

      for (const invalidKey of adversarialKeys) {
        const { context } = createMockExecutionContext({
          headers: { 'x-idempotency-key': invalidKey },
          body: { expected_request_version: 1 },
          actor: VALID_ACTOR,
        });
        const { callHandler, handleSpy } = createMockCallHandler();

        await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
          InvalidTradingInputError,
        );
        expect(handleSpy).not.toHaveBeenCalled();
      }
    });

    it('accepts uppercase and mixed-case UUID v4 and normalizes to lowercase', async () => {
      const upperKey = VALID_UUID_V4.toUpperCase();
      const mixedKey = 'C7a8B9e0-1234-4567-89Ab-CdeF01234567';

      for (const key of [upperKey, mixedKey]) {
        const { context } = createMockExecutionContext({
          headers: { 'x-idempotency-key': key },
          body: { expected_request_version: 1 },
          actor: VALID_ACTOR,
          params: { id: '1001' },
        });
        const { callHandler } = createMockCallHandler();

        executeWithIdempotencySpy.mockResolvedValueOnce({
          data: { id: '1001' },
          operation: {
            id: 'rec-1',
            replayed: false,
            committed_at: new Date().toISOString(),
            current_state: {},
          },
        });

        await interceptor.intercept(context, callHandler);

        expect(executeWithIdempotencySpy).toHaveBeenLastCalledWith(
          expect.objectContaining({
            idempotencyKey: VALID_UUID_V4.toLowerCase(),
          }),
        );
      }
    });

    it('trims leading and trailing whitespace from valid UUID v4', async () => {
      const paddedKey = `  \t ${VALID_UUID_V4} \n  `;
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': paddedKey },
        body: { expected_request_version: 1 },
        actor: VALID_ACTOR,
        params: { id: '1001' },
      });
      const { callHandler } = createMockCallHandler();

      executeWithIdempotencySpy.mockResolvedValueOnce({
        data: { id: '1001' },
        operation: {
          id: 'rec-1',
          replayed: false,
          committed_at: new Date().toISOString(),
          current_state: {},
        },
      });

      await interceptor.intercept(context, callHandler);

      expect(executeWithIdempotencySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: VALID_UUID_V4.toLowerCase(),
        }),
      );
    });

    it('handles header array values by using first element', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': [VALID_UUID_V4, 'other-key'] },
        body: { expected_request_version: 1 },
        actor: VALID_ACTOR,
        params: { id: '1001' },
      });
      const { callHandler } = createMockCallHandler();

      executeWithIdempotencySpy.mockResolvedValueOnce({
        data: { id: '1001' },
        operation: {
          id: 'rec-1',
          replayed: false,
          committed_at: new Date().toISOString(),
          current_state: {},
        },
      });

      await interceptor.intercept(context, callHandler);

      expect(executeWithIdempotencySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: VALID_UUID_V4.toLowerCase(),
        }),
      );
    });
  });

  // ==========================================================================
  // Dimension 2: Version Variations & Strict OCC Syntactic Checks
  // ==========================================================================
  describe('Dimension 2: Version Variations & OCC Syntactic Validation', () => {
    const MUTATION_META: TradingMutationOptions = {
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      expectedVersionField: 'expected_request_version',
    };

    beforeEach(() => {
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(MUTATION_META);
    });

    it('rejects omitted expected version field with HTTP 400 INVALID_INPUT', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { note: 'missing version' },
        actor: VALID_ACTOR,
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        InvalidTradingInputError,
      );
      expect(handleSpy).not.toHaveBeenCalled();
    });

    it('rejects undefined/null body when expected version is required', async () => {
      for (const malformedBody of [undefined, null, 'not-an-object', 12345]) {
        const { context } = createMockExecutionContext({
          headers: { 'x-idempotency-key': VALID_UUID_V4 },
          body: malformedBody,
          actor: VALID_ACTOR,
        });
        const { callHandler, handleSpy } = createMockCallHandler();

        await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
          InvalidTradingInputError,
        );
        expect(handleSpy).not.toHaveBeenCalled();
      }
    });

    it('rejects non-integer expected version values (strings, floats, booleans, objects, arrays)', async () => {
      const invalidVersions = [
        ['string integer', '1'],
        ['string zero', '0'],
        ['string negative', '-1'],
        ['float 1.5', 1.5],
        ['float 0.1', 0.1],
        ['boolean true', true],
        ['boolean false', false],
        ['array [1]', [1]],
        ['empty array', []],
        ['object { v: 1 }', { v: 1 }],
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
      ];

      for (const [_desc, val] of invalidVersions) {
        const { context } = createMockExecutionContext({
          headers: { 'x-idempotency-key': VALID_UUID_V4 },
          body: { expected_request_version: val },
          actor: VALID_ACTOR,
        });
        const { callHandler, handleSpy } = createMockCallHandler();

        await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
          InvalidTradingInputError,
        );
        expect(handleSpy).not.toHaveBeenCalled();
      }
    });

    it('rejects non-positive versions: zero (0) and negative integers', async () => {
      for (const nonPositive of [0, -1, -5, -2147483648]) {
        const { context } = createMockExecutionContext({
          headers: { 'x-idempotency-key': VALID_UUID_V4 },
          body: { expected_request_version: nonPositive },
          actor: VALID_ACTOR,
        });
        const { callHandler, handleSpy } = createMockCallHandler();

        await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
          InvalidTradingInputError,
        );
        expect(handleSpy).not.toHaveBeenCalled();
      }
    });

    it('rejects integer overflow (> 2147483647)', async () => {
      for (const overflow of [2147483648, 3000000000, Number.MAX_SAFE_INTEGER]) {
        const { context } = createMockExecutionContext({
          headers: { 'x-idempotency-key': VALID_UUID_V4 },
          body: { expected_request_version: overflow },
          actor: VALID_ACTOR,
        });
        const { callHandler, handleSpy } = createMockCallHandler();

        await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
          InvalidTradingInputError,
        );
        expect(handleSpy).not.toHaveBeenCalled();
      }
    });

    it('rejects explicit undefined in version property', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: undefined },
        actor: VALID_ACTOR,
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        InvalidTradingInputError,
      );
      expect(handleSpy).not.toHaveBeenCalled();
    });

    it('rejects null version when disallowed', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: null },
        actor: VALID_ACTOR,
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        InvalidTradingInputError,
      );
      expect(handleSpy).not.toHaveBeenCalled();
    });

    it('permits null version when allowNullVersion is true (e.g. submit_quote initial creation)', async () => {
      const quoteSubmitMeta: TradingMutationOptions = {
        action: 'submit_quote',
        objectType: 'Quote',
        expectedVersionField: 'expected_quote_version',
        allowNullVersion: true,
      };
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(quoteSubmitMeta);

      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_quote_version: null, price: 100000 },
        actor: VALID_ACTOR,
        params: { id: '2001' },
      });
      const { callHandler } = createMockCallHandler({ id: '2001' });

      executeWithIdempotencySpy.mockResolvedValueOnce({
        data: { id: '2001' },
        operation: {
          id: 'rec-1',
          replayed: false,
          committed_at: new Date().toISOString(),
          current_state: {},
        },
      });

      await expect(interceptor.intercept(context, callHandler)).resolves.toBeDefined();
      expect(executeWithIdempotencySpy).toHaveBeenCalledTimes(1);
    });

    it('permits null for specific field in allowNullableVersion array', async () => {
      const multiVersionMeta: TradingMutationOptions = {
        action: 'submit_proposal',
        objectType: 'SplitProposal',
        expectedVersionFields: ['expected_request_version', 'expected_proposal_version'],
        allowNullableVersion: ['expected_proposal_version'],
      };
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(multiVersionMeta);

      // expected_request_version is 1 (valid), expected_proposal_version is null (allowed)
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1, expected_proposal_version: null },
        actor: VALID_ACTOR,
        params: { id: '3001' },
      });
      const { callHandler } = createMockCallHandler({ id: '3001' });

      executeWithIdempotencySpy.mockResolvedValueOnce({
        data: { id: '3001' },
        operation: {
          id: 'rec-1',
          replayed: false,
          committed_at: new Date().toISOString(),
          current_state: {},
        },
      });

      await expect(interceptor.intercept(context, callHandler)).resolves.toBeDefined();
      expect(executeWithIdempotencySpy).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Dimension 3: Idempotency Replay vs Payload Conflict (HTTP 409)
  // ==========================================================================
  describe('Dimension 3: Idempotency Replay Mechanics & Fingerprint Integrity', () => {
    const MUTATION_META: TradingMutationOptions = {
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      expectedVersionField: 'expected_request_version',
    };

    beforeEach(() => {
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(MUTATION_META);
    });

    it('safely replays with identical payload: returns cached snapshot, fresh current_state, replayed: true, handler bypassed', async () => {
      const cachedSnapshot = {
        request_id: '1001',
        status: 'buyer_accepted',
        allocations: [{ id: 'alloc-1', quantity: 50 }],
      };
      const freshCurrentState = {
        request: {
          id: '1001',
          status: 'in_production' as const,
          version: 8,
          cancelled_at: null,
        },
      };

      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1, quote_id: '2001' },
        actor: VALID_ACTOR,
        params: { id: '1001' },
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      executeWithIdempotencySpy.mockResolvedValueOnce({
        data: cachedSnapshot,
        result: cachedSnapshot,
        operation: {
          id: 'rec-idemp-1',
          replayed: true,
          committed_at: '2026-11-10T12:00:00.000Z',
          current_state: freshCurrentState,
        },
        replayed: true,
        currentState: freshCurrentState,
        recordId: 'rec-idemp-1',
      });

      const observable = await interceptor.intercept(context, callHandler);
      const emitted: any = await firstValueFrom(observable);

      // Handler is NOT executed on replay
      expect(handleSpy).not.toHaveBeenCalled();
      expect(emitted).toBeInstanceOf(HttpResult);
      expect(emitted.data).toEqual(cachedSnapshot);
      expect(emitted.metadata.operation.replayed).toBe(true);
      expect(emitted.metadata.operation.current_state).toEqual(freshCurrentState);
    });

    it('rejects replay with modified payload with HTTP 409 IDEMPOTENCY_CONFLICT', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1, quote_id: '2002' }, // different quote_id
        actor: VALID_ACTOR,
        params: { id: '1001' },
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      executeWithIdempotencySpy.mockRejectedValue(
        new IdempotencyConflictError(
          'Idempotency key has already been used with a different request fingerprint.',
          {
            key: VALID_UUID_V4,
            existingFingerprint: 'fingerprint-1',
            incomingFingerprint: 'fingerprint-2',
          },
        ),
      );

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        IdempotencyConflictError,
      );

      try {
        await interceptor.intercept(context, callHandler);
      } catch (err: any) {
        expect(err.code).toBe('IDEMPOTENCY_CONFLICT');
        expect(statusByCode[err.code as keyof typeof statusByCode]).toBe(409);
        expect(err.invariant).toBe(TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY);
      }

      expect(handleSpy).not.toHaveBeenCalled();
    });

    it('rejects replay when expected version was altered (fingerprint mismatch)', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 2 }, // altered from original 1
        actor: VALID_ACTOR,
        params: { id: '1001' },
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      executeWithIdempotencySpy.mockRejectedValueOnce(
        new IdempotencyConflictError('Fingerprint mismatch due to version change'),
      );

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        IdempotencyConflictError,
      );
      expect(handleSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Dimension 4: HTTP 204 DELETE Replay Behavior
  // ==========================================================================
  describe('Dimension 4: HTTP 204 DELETE Replay Behavior', () => {
    const DELETE_META: TradingMutationOptions = {
      action: 'delete_draft',
      objectType: 'QuoteRequest',
      expectedVersionField: 'expected_request_version',
    };

    beforeEach(() => {
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(DELETE_META);
    });

    it('initial 204 DELETE executes handler, stores null snapshot, returns HttpResult(undefined, { replayed: false })', async () => {
      const { context, res } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1 },
        actor: VALID_ACTOR,
        params: { id: '1001' },
        statusCode: 204,
      });
      const { callHandler, handleSpy } = createMockCallHandler(undefined);

      executeWithIdempotencySpy.mockImplementation(
        async (input: ExecuteWithIdempotencyInput<any, any>) => {
          const { result, currentState } = await input.execute({} as TransactionContext);
          expect(result).toBeNull(); // undefined resultData mapped to null
          return {
            data: result,
            result,
            operation: {
              id: 'del-rec-1',
              replayed: false,
              committed_at: '2026-11-11T10:00:00Z',
              current_state: currentState,
            },
            replayed: false,
            currentState,
            recordId: 'del-rec-1',
          };
        },
      );

      const observable = await interceptor.intercept(context, callHandler);
      const emitted: any = await firstValueFrom(observable);

      expect(handleSpy).toHaveBeenCalledTimes(1);
      expect(emitted).toBeInstanceOf(HttpResult);
      expect(emitted.data).toBeUndefined(); // Crucial for 204 No Content
      expect(emitted.metadata.operation.replayed).toBe(false);
      expect(emitted.metadata.operation.id).toBe('del-rec-1');
    });

    it('replayed 204 DELETE with identical payload bypasses handler and returns HttpResult(undefined, { replayed: true })', async () => {
      const { context, res } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1 },
        actor: VALID_ACTOR,
        params: { id: '1001' },
        statusCode: 204,
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      executeWithIdempotencySpy.mockResolvedValueOnce({
        data: null,
        result: null,
        operation: {
          id: 'del-rec-1',
          replayed: true,
          committed_at: '2026-11-11T10:00:00Z',
          current_state: {
            request: { id: '1001', status: 'cancelled', version: 2, cancelled_at: null },
          },
        },
        replayed: true,
        recordId: 'del-rec-1',
      });

      const observable = await interceptor.intercept(context, callHandler);
      const emitted: any = await firstValueFrom(observable);

      expect(handleSpy).not.toHaveBeenCalled(); // Handler was NOT re-executed
      expect(emitted).toBeInstanceOf(HttpResult);
      expect(emitted.data).toBeUndefined();
      expect(emitted.metadata.operation.replayed).toBe(true);
      expect(emitted.metadata.operation.id).toBe('del-rec-1');
    });

    it('replayed 204 DELETE with modified payload rejects with HTTP 409 IDEMPOTENCY_CONFLICT', async () => {
      const { context, res } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1, reason: 'changed reason' },
        actor: VALID_ACTOR,
        params: { id: '1001' },
        statusCode: 204,
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      executeWithIdempotencySpy.mockRejectedValueOnce(
        new IdempotencyConflictError('Payload changed on DELETE replay'),
      );

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        IdempotencyConflictError,
      );
      expect(handleSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Dimension 5: TransactionContext Lifecycle & Exception Safety
  // ==========================================================================
  describe('Dimension 5: TransactionContext Lifecycle & Cleanup Invariant', () => {
    const MUTATION_META: TradingMutationOptions = {
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      expectedVersionField: 'expected_request_version',
    };

    beforeEach(() => {
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(MUTATION_META);
    });

    it('injects tx into req[TRADING_TX_REQUEST_KEY] during handler execution and removes it in finally block', async () => {
      let txObservedInsideHandler: TransactionContext | undefined;
      const dummyTx = { brand: 'tx-test-context' } as unknown as TransactionContext;

      const { context, req } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1 },
        actor: VALID_ACTOR,
        params: { id: '1001' },
      });

      const { callHandler } = createMockCallHandler(() => {
        txObservedInsideHandler = req[TRADING_TX_REQUEST_KEY];
        return { id: '1001', status: 'buyer_accepted' };
      });

      executeWithIdempotencySpy.mockImplementation(
        async (input: ExecuteWithIdempotencyInput<any, any>) => {
          return await input.execute(dummyTx);
        },
      );

      await interceptor.intercept(context, callHandler);

      expect(txObservedInsideHandler).toBe(dummyTx);
      expect(req[TRADING_TX_REQUEST_KEY]).toBeUndefined(); // Cleared in finally!
    });

    it('ensures req[TRADING_TX_REQUEST_KEY] is removed even when route handler throws an exception', async () => {
      const dummyTx = { brand: 'tx-test-context' } as unknown as TransactionContext;

      const { context, req } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1 },
        actor: VALID_ACTOR,
        params: { id: '1001' },
      });

      const { callHandler } = createMockCallHandler(() => {
        expect(req[TRADING_TX_REQUEST_KEY]).toBe(dummyTx);
        throw new ConcurrencyConflictError('OCC conflict inside handler');
      });

      executeWithIdempotencySpy.mockImplementation(
        async (input: ExecuteWithIdempotencyInput<any, any>) => {
          return await input.execute(dummyTx);
        },
      );

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        ConcurrencyConflictError,
      );

      expect(req[TRADING_TX_REQUEST_KEY]).toBeUndefined(); // Cleaned up despite error!
    });
  });

  // ==========================================================================
  // Dimension 6: Actor & Object ID Security Boundaries
  // ==========================================================================
  describe('Dimension 6: Actor & Object ID Security Boundaries', () => {
    const MUTATION_META: TradingMutationOptions = {
      action: 'cancel',
      objectType: 'QuoteRequest',
      expectedVersionField: 'expected_request_version',
    };

    beforeEach(() => {
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(MUTATION_META);
    });

    it('rejects unauthenticated request with TradingPermissionDeniedError (HTTP 403)', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1 },
        actor: null,
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        TradingPermissionDeniedError,
      );

      try {
        await interceptor.intercept(context, callHandler);
      } catch (err: any) {
        expect(err.code).toBe('PERMISSION_DENIED');
        expect(statusByCode[err.code as keyof typeof statusByCode]).toBe(403);
      }

      expect(handleSpy).not.toHaveBeenCalled();
    });

    it('rejects empty or blank accountId with TradingPermissionDeniedError', async () => {
      for (const blankActor of ['', '   ']) {
        const { context } = createMockExecutionContext({
          headers: { 'x-idempotency-key': VALID_UUID_V4 },
          body: { expected_request_version: 1 },
          user: { accountId: blankActor },
        });
        const { callHandler, handleSpy } = createMockCallHandler();

        await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
          TradingPermissionDeniedError,
        );
        expect(handleSpy).not.toHaveBeenCalled();
      }
    });

    it('rejects missing object ID in params with InvalidTradingInputError (HTTP 400)', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1 },
        actor: VALID_ACTOR,
        params: {}, // missing 'id'
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        InvalidTradingInputError,
      );
      expect(handleSpy).not.toHaveBeenCalled();
    });

    it('extracts object ID from body when objectIdBodyField is specified', async () => {
      const bodyMeta: TradingMutationOptions = {
        action: 'allocate',
        objectType: 'Allocation',
        objectIdBodyField: 'target_allocation_id',
        expectedVersionField: 'expected_allocation_version',
      };
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(bodyMeta);

      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { target_allocation_id: '5005', expected_allocation_version: 2 },
        actor: VALID_ACTOR,
      });
      const { callHandler } = createMockCallHandler({ id: '5005' });

      executeWithIdempotencySpy.mockResolvedValueOnce({
        data: { id: '5005' },
        operation: {
          id: 'rec-1',
          replayed: false,
          committed_at: new Date().toISOString(),
          current_state: {},
        },
      });

      await interceptor.intercept(context, callHandler);

      expect(executeWithIdempotencySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          objectId: '5005',
          objectType: 'Allocation',
        }),
      );
    });

    it('extracts object ID using custom objectIdSource function', async () => {
      const customMeta: TradingMutationOptions = {
        action: 'custom_action',
        objectType: 'QuoteRequest',
        objectIdSource: (req) => (req as any).headers['x-custom-object-id'] as string,
        expectedVersionField: 'expected_request_version',
      };
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(customMeta);

      const { context } = createMockExecutionContext({
        headers: {
          'x-idempotency-key': VALID_UUID_V4,
          'x-custom-object-id': '888',
        },
        body: { expected_request_version: 1 },
        actor: VALID_ACTOR,
      });
      const { callHandler } = createMockCallHandler({ id: '888' });

      executeWithIdempotencySpy.mockResolvedValueOnce({
        data: { id: '888' },
        operation: {
          id: 'rec-1',
          replayed: false,
          committed_at: new Date().toISOString(),
          current_state: {},
        },
      });

      await interceptor.intercept(context, callHandler);

      expect(executeWithIdempotencySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          objectId: '888',
        }),
      );
    });
  });
});
