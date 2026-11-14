import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TransactionContext } from '../../../../src/common/application/ports/transaction-runner';
import type {
  IQuoteRequestRepository,
  IAllocationRepository,
  IQuoteRepository,
  IRequestRecipientRepository,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { TradingCurrentStateResolver } from '../../../../src/modules/trading/adapters/http/interceptors/trading-current-state.resolver';

describe('TradingCurrentStateResolver', () => {
  let quoteRequestRepo: { findById: ReturnType<typeof vi.fn> };
  let allocationRepo: { findById: ReturnType<typeof vi.fn> };
  let quoteRepo: { findById: ReturnType<typeof vi.fn> };
  let recipientRepo: { findById: ReturnType<typeof vi.fn> };
  let dummyTx: TransactionContext;
  let resolver: TradingCurrentStateResolver;

  beforeEach(() => {
    quoteRequestRepo = { findById: vi.fn() };
    allocationRepo = { findById: vi.fn() };
    quoteRepo = { findById: vi.fn() };
    recipientRepo = { findById: vi.fn() };
    dummyTx = { txId: 'tx-test-999' } as unknown as TransactionContext;

    resolver = new TradingCurrentStateResolver(
      quoteRequestRepo as unknown as IQuoteRequestRepository,
      allocationRepo as unknown as IAllocationRepository,
      quoteRepo as unknown as IQuoteRepository,
      recipientRepo as unknown as IRequestRecipientRepository,
    );
  });

  // ==========================================================================
  // Branch 1: QuoteRequest
  // ==========================================================================
  describe('QuoteRequest branch', () => {
    it('resolves existing QuoteRequest with formatted ISO cancelled_at', async () => {
      const cancelDate = new Date('2026-11-11T10:00:00.000Z');
      quoteRequestRepo.findById.mockResolvedValueOnce({
        id: 'req-101',
        status: 'cancelled',
        version: 3,
        cancelled_at: cancelDate,
      });

      const state = await resolver.resolveCurrentState('QuoteRequest', 'req-101', dummyTx);

      expect(quoteRequestRepo.findById).toHaveBeenCalledWith('req-101', dummyTx);
      expect(state).toEqual({
        request: {
          id: 'req-101',
          status: 'cancelled',
          version: 3,
          cancelled_at: cancelDate.toISOString(),
        },
      });
    });

    it('resolves existing QuoteRequest with null cancelled_at and string date', async () => {
      quoteRequestRepo.findById.mockResolvedValueOnce({
        id: 'req-102',
        status: 'published',
        version: 2,
        cancelled_at: null,
      });

      const state = await resolver.resolveCurrentState('quoterequest', 'req-102', dummyTx);

      expect(state).toEqual({
        request: {
          id: 'req-102',
          status: 'published',
          version: 2,
          cancelled_at: null,
        },
      });
    });

    it('normalizes naming with hyphens and underscores (e.g. quote-request, quote_request)', async () => {
      quoteRequestRepo.findById.mockResolvedValueOnce({
        id: 'req-103',
        status: 'artisans_bidding',
        version: 1,
        cancelled_at: null,
      });

      const state = await resolver.resolveCurrentState('  quote_request  ', 'req-103', dummyTx);
      expect(quoteRequestRepo.findById).toHaveBeenCalledWith('req-103', dummyTx);
      expect(state.request.id).toBe('req-103');
      expect(state.request.status).toBe('artisans_bidding');
    });

    it('returns default fallback when QuoteRequest is not found in repository', async () => {
      quoteRequestRepo.findById.mockResolvedValueOnce(null);

      const state = await resolver.resolveCurrentState('QuoteRequest', 'missing-req', dummyTx);

      expect(state).toEqual({
        request: {
          id: 'missing-req',
          status: 'draft_request',
          version: 0,
          cancelled_at: null,
        },
      });
    });
  });

  // ==========================================================================
  // Branch 2: Allocation
  // ==========================================================================
  describe('Allocation branch', () => {
    it('resolves existing Allocation and its parent QuoteRequest', async () => {
      allocationRepo.findById.mockResolvedValueOnce({
        id: 'alloc-201',
        request_id: 'req-200',
        status: 'in_progress',
        version: 4,
      });
      quoteRequestRepo.findById.mockResolvedValueOnce({
        id: 'req-200',
        status: 'in_production',
        version: 5,
        cancelled_at: null,
      });

      const state = await resolver.resolveCurrentState('Allocation', 'alloc-201', dummyTx);

      expect(allocationRepo.findById).toHaveBeenCalledWith('alloc-201', dummyTx);
      expect(quoteRequestRepo.findById).toHaveBeenCalledWith('req-200', dummyTx);
      expect(state).toEqual({
        request: {
          id: 'req-200',
          status: 'in_production',
          version: 5,
          cancelled_at: null,
        },
        allocation: {
          id: 'alloc-201',
          status: 'in_progress',
          version: 4,
        },
      });
    });

    it('falls back to request_id defaults when parent QuoteRequest is not found', async () => {
      allocationRepo.findById.mockResolvedValueOnce({
        id: 'alloc-202',
        request_id: 'req-missing-parent',
        status: 'completed',
        version: 2,
      });
      quoteRequestRepo.findById.mockResolvedValueOnce(null);

      const state = await resolver.resolveCurrentState('allocation', 'alloc-202', dummyTx);

      expect(state).toEqual({
        request: {
          id: 'req-missing-parent',
          status: 'buyer_accepted',
          version: 1,
          cancelled_at: null,
        },
        allocation: {
          id: 'alloc-202',
          status: 'completed',
          version: 2,
        },
      });
    });

    it('returns empty allocation fallback when Allocation entity is not found', async () => {
      allocationRepo.findById.mockResolvedValueOnce(null);

      const state = await resolver.resolveCurrentState('Allocation', 'alloc-missing', dummyTx);

      expect(state).toEqual({
        request: { id: '0', status: 'buyer_accepted', version: 0, cancelled_at: null },
        allocation: { id: 'alloc-missing', status: 'not_started', version: 0 },
      });
    });
  });

  // ==========================================================================
  // Branch 3: Quote
  // ==========================================================================
  describe('Quote branch', () => {
    it('resolves existing Quote and its parent QuoteRequest', async () => {
      quoteRepo.findById.mockResolvedValueOnce({
        id: 'quote-301',
        request_id: 'req-300',
        status: 'active',
        version: 2,
      });
      quoteRequestRepo.findById.mockResolvedValueOnce({
        id: 'req-300',
        status: 'artisans_bidding',
        version: 3,
        cancelled_at: null,
      });

      const state = await resolver.resolveCurrentState('Quote', 'quote-301', dummyTx);

      expect(quoteRepo.findById).toHaveBeenCalledWith('quote-301', dummyTx);
      expect(quoteRequestRepo.findById).toHaveBeenCalledWith('req-300', dummyTx);
      expect(state).toEqual({
        request: {
          id: 'req-300',
          status: 'artisans_bidding',
          version: 3,
          cancelled_at: null,
        },
        quote: {
          id: 'quote-301',
          status: 'active',
          version: 2,
        },
      });
    });

    it('falls back to request_id defaults when parent QuoteRequest is not found', async () => {
      quoteRepo.findById.mockResolvedValueOnce({
        id: 'quote-302',
        request_id: 'req-300-lost',
        status: 'withdrawn',
        version: 1,
      });
      quoteRequestRepo.findById.mockResolvedValueOnce(null);

      const state = await resolver.resolveCurrentState('quote', 'quote-302', dummyTx);

      expect(state).toEqual({
        request: {
          id: 'req-300-lost',
          status: 'artisans_bidding',
          version: 1,
          cancelled_at: null,
        },
        quote: {
          id: 'quote-302',
          status: 'withdrawn',
          version: 1,
        },
      });
    });

    it('returns empty quote fallback when Quote entity is not found', async () => {
      quoteRepo.findById.mockResolvedValueOnce(null);

      const state = await resolver.resolveCurrentState('Quote', 'quote-missing', dummyTx);

      expect(state).toEqual({
        request: { id: '0', status: 'artisans_bidding', version: 0, cancelled_at: null },
        quote: { id: 'quote-missing', status: 'active', version: 0 },
      });
    });
  });

  // ==========================================================================
  // Branch 5: RequestRecipient
  // ==========================================================================
  describe('RequestRecipient branch', () => {
    it('resolves existing RequestRecipient (snake_case entity properties) with parent QuoteRequest', async () => {
      recipientRepo.findById.mockResolvedValueOnce({
        id: 'rec-501',
        request_id: 'req-500',
        workshop_id: 'ws-10',
        response_status: 'declined',
        version: 2,
      });
      quoteRequestRepo.findById.mockResolvedValueOnce({
        id: 'req-500',
        status: 'sent_to_artisans',
        version: 3,
        cancelled_at: null,
      });

      const state = await resolver.resolveCurrentState('RequestRecipient', 'rec-501', dummyTx);

      expect(recipientRepo.findById).toHaveBeenCalledWith('rec-501', dummyTx);
      expect(quoteRequestRepo.findById).toHaveBeenCalledWith('req-500', dummyTx);
      expect(state).toEqual({
        request: {
          id: 'req-500',
          status: 'sent_to_artisans',
          version: 3,
          cancelled_at: null,
        },
        recipient: {
          id: 'rec-501',
          status: 'declined',
          version: 2,
        },
      });
    });

    it('resolves existing RequestRecipient with camelCase properties (requestId, responseStatus)', async () => {
      recipientRepo.findById.mockResolvedValueOnce({
        id: 'rec-502',
        requestId: 'req-502',
        responseStatus: 'quoted',
        version: 3,
      });
      quoteRequestRepo.findById.mockResolvedValueOnce({
        id: 'req-502',
        status: 'artisans_bidding',
        version: 5,
        cancelled_at: null,
      });

      const state = await resolver.resolveCurrentState('recipient', 'rec-502', dummyTx);

      expect(recipientRepo.findById).toHaveBeenCalledWith('rec-502', dummyTx);
      expect(quoteRequestRepo.findById).toHaveBeenCalledWith('req-502', dummyTx);
      expect(state).toEqual({
        request: {
          id: 'req-502',
          status: 'artisans_bidding',
          version: 5,
          cancelled_at: null,
        },
        recipient: {
          id: 'rec-502',
          status: 'quoted',
          version: 3,
        },
      });
    });

    it('normalizes naming variants: requestrecipient, request_recipient, recipient, Recipient', async () => {
      const variants = ['requestrecipient', 'request_recipient', 'recipient', 'Recipient', '  RequestRecipient  '];

      for (const variant of variants) {
        recipientRepo.findById.mockResolvedValueOnce({
          id: 'rec-var',
          request_id: 'req-var',
          response_status: 'pending',
          version: 1,
        });
        quoteRequestRepo.findById.mockResolvedValueOnce({
          id: 'req-var',
          status: 'sent_to_artisans',
          version: 1,
          cancelled_at: null,
        });

        const state = await resolver.resolveCurrentState(variant, 'rec-var', dummyTx);
        expect(state.recipient).toEqual({
          id: 'rec-var',
          status: 'pending',
          version: 1,
        });
      }
    });

    it('falls back to sent_to_artisans defaults when parent QuoteRequest is not found', async () => {
      recipientRepo.findById.mockResolvedValueOnce({
        id: 'rec-503',
        request_id: 'req-503-orphan',
        response_status: 'pending',
        version: 1,
      });
      quoteRequestRepo.findById.mockResolvedValueOnce(null);

      const state = await resolver.resolveCurrentState('RequestRecipient', 'rec-503', dummyTx);

      expect(state).toEqual({
        request: {
          id: 'req-503-orphan',
          status: 'sent_to_artisans',
          version: 1,
          cancelled_at: null,
        },
        recipient: {
          id: 'rec-503',
          status: 'pending',
          version: 1,
        },
      });
    });

    it('returns default fallback when RequestRecipient is not found in repository', async () => {
      recipientRepo.findById.mockResolvedValueOnce(null);

      const state = await resolver.resolveCurrentState('RequestRecipient', 'rec-missing', dummyTx);

      expect(state).toEqual({
        request: {
          id: 'rec-missing',
          status: 'draft_request',
          version: 1,
          cancelled_at: null,
        },
      });
    });
  });

  // ==========================================================================
  // Branch 6: Default fallback & Unknown object types
  // ==========================================================================
  describe('Default fallback and unknown object types', () => {
    it('returns default fallback for unknown object type (e.g. unknown, Order, Invoice)', async () => {
      const unknownTypes = ['unknown', 'Order', 'Invoice', 'inquiry', 'CustomEntity'];

      for (const type of unknownTypes) {
        const state = await resolver.resolveCurrentState(type, 'obj-custom-1', dummyTx);

        expect(state).toEqual({
          request: {
            id: 'obj-custom-1',
            status: 'draft_request',
            version: 1,
            cancelled_at: null,
          },
        });
      }
    });

    it('passes transaction context faithfully to all repository calls', async () => {
      const specialTx = { txKey: 'special-transaction-lock' } as unknown as TransactionContext;

      recipientRepo.findById.mockResolvedValueOnce({
        id: 'rec-tx',
        request_id: 'req-tx',
        response_status: 'pending',
        version: 1,
      });
      quoteRequestRepo.findById.mockResolvedValueOnce(null);

      await resolver.resolveCurrentState('RequestRecipient', 'rec-tx', specialTx);

      expect(recipientRepo.findById).toHaveBeenCalledWith('rec-tx', specialTx);
      expect(quoteRequestRepo.findById).toHaveBeenCalledWith('req-tx', specialTx);
    });
  });
});
