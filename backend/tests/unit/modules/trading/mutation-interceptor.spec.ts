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
  type TradingMutationOptions,
} from '../../../../src/modules/trading/adapters/http/interceptors/trading-mutation.interceptor';
import { TradingMutation } from '../../../../src/modules/trading/adapters/http/decorators/trading-mutation.decorator';

// ============================================================================
// Test Harness & Mock Factories
// ============================================================================

interface MockExecutionContextOptions {
  headers?: Record<string, string | undefined>;
  body?: unknown;
  params?: Record<string, string | undefined>;
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
    body: options.body ?? {},
    params: { ...options.params },
    query: { ...options.query },
    user: options.user,
    get(name: string) {
      return this.headers[name.toLowerCase()];
    },
  };

  if (options.actor) {
    authenticatedActors.set(req, options.actor);
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
    return of(resultOrFactory ?? ({ success: true } as any));
  });

  return {
    callHandler: { handle: handleSpy },
    handleSpy,
  };
}

interface MockIdempotencyServiceContext {
  service: TradingIdempotencyService;
  executeWithIdempotencySpy: ReturnType<typeof vi.fn>;
}

function createMockIdempotencyService(): MockIdempotencyServiceContext {
  const executeWithIdempotencySpy = vi.fn();
  const service = {
    executeWithIdempotency: executeWithIdempotencySpy,
    cleanupExpired: vi.fn(),
  } as unknown as TradingIdempotencyService;

  return { service, executeWithIdempotencySpy };
}

// ============================================================================
// Unit Test Suite
// ============================================================================

