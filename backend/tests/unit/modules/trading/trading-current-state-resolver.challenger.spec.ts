import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TransactionContext } from '../../../../src/common/application/ports/transaction-runner';
import type {
  IQuoteRequestRepository,
  IAllocationRepository,
  IQuoteRepository,
  ISplitProposalRepository,
  IRequestRecipientRepository,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { TradingCurrentStateResolver } from '../../../../src/modules/trading/adapters/http/interceptors/trading-current-state.resolver';
import {
  InvalidTradingInputError,
  ConcurrencyConflictError,
  IdempotencyConflictError,
} from '../../../../src/modules/trading/domain';
import { statusByCode } from '../../../../src/common/http/filters/api-problem';
import { problems, ProblemDetailsFilter } from '../../../../src/common/http/filters/problem-details.filter';
import type { ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';

describe('Adversarial Challenger: TradingCurrentStateResolver & RFC 9457 Boundary Stress', () => {
  let quoteRequestRepo: { findById: ReturnType<typeof vi.fn> };
  let allocationRepo: { findById: ReturnType<typeof vi.fn> };
  let quoteRepo: { findById: ReturnType<typeof vi.fn> };
  let proposalRepo: { findById: ReturnType<typeof vi.fn> };
  let recipientRepo: { findById: ReturnType<typeof vi.fn> };
  let dummyTx: TransactionContext;
  let resolver: TradingCurrentStateResolver;

  beforeEach(() => {
    quoteRequestRepo = { findById: vi.fn() };
    allocationRepo = { findById: vi.fn() };
    quoteRepo = { findById: vi.fn() };
    proposalRepo = { findById: vi.fn() };
    recipientRepo = { findById: vi.fn() };
    dummyTx = { txId: 'tx-challenger-001' } as unknown as TransactionContext;

    resolver = new TradingCurrentStateResolver(
      quoteRequestRepo as unknown as IQuoteRequestRepository,
      allocationRepo as unknown as IAllocationRepository,
      quoteRepo as unknown as IQuoteRepository,
      proposalRepo as unknown as ISplitProposalRepository,
      recipientRepo as unknown as IRequestRecipientRepository,
    );
  });

  // ==========================================================================
  // Suite 1: Unknown Entities & Edge Case Object Types
  // ==========================================================================
  describe('Unknown Entities & Edge Case Object Types', () => {
    it('accurately resolves completely unknown object types to fallback DTO without throwing', async () => {
      const unknownTypes = [
        'UnknownEntity',
        'Invoice',
        'Payment',
        'Warehouse',
        'Shipment',
        'custom_audit_log',
        'XYZ-999-ANOMALY',
        '   ',
        '',
      ];

      for (const unknownType of unknownTypes) {
        const result = await resolver.resolveCurrentState(unknownType, 'entity-999', dummyTx);
        expect(result).toBeDefined();
        expect(result.request).toBeDefined();
        expect(result.request.id).toBe('entity-999');
        expect(result.request.status).toBe('draft_request');
        expect(result.request.version).toBe(1);
        expect(result.request.cancelled_at).toBeNull();
        expect(result.recipient).toBeUndefined();
        expect(result.quote).toBeUndefined();
        expect(result.proposal).toBeUndefined();
        expect(result.allocation).toBeUndefined();
      }
    });

    it('accurately handles unknown entity IDs across all 5 registered entity branches', async () => {
      quoteRequestRepo.findById.mockResolvedValue(null);
      allocationRepo.findById.mockResolvedValue(null);
      quoteRepo.findById.mockResolvedValue(null);
      proposalRepo.findById.mockResolvedValue(null);
      recipientRepo.findById.mockResolvedValue(null);

      // 1. QuoteRequest unknown ID
      const r1 = await resolver.resolveCurrentState('QuoteRequest', 'missing-qr-1', dummyTx);
      expect(r1.request.id).toBe('missing-qr-1');
      expect(r1.request.status).toBe('draft_request');
      expect(r1.request.version).toBe(0);

      // 2. Allocation unknown ID
      const r2 = await resolver.resolveCurrentState('Allocation', 'missing-alloc-1', dummyTx);
      expect(r2.allocation).toEqual({ id: 'missing-alloc-1', status: 'not_started', version: 0 });
      expect(r2.request).toEqual({ id: '0', status: 'buyer_accepted', version: 0, cancelled_at: null });

      // 3. Quote unknown ID
      const r3 = await resolver.resolveCurrentState('Quote', 'missing-quote-1', dummyTx);
      expect(r3.quote).toEqual({ id: 'missing-quote-1', status: 'active', version: 0 });
      expect(r3.request).toEqual({ id: '0', status: 'artisans_bidding', version: 0, cancelled_at: null });

      // 4. SplitProposal unknown ID
      const r4 = await resolver.resolveCurrentState('SplitProposal', 'missing-prop-1', dummyTx);
      expect(r4.proposal).toEqual({ id: 'missing-prop-1', status: 'proposed', version: 0 });
      expect(r4.request).toEqual({ id: '0', status: 'artisans_bidding', version: 0, cancelled_at: null });

      // 5. RequestRecipient unknown ID
      const r5 = await resolver.resolveCurrentState('RequestRecipient', 'missing-rec-1', dummyTx);
      expect(r5.request.id).toBe('missing-rec-1');
      expect(r5.request.status).toBe('draft_request');
      expect(r5.recipient).toBeUndefined();
    });
  });

  // ==========================================================================
  // Suite 2: Null / Undefined Values & Orphaned Entity Relationships
  // ==========================================================================
  describe('Null / Undefined Values & Orphaned Relationships', () => {
    it('handles null and undefined parent relationships gracefully without crashing', async () => {
      // Allocation with missing parent request
      allocationRepo.findById.mockResolvedValueOnce({
        id: 'alloc-orphan',
        request_id: 'req-nonexistent-parent',
        status: 'in_progress',
        version: 2,
      });
      quoteRequestRepo.findById.mockResolvedValueOnce(null);

      const allocResult = await resolver.resolveCurrentState('Allocation', 'alloc-orphan', dummyTx);
      expect(allocResult.allocation).toEqual({ id: 'alloc-orphan', status: 'in_progress', version: 2 });
      expect(allocResult.request.id).toBe('req-nonexistent-parent');
      expect(allocResult.request.status).toBe('buyer_accepted');

      // RequestRecipient with undefined parentRequestId
      recipientRepo.findById.mockResolvedValueOnce({
        id: 'rec-orphan',
        workshop_id: 'ws-1',
        response_status: 'declined',
        version: 3,
      });
      quoteRequestRepo.findById.mockResolvedValueOnce(null);

      const recResult = await resolver.resolveCurrentState('RequestRecipient', 'rec-orphan', dummyTx);
      expect(recResult.recipient).toEqual({ id: 'rec-orphan', status: 'declined', version: 3 });
      expect(recResult.request.id).toBe('rec-orphan'); // falls back safely to objectId
      expect(recResult.request.status).toBe('sent_to_artisans');
    });

    it('handles various date representations and nulls for cancelled_at', async () => {
      // Date object
      quoteRequestRepo.findById.mockResolvedValueOnce({
        id: 'qr-date',
        status: 'cancelled',
        version: 2,
        cancelled_at: new Date('2026-11-11T12:00:00.000Z'),
      });
      const resDate = await resolver.resolveCurrentState('QuoteRequest', 'qr-date', dummyTx);
      expect(resDate.request.cancelled_at).toBe('2026-11-11T12:00:00.000Z');

      // ISO String
      quoteRequestRepo.findById.mockResolvedValueOnce({
        id: 'qr-str',
        status: 'cancelled',
        version: 2,
        cancelled_at: '2026-11-11T12:00:00.000Z',
      });
      const resStr = await resolver.resolveCurrentState('QuoteRequest', 'qr-str', dummyTx);
      expect(resStr.request.cancelled_at).toBe('2026-11-11T12:00:00.000Z');

      // null
      quoteRequestRepo.findById.mockResolvedValueOnce({
        id: 'qr-null',
        status: 'published',
        version: 1,
        cancelled_at: null,
      });
      const resNull = await resolver.resolveCurrentState('QuoteRequest', 'qr-null', dummyTx);
      expect(resNull.request.cancelled_at).toBeNull();

      // undefined
      quoteRequestRepo.findById.mockResolvedValueOnce({
        id: 'qr-undef',
        status: 'draft_request',
        version: 1,
        cancelled_at: undefined,
      });
      const resUndef = await resolver.resolveCurrentState('QuoteRequest', 'qr-undef', dummyTx);
      expect(resUndef.request.cancelled_at).toBeNull();
    });

    it('empirically records behavior when objectType is null or undefined', async () => {
      // Testing type boundary: objectType is passed as null or undefined (e.g. from untyped caller)
      await expect(
        resolver.resolveCurrentState(null as unknown as string, 'obj-1', dummyTx),
      ).rejects.toThrow(TypeError);

      await expect(
        resolver.resolveCurrentState(undefined as unknown as string, 'obj-1', dummyTx),
      ).rejects.toThrow(TypeError);
    });
  });

  // ==========================================================================
  // Suite 3: Concurrency Simulation on Resolver
  // ==========================================================================
  describe('High Concurrency Simulation on State Resolver', () => {
    it('executes 100 concurrent state resolutions without race conditions or state pollution', async () => {
      quoteRequestRepo.findById.mockImplementation(async (id: string) => ({
        id,
        status: 'published',
        version: 5,
        cancelled_at: null,
      }));

      recipientRepo.findById.mockImplementation(async (id: string) => ({
        id,
        request_id: `parent-for-${id}`,
        response_status: 'pending',
        version: 2,
      }));

      const concurrentOps = Array.from({ length: 100 }, (_, i) => {
        const isRecipient = i % 2 === 0;
        const objectType = isRecipient ? 'RequestRecipient' : 'QuoteRequest';
        const objectId = `id-${i}`;
        return resolver.resolveCurrentState(objectType, objectId, dummyTx);
      });

      const results = await Promise.all(concurrentOps);
      expect(results).toHaveLength(100);

      results.forEach((res, i) => {
        if (i % 2 === 0) {
          expect(res.recipient).toBeDefined();
          expect(res.recipient?.id).toBe(`id-${i}`);
          expect(res.request.id).toBe(`parent-for-id-${i}`);
        } else {
          expect(res.request.id).toBe(`id-${i}`);
          expect(res.request.version).toBe(5);
        }
      });
    });
  });

  // ==========================================================================
  // Suite 4: RFC 9457 Problem Details Validation for All 3 Error Codes
  // ==========================================================================
  describe('RFC 9457 Problem Details Conformance Audit', () => {
    function createMockHostResponse() {
      let capturedStatusCode = 200;
      let capturedHeaders: Record<string, string> = {};
      let capturedBody: any = null;

      const mockRes: Partial<Response> = {
        status: vi.fn().mockImplementation((code: number) => {
          capturedStatusCode = code;
          return mockRes;
        }),
        type: vi.fn().mockImplementation((contentType: string) => {
          capturedHeaders['content-type'] = contentType;
          return mockRes;
        }),
        setHeader: vi.fn().mockImplementation((k: string, v: string) => {
          capturedHeaders[k.toLowerCase()] = v;
          return mockRes;
        }),
        removeHeader: vi.fn(),
        json: vi.fn().mockImplementation((body: any) => {
          capturedBody = body;
          return mockRes;
        }),
        headersSent: false,
      };

      const mockHost: ArgumentsHost = {
        switchToHttp: () => ({
          getResponse: () => mockRes as Response,
          getRequest: () => ({}) as any,
          getNext: () => ({}) as any,
        }),
        getArgs: () => [],
        getArgByIndex: () => ({}) as any,
        switchToRpc: () => ({}) as any,
        switchToWs: () => ({}) as any,
        getType: () => 'http',
      };

      return {
        mockHost,
        getStatus: () => capturedStatusCode,
        getHeaders: () => capturedHeaders,
        getBody: () => capturedBody,
      };
    }

    it('Code 1: INVALID_INPUT maps strictly to HTTP 400 and satisfies RFC 9457 schema', () => {
      const filter = new ProblemDetailsFilter();
      const { mockHost, getStatus, getHeaders, getBody } = createMockHostResponse();

      const error = new InvalidTradingInputError('Header X-Idempotency-Key must be a valid UUID v4.');
      expect(statusByCode[error.code]).toBe(400);

      filter.catch(error, mockHost);

      expect(getStatus()).toBe(400);
      expect(getHeaders()['content-type']).toBe('application/problem+json');
      expect(getHeaders()['x-request-id']).toBeDefined();

      const body = getBody();
      expect(body).toMatchObject({
        type: 'urn:vcraft:problem:INVALID_INPUT',
        title: problems[400][1],
        status: 400,
        detail: problems[400][2],
        code: 'INVALID_INPUT',
      });
      expect(typeof body.tracking_id).toBe('string');
      expect(body.tracking_id.length).toBeGreaterThan(0);
    });

    it('Code 2: CONCURRENCY_CONFLICT maps strictly to HTTP 409 and satisfies RFC 9457 schema', () => {
      const filter = new ProblemDetailsFilter();
      const { mockHost, getStatus, getHeaders, getBody } = createMockHostResponse();

      const error = new ConcurrencyConflictError('Expected version 1 does not match current version 2.');
      expect(statusByCode[error.code]).toBe(409);

      filter.catch(error, mockHost);

      expect(getStatus()).toBe(409);
      expect(getHeaders()['content-type']).toBe('application/problem+json');
      expect(getHeaders()['x-request-id']).toBeDefined();

      const body = getBody();
      expect(body).toMatchObject({
        type: 'urn:vcraft:problem:CONCURRENCY_CONFLICT',
        title: problems[409][1],
        status: 409,
        detail: problems[409][2],
        code: 'CONCURRENCY_CONFLICT',
      });
      expect(typeof body.tracking_id).toBe('string');
      expect(body.tracking_id.length).toBeGreaterThan(0);
    });

    it('Code 3: IDEMPOTENCY_CONFLICT maps strictly to HTTP 409 and satisfies RFC 9457 schema', () => {
      const filter = new ProblemDetailsFilter();
      const { mockHost, getStatus, getHeaders, getBody } = createMockHostResponse();

      const error = new IdempotencyConflictError('Idempotency key reused with mismatched payload fingerprint.');
      expect(statusByCode[error.code]).toBe(409);

      filter.catch(error, mockHost);

      expect(getStatus()).toBe(409);
      expect(getHeaders()['content-type']).toBe('application/problem+json');
      expect(getHeaders()['x-request-id']).toBeDefined();

      const body = getBody();
      expect(body).toMatchObject({
        type: 'urn:vcraft:problem:IDEMPOTENCY_CONFLICT',
        title: problems[409][1],
        status: 409,
        detail: problems[409][2],
        code: 'IDEMPOTENCY_CONFLICT',
      });
      expect(typeof body.tracking_id).toBe('string');
      expect(body.tracking_id.length).toBeGreaterThan(0);
    });
  });
});