describe('TradingMutationInterceptor (Unit Tests)', () => {
  const VALID_UUID_V4 = 'c7a8b9e0-1234-4567-89ab-cdef01234567';
  const VALID_UUID_V4_UPPER = 'C7A8B9E0-1234-4567-89AB-CDEF01234567';
  const SAMPLE_ACTOR: AuthenticatedActor = {
    accountId: '100',
    role: 'client',
    workshopId: null,
    authVersion: 1,
    sessionId: 'sess-test-123',
    sessionLevel: 'normal',
  };

  let mockReflector: Reflector;
  let mockIdempotencyCtx: MockIdempotencyServiceContext;
  let interceptor: TradingMutationInterceptor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReflector = new Reflector();
    mockIdempotencyCtx = createMockIdempotencyService();
    interceptor = new TradingMutationInterceptor(
      mockReflector,
      mockIdempotencyCtx.service,
    );
  });

  // ==========================================================================
  // Suite 1: Non-Mutation Endpoints (Pass-through)
  // ==========================================================================
  describe('Suite 1: Non-Mutation Endpoint Pass-through', () => {
    it('passes through immediately when route has no @TradingMutation metadata', async () => {
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(undefined);

      const expectedPayload = { message: 'read-only quote requests list' };
      const { context } = createMockExecutionContext({
        headers: {}, // No X-Idempotency-Key
        body: undefined, // No expected version
      });
      const { callHandler, handleSpy } = createMockCallHandler(expectedPayload);

      const observable = await interceptor.intercept(context, callHandler);
      const emitted = await firstValueFrom(observable);

      expect(handleSpy).toHaveBeenCalledTimes(1);
      expect(emitted).toEqual(expectedPayload);
      expect(mockIdempotencyCtx.executeWithIdempotencySpy).not.toHaveBeenCalled();
    });

    it('does not inspect headers or body for non-mutation endpoints', async () => {
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(null);

      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': 'malformed-not-a-uuid' },
        body: { expected_request_version: 'invalid-string' },
      });
      const { callHandler, handleSpy } = createMockCallHandler({ ok: true });

      const observable = await interceptor.intercept(context, callHandler);
      const emitted = await firstValueFrom(observable);

      expect(handleSpy).toHaveBeenCalledTimes(1);
      expect(emitted).toEqual({ ok: true });
      expect(mockIdempotencyCtx.executeWithIdempotencySpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Suite 2: Missing X-Idempotency-Key Header on Mutation Endpoints
  // ==========================================================================
  describe('Suite 2: Missing X-Idempotency-Key Header', () => {
    const MUTATION_META: TradingMutationOptions = {
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      expectedVersionField: 'expected_request_version',
    };

    beforeEach(() => {
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(MUTATION_META);
    });

    it('throws InvalidTradingInputError (HTTP 400 INVALID_INPUT) when header is absent', async () => {
      const { context } = createMockExecutionContext({
        headers: {},
        body: { expected_request_version: 1 },
        actor: SAMPLE_ACTOR,
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        InvalidTradingInputError,
      );

      try {
        await interceptor.intercept(context, callHandler);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_INPUT');
        expect(statusByCode[err.code as keyof typeof statusByCode]).toBe(400);
        expect(err.invariant).toBe(TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY);
      }

      expect(handleSpy).not.toHaveBeenCalled();
      expect(mockIdempotencyCtx.executeWithIdempotencySpy).not.toHaveBeenCalled();
    });

    it('throws InvalidTradingInputError when header is an empty string', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': '' },
        body: { expected_request_version: 1 },
        actor: SAMPLE_ACTOR,
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        InvalidTradingInputError,
      );
      expect(handleSpy).not.toHaveBeenCalled();
    });

    it('throws InvalidTradingInputError when header consists only of whitespace', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': '   ' },
        body: { expected_request_version: 1 },
        actor: SAMPLE_ACTOR,
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        InvalidTradingInputError,
      );
      expect(handleSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Suite 3: Invalid UUID v4 Formatting on X-Idempotency-Key
  // ==========================================================================
  describe('Suite 3: Invalid UUID v4 Header Validation', () => {
    const MUTATION_META: TradingMutationOptions = {
      action: 'cancel',
      objectType: 'QuoteRequest',
      expectedVersionField: 'expected_request_version',
    };

    beforeEach(() => {
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(MUTATION_META);
    });

    it.each([
      ['arbitrary non-uuid string', 'not-a-uuid'],
      ['short numeric string', '12345'],
      ['nil UUID (all zeros)', '00000000-0000-0000-0000-000000000000'],
      ['UUID v1 (timestamp-based)', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'],
      ['UUID v3 (MD5-based)', '6ba7b810-9dad-31d1-80b4-00c04fd430c8'],
      ['UUID v5 (SHA-1-based)', '6ba7b810-9dad-51d1-80b4-00c04fd430c8'],
      ['UUID v4 with invalid variant bits (variant 0)', 'c7a8b9e0-1234-4567-09ab-cdef01234567'],
      ['UUID v4 with invalid variant bits (variant c)', 'c7a8b9e0-1234-4567-c9ab-cdef01234567'],
      ['UUID with invalid hex character g', 'c7a8b9e0-1234-4567-89ab-cdef0123456g'],
      ['UUID exceeding 36 characters', 'c7a8b9e0-1234-4567-89ab-cdef012345678'],
      ['UUID under 36 characters', 'c7a8b9e0-1234-4567-89ab-cdef0123456'],
    ])('rejects %s (%s) with InvalidTradingInputError (HTTP 400)', async (_desc, invalidKey) => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': invalidKey },
        body: { expected_request_version: 1 },
        actor: SAMPLE_ACTOR,
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        InvalidTradingInputError,
      );
      expect(handleSpy).not.toHaveBeenCalled();
      expect(mockIdempotencyCtx.executeWithIdempotencySpy).not.toHaveBeenCalled();
    });

    it('accepts and normalizes valid uppercase UUID v4 to canonical lowercase', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4_UPPER },
        body: { expected_request_version: 1 },
        actor: SAMPLE_ACTOR,
        params: { id: '1001' },
      });
      const { callHandler } = createMockCallHandler({ id: '1001', status: 'cancelled' });

      mockIdempotencyCtx.executeWithIdempotencySpy.mockResolvedValueOnce({
        data: { id: '1001', status: 'cancelled' },
        result: { id: '1001', status: 'cancelled' },
        operation: {
          id: 'rec-1',
          replayed: false,
          committed_at: new Date().toISOString(),
          current_state: { id: '1001', status: 'cancelled' },
        },
        replayed: false,
        currentState: { id: '1001', status: 'cancelled' },
        recordId: 'rec-1',
      });

      await interceptor.intercept(context, callHandler);

      expect(mockIdempotencyCtx.executeWithIdempotencySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: VALID_UUID_V4.toLowerCase(),
        }),
      );
    });

    it('trims leading/trailing whitespace from a valid UUID v4 header', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': `   ${VALID_UUID_V4}   ` },
        body: { expected_request_version: 1 },
        actor: SAMPLE_ACTOR,
        params: { id: '1001' },
      });
      const { callHandler } = createMockCallHandler();

      mockIdempotencyCtx.executeWithIdempotencySpy.mockResolvedValueOnce({
        data: { id: '1001' },
        operation: {
          id: 'rec-1',
          replayed: false,
          committed_at: new Date().toISOString(),
          current_state: {},
        },
      });

      await interceptor.intercept(context, callHandler);

      expect(mockIdempotencyCtx.executeWithIdempotencySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: VALID_UUID_V4.toLowerCase(),
        }),
      );
    });
  });

  // ==========================================================================
  // Suite 4: Missing or Invalid expected_*_version Fields in Body
  // ==========================================================================
  describe('Suite 4: Request Body expected_*_version Validation', () => {
    const MUTATION_META: TradingMutationOptions = {
      action: 'close_bidding',
      objectType: 'QuoteRequest',
      expectedVersionField: 'expected_request_version',
    };

    beforeEach(() => {
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(MUTATION_META);
    });

    it('throws InvalidTradingInputError when request body is empty or undefined', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: undefined,
        actor: SAMPLE_ACTOR,
      });
      const { callHandler } = createMockCallHandler();

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        InvalidTradingInputError,
      );
    });

    it('throws InvalidTradingInputError when expected version field is omitted from body', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { note: 'closing bidding early' }, // missing expected_request_version
        actor: SAMPLE_ACTOR,
      });
      const { callHandler } = createMockCallHandler();

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        InvalidTradingInputError,
      );
    });

    it.each([
      ['null (when not allowed)', null],
      ['string format', '1'],
      ['boolean true', true],
      ['floating point number', 1.5],
      ['zero (0)', 0],
      ['negative integer (-1)', -1],
      ['NaN', NaN],
      ['empty object', {}],
    ])('rejects expected_request_version = %s with InvalidTradingInputError (HTTP 400)', async (_desc, val) => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: val },
        actor: SAMPLE_ACTOR,
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        InvalidTradingInputError,
      );
      expect(handleSpy).not.toHaveBeenCalled();
    });

    it('validates multiple required version fields (e.g. accept_quote)', async () => {
      const multiVersionMeta: TradingMutationOptions = {
        action: 'accept_quote',
        objectType: 'QuoteRequest',
        expectedVersionField: ['expected_request_version', 'expected_quote_version'],
      };
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(multiVersionMeta);

      // Missing expected_quote_version
      const { context: context1 } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1 },
        actor: SAMPLE_ACTOR,
      });
      const { callHandler: handler1 } = createMockCallHandler();
      await expect(interceptor.intercept(context1, handler1)).rejects.toThrow(
        InvalidTradingInputError,
      );

      // Both present and valid positive integers
      const { context: context2 } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1, expected_quote_version: 2 },
        actor: SAMPLE_ACTOR,
        params: { id: '1001' },
      });
      const { callHandler: handler2 } = createMockCallHandler({ success: true });
      mockIdempotencyCtx.executeWithIdempotencySpy.mockResolvedValueOnce({
        data: { success: true },
        operation: {
          id: 'rec-1',
          replayed: false,
          committed_at: new Date().toISOString(),
          current_state: {},
        },
      });

      await expect(interceptor.intercept(context2, handler2)).resolves.toBeDefined();
    });

    it('permits null for expected_quote_version when allowNullVersion is true (initial submission)', async () => {
      const quoteSubmitMeta: TradingMutationOptions = {
        action: 'submit_quote',
        objectType: 'Quote',
        expectedVersionField: 'expected_quote_version',
        allowNullVersion: true,
      };
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(quoteSubmitMeta);

      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_quote_version: null, price: 500000 },
        actor: SAMPLE_ACTOR,
        params: { id: '2001' },
      });
      const { callHandler } = createMockCallHandler({ id: '2001' });
      mockIdempotencyCtx.executeWithIdempotencySpy.mockResolvedValueOnce({
        data: { id: '2001' },
        operation: {
          id: 'rec-1',
          replayed: false,
          committed_at: new Date().toISOString(),
          current_state: {},
        },
      });

      await expect(interceptor.intercept(context, callHandler)).resolves.toBeDefined();
    });
  });

  // ==========================================================================
  // Suite 5: Actor & Object ID Resolution
  // ==========================================================================
  describe('Suite 5: Actor & Object ID Resolution', () => {
    const MUTATION_META: TradingMutationOptions = {
      action: 'cancel',
      objectType: 'QuoteRequest',
      expectedVersionField: 'expected_request_version',
    };

    beforeEach(() => {
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(MUTATION_META);
    });

    it('throws TradingPermissionDeniedError when actor is unauthenticated', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1 },
        actor: null,
      });
      const { callHandler } = createMockCallHandler();

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        TradingPermissionDeniedError,
      );
    });

    it('extracts actor accountId from authenticatedActors WeakMap', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1 },
        actor: { ...SAMPLE_ACTOR, accountId: '999' },
        params: { id: '555' },
      });
      const { callHandler } = createMockCallHandler({ id: '555' });
      mockIdempotencyCtx.executeWithIdempotencySpy.mockResolvedValueOnce({
        data: { id: '555' },
        operation: {
          id: 'rec-1',
          replayed: false,
          committed_at: new Date().toISOString(),
          current_state: {},
        },
      });

      await interceptor.intercept(context, callHandler);

      expect(mockIdempotencyCtx.executeWithIdempotencySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: '999',
          objectId: '555',
        }),
      );
    });

    it('extracts actor accountId from req.user as fallback', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1 },
        user: { accountId: '888' },
        params: { id: '555' },
      });
      const { callHandler } = createMockCallHandler({ id: '555' });
      mockIdempotencyCtx.executeWithIdempotencySpy.mockResolvedValueOnce({
        data: { id: '555' },
        operation: {
          id: 'rec-1',
          replayed: false,
          committed_at: new Date().toISOString(),
          current_state: {},
        },
      });

      await interceptor.intercept(context, callHandler);

      expect(mockIdempotencyCtx.executeWithIdempotencySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: '888',
          objectId: '555',
        }),
      );
    });

    it('extracts object ID from body when objectIdSource is set to body', async () => {
      const bodySourceMeta: TradingMutationOptions = {
        action: 'batch_handover',
        objectType: 'Allocation',
        objectIdSource: 'body',
        objectIdParam: 'allocation_id',
        expectedVersionField: 'expected_allocation_version',
      };
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(bodySourceMeta);

      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { allocation_id: '777', expected_allocation_version: 3 },
        actor: SAMPLE_ACTOR,
      });
      const { callHandler } = createMockCallHandler({ id: '777' });
      mockIdempotencyCtx.executeWithIdempotencySpy.mockResolvedValueOnce({
        data: { id: '777' },
        operation: {
          id: 'rec-1',
          replayed: false,
          committed_at: new Date().toISOString(),
          current_state: {},
        },
      });

      await interceptor.intercept(context, callHandler);

      expect(mockIdempotencyCtx.executeWithIdempotencySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          objectId: '777',
        }),
      );
    });
  });

  // ==========================================================================
  // Suite 6: Valid Request & Initial Execution Delegation
  // ==========================================================================
  describe('Suite 6: Initial Request Execution Delegation', () => {
    const MUTATION_META: TradingMutationOptions = {
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      expectedVersionField: 'expected_request_version',
    };

    beforeEach(() => {
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(MUTATION_META);
    });

    it('delegates to TradingIdempotencyService with full scope parameters and wraps in HttpResult', async () => {
      const committedAt = '2026-11-11T10:30:00.000Z';
      const controllerResult = {
        request_id: '1001',
        request_status: 'buyer_accepted',
        request_version: 2,
        allocations: [{ id: 'alloc-1', quantity: 100 }],
      };
      const currentState = {
        id: '1001',
        status: 'buyer_accepted',
        version: 2,
        request: {
          id: '1001',
          status: 'buyer_accepted' as const,
          version: 2,
          cancelled_at: null,
        },
      };

      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1, quote_id: '2001' },
        actor: SAMPLE_ACTOR,
        params: { id: '1001' },
      });
      const { callHandler, handleSpy } = createMockCallHandler(controllerResult);

      mockIdempotencyCtx.executeWithIdempotencySpy.mockImplementation(
        async (input: ExecuteWithIdempotencyInput<any, any>) => {
          // Simulate service calling input.execute()
          const tx = { dummy: true } as any;
          const { result, currentState: freshState } = await input.execute(tx);
          return {
            data: result,
            result,
            operation: {
              id: 'record-101',
              replayed: false,
              committed_at: committedAt,
              current_state: freshState,
            },
            replayed: false,
            currentState: freshState,
            recordId: 'record-101',
          };
        },
      );

      const observable = await interceptor.intercept(context, callHandler);
      const emitted: any = await firstValueFrom(observable);

      expect(mockIdempotencyCtx.executeWithIdempotencySpy).toHaveBeenCalledTimes(1);
      expect(mockIdempotencyCtx.executeWithIdempotencySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: '100',
          action: 'accept_quote',
          objectType: 'QuoteRequest',
          objectId: '1001',
          idempotencyKey: VALID_UUID_V4,
          payload: { expected_request_version: 1, quote_id: '2001' },
        }),
      );

      expect(handleSpy).toHaveBeenCalledTimes(1);
      expect(emitted).toBeInstanceOf(HttpResult);
      expect(emitted.data).toEqual(controllerResult);
      expect(emitted.metadata.operation).toEqual({
        id: 'record-101',
        replayed: false,
        committed_at: committedAt,
        current_state: expect.objectContaining({
          request: expect.objectContaining({
            id: '1001',
            status: 'buyer_accepted',
            version: 2,
          }),
        }),
      });
    });

    it('handles HTTP 204 No Content for delete operations by setting data to undefined', async () => {
      const deleteMeta: TradingMutationOptions = {
        action: 'delete_draft',
        objectType: 'QuoteRequest',
        expectedVersionField: 'expected_request_version',
      };
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(deleteMeta);

      const { context, res } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1 },
        actor: SAMPLE_ACTOR,
        params: { id: '1001' },
        statusCode: 204,
      });
      const { callHandler } = createMockCallHandler(undefined);

      mockIdempotencyCtx.executeWithIdempotencySpy.mockResolvedValueOnce({
        data: undefined,
        result: undefined,
        operation: {
          id: 'rec-del-1',
          replayed: false,
          committed_at: '2026-11-11T10:30:00.000Z',
          current_state: {
            request: { id: '1001', status: 'draft_request', version: 1, cancelled_at: null },
          },
        },
        replayed: false,
        recordId: 'rec-del-1',
      });

      const observable = await interceptor.intercept(context, callHandler);
      const emitted: any = await firstValueFrom(observable);

      expect(emitted).toBeInstanceOf(HttpResult);
      expect(emitted.data).toBeUndefined();
      expect(emitted.metadata.operation.id).toBe('rec-del-1');
    });
  });

  // ==========================================================================
  // Suite 7: Optimistic Concurrency Control (Stale Version Handling)
  // ==========================================================================
  describe('Suite 7: Concurrency Conflict Handling (Stale Version)', () => {
    const MUTATION_META: TradingMutationOptions = {
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      expectedVersionField: 'expected_request_version',
    };

    beforeEach(() => {
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(MUTATION_META);
    });

    it('catches and rethrows ConcurrencyConflictError (HTTP 409 CONCURRENCY_CONFLICT) when execution version is stale', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1 }, // client sent stale version 1 (DB is at 2)
        actor: SAMPLE_ACTOR,
        params: { id: '1001' },
      });

      const conflictError = new ConcurrencyConflictError(
        'QuoteRequest version mismatch: expected 1, current is 2.',
        {
          entity: 'QuoteRequest',
          field: 'expected_request_version',
          expectedVersion: 1,
          currentVersion: 2,
        },
      );

      const { callHandler } = createMockCallHandler(() => {
        throw conflictError;
      });

      mockIdempotencyCtx.executeWithIdempotencySpy.mockImplementation(
        async (input: ExecuteWithIdempotencyInput<any, any>) => {
          const tx = {} as any;
          return await input.execute(tx);
        },
      );

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        ConcurrencyConflictError,
      );

      try {
        await interceptor.intercept(context, callHandler);
      } catch (err: any) {
        expect(err.code).toBe('CONCURRENCY_CONFLICT');
        expect(statusByCode[err.code as keyof typeof statusByCode]).toBe(409);
        expect(err.invariant).toBe(TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY);
        expect(err.details.expectedVersion).toBe(1);
        expect(err.details.currentVersion).toBe(2);
      }
    });

    it('ensures entity is not modified or expired simply because client version was stale', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1 },
        actor: SAMPLE_ACTOR,
        params: { id: '1001' },
      });

      const { callHandler, handleSpy } = createMockCallHandler(() => {
        throw new ConcurrencyConflictError('Stale version rejected');
      });

      mockIdempotencyCtx.executeWithIdempotencySpy.mockImplementation(
        async (input: ExecuteWithIdempotencyInput<any, any>) => {
          return await input.execute({} as any);
        },
      );

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        ConcurrencyConflictError,
      );
      expect(handleSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Suite 8: Idempotent Replay Handling (Same Key, Same Payload)
  // ==========================================================================
  describe('Suite 8: Idempotent Replay (Same Key, Same Payload)', () => {
    const MUTATION_META: TradingMutationOptions = {
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      expectedVersionField: 'expected_request_version',
    };

    beforeEach(() => {
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(MUTATION_META);
    });

    it('returns cached snapshot with fresh current_state and replayed: true, bypassing handler execution', async () => {
      const cachedSnapshot = {
        request_id: '1001',
        request_status: 'buyer_accepted',
        allocations: [{ id: 'alloc-1', quantity: 100 }],
      };
      const freshCurrentState = {
        id: '1001',
        status: 'in_production', // entity has progressed further since original commit!
        version: 5,
        request: {
          id: '1001',
          status: 'in_production' as const,
          version: 5,
          cancelled_at: null,
        },
      };

      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1, quote_id: '2001' },
        actor: SAMPLE_ACTOR,
        params: { id: '1001' },
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      // Simulate TradingIdempotencyService finding an existing record and skipping execute()
      mockIdempotencyCtx.executeWithIdempotencySpy.mockResolvedValueOnce({
        data: cachedSnapshot,
        result: cachedSnapshot,
        operation: {
          id: 'rec-existing-99',
          replayed: true,
          committed_at: '2026-11-10T08:00:00.000Z',
          current_state: freshCurrentState,
        },
        replayed: true,
        currentState: freshCurrentState,
        recordId: 'rec-existing-99',
      });

      const observable = await interceptor.intercept(context, callHandler);
      const emitted: any = await firstValueFrom(observable);

      expect(handleSpy).not.toHaveBeenCalled(); // Crucial: business mutation was NOT re-executed!
      expect(emitted).toBeInstanceOf(HttpResult);
      expect(emitted.data).toEqual(cachedSnapshot);
      expect(emitted.metadata.operation).toEqual({
        id: 'rec-existing-99',
        replayed: true,
        committed_at: '2026-11-10T08:00:00.000Z',
        current_state: expect.objectContaining({
          id: '1001',
          status: 'in_production',
          version: 5,
        }),
      });
    });

    it('does not require the original expected version to still be current on replayed requests', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1 }, // Old version 1 sent in replay
        actor: SAMPLE_ACTOR,
        params: { id: '1001' },
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      mockIdempotencyCtx.executeWithIdempotencySpy.mockResolvedValueOnce({
        data: { id: '1001', success: true },
        operation: {
          id: 'rec-1',
          replayed: true,
          committed_at: '2026-11-10T00:00:00Z',
          current_state: {
            id: '1001',
            version: 10,
            request: { id: '1001', status: 'delivered', version: 10, cancelled_at: null },
          },
        },
        replayed: true,
      });

      const observable = await interceptor.intercept(context, callHandler);
      const emitted: any = await firstValueFrom(observable);

      expect(handleSpy).not.toHaveBeenCalled();
      expect(emitted.metadata.operation.replayed).toBe(true);
      expect(emitted.metadata.operation.current_state.version).toBe(10);
    });
  });

  // ==========================================================================
  // Suite 9: Idempotency Conflict Handling (Same Key, Changed Payload)
  // ==========================================================================
  describe('Suite 9: Idempotency Conflict (Same Key, Changed Payload)', () => {
    const MUTATION_META: TradingMutationOptions = {
      action: 'accept_quote',
      objectType: 'QuoteRequest',
      expectedVersionField: 'expected_request_version',
    };

    beforeEach(() => {
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(MUTATION_META);
    });

    it('throws IdempotencyConflictError (HTTP 409 IDEMPOTENCY_CONFLICT) when payload fingerprint differs', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 1, quote_id: '9999' }, // altered quote_id!
        actor: SAMPLE_ACTOR,
        params: { id: '1001' },
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      const conflictError = new IdempotencyConflictError(
        'Idempotency key has already been used with a different request fingerprint.',
        {
          key: VALID_UUID_V4,
          existingFingerprint: 'aaaabbbbcccc1111',
          incomingFingerprint: 'ddddaaeeffff2222',
        },
      );

      mockIdempotencyCtx.executeWithIdempotencySpy.mockRejectedValue(conflictError);

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

    it('detects conflict when expected version changes for the same idempotency key', async () => {
      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 2 }, // changed from 1 to 2
        actor: SAMPLE_ACTOR,
        params: { id: '1001' },
      });
      const { callHandler, handleSpy } = createMockCallHandler();

      mockIdempotencyCtx.executeWithIdempotencySpy.mockRejectedValue(
        new IdempotencyConflictError('Version change alters canonical fingerprint'),
      );

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        IdempotencyConflictError,
      );
      expect(handleSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Suite 10: Clean Architecture & Foundation Compatibility
  // ==========================================================================
  describe('Suite 10: Foundation & Envelope Compatibility', () => {
    it('seamlessly integrates with ResponseEnvelopeInterceptor to produce standard envelope', async () => {
      const MUTATION_META: TradingMutationOptions = {
        action: 'confirm_delivery',
        objectType: 'QuoteRequest',
        expectedVersionField: 'expected_request_version',
      };
      vi.spyOn(mockReflector, 'getAllAndOverride').mockReturnValue(MUTATION_META);

      const { context } = createMockExecutionContext({
        headers: { 'x-idempotency-key': VALID_UUID_V4 },
        body: { expected_request_version: 3 },
        actor: SAMPLE_ACTOR,
        params: { id: '1001' },
      });
      const { callHandler } = createMockCallHandler({ id: '1001', status: 'delivered' });

      mockIdempotencyCtx.executeWithIdempotencySpy.mockResolvedValueOnce({
        data: { id: '1001', status: 'delivered' },
        operation: {
          id: 'op-rec-7',
          replayed: false,
          committed_at: '2026-11-11T10:00:00.000Z',
          current_state: { id: '1001', status: 'delivered' },
        },
      });

      // 1. Intercept via TradingMutationInterceptor
      const mutationObservable = await interceptor.intercept(context, callHandler);

      // 2. Pass into ResponseEnvelopeInterceptor
      const envelopeInterceptor = new ResponseEnvelopeInterceptor();
      const envelopedObservable = envelopeInterceptor.intercept(context, {
        handle: () => mutationObservable,
      });

      const finalResponse = await firstValueFrom(envelopedObservable);

      expect(finalResponse).toEqual({
        success: true,
        data: { id: '1001', status: 'delivered' },
        operation: {
          id: 'op-rec-7',
          replayed: false,
          committed_at: '2026-11-11T10:00:00.000Z',
          current_state: { id: '1001', status: 'delivered' },
        },
      });
    });

    it('maps all interceptor domain errors to valid RFC 9457 HTTP status codes in statusByCode', () => {
      expect(statusByCode.INVALID_INPUT).toBe(400);
      expect(statusByCode.CONCURRENCY_CONFLICT).toBe(409);
      expect(statusByCode.IDEMPOTENCY_CONFLICT).toBe(409);
      expect(statusByCode.PERMISSION_DENIED).toBe(403);
    });
  });
});
