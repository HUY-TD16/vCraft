import { Injectable, Inject } from '@nestjs/common';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';
import type { TradingCurrentStateDto } from '../../../application/dtos/trading-persistence.dtos';
import type {
  IQuoteRequestRepository,
  IAllocationRepository,
  IQuoteRepository,
  IRequestRecipientRepository,
} from '../../../application/ports/repositories/trading-repositories.port';
import {
  QUOTE_REQUEST_REPOSITORY,
  ALLOCATION_REPOSITORY,
  QUOTE_REPOSITORY,
  REQUEST_RECIPIENT_REPOSITORY,
} from '../../../application/ports/repositories/trading-repositories.port';

export interface ITradingCurrentStateResolver {
  resolveCurrentState(
    objectType: string,
    objectId: Id,
    tx: TransactionContext,
  ): Promise<TradingCurrentStateDto>;
}

export const TRADING_CURRENT_STATE_RESOLVER = Symbol('TRADING_CURRENT_STATE_RESOLVER');

@Injectable()
export class TradingCurrentStateResolver implements ITradingCurrentStateResolver {
  constructor(
    @Inject(QUOTE_REQUEST_REPOSITORY)
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    @Inject(ALLOCATION_REPOSITORY)
    private readonly allocationRepo: IAllocationRepository,
    @Inject(QUOTE_REPOSITORY)
    private readonly quoteRepo: IQuoteRepository,
    @Inject(REQUEST_RECIPIENT_REPOSITORY)
    private readonly recipientRepo: IRequestRecipientRepository,
  ) {}

  async resolveCurrentState(
    objectType: string,
    objectId: Id,
    tx: TransactionContext,
  ): Promise<TradingCurrentStateDto> {
    const normalizedType = objectType.trim().toLowerCase().replace(/[-_]/g, '');

    if (normalizedType === 'quoterequest') {
      const request = await this.quoteRequestRepo.findById(objectId, tx);
      if (!request) {
        return {
          request: {
            id: objectId,
            status: 'draft_request',
            version: 0,
            cancelled_at: null,
          },
        };
      }
      return {
        request: {
          id: request.id,
          status: request.status,
          version: request.version,
          cancelled_at: request.cancelled_at
            ? request.cancelled_at instanceof Date
              ? request.cancelled_at.toISOString()
              : String(request.cancelled_at)
            : null,
        },
      };
    }

    if (normalizedType === 'allocation') {
      const allocation = await this.allocationRepo.findById(objectId, tx);
      if (!allocation) {
        return {
          request: { id: '0', status: 'buyer_accepted', version: 0, cancelled_at: null },
          allocation: { id: objectId, status: 'not_started', version: 0 },
        };
      }
      const parentRequest = await this.quoteRequestRepo.findById(
        allocation.request_id,
        tx,
      );
      return {
        request: {
          id: parentRequest?.id ?? allocation.request_id,
          status: parentRequest?.status ?? 'buyer_accepted',
          version: parentRequest?.version ?? 1,
          cancelled_at: parentRequest?.cancelled_at
            ? parentRequest.cancelled_at instanceof Date
              ? parentRequest.cancelled_at.toISOString()
              : String(parentRequest.cancelled_at)
            : null,
        },
        allocation: {
          id: allocation.id,
          status: allocation.status,
          version: allocation.version,
        },
      };
    }

    if (normalizedType === 'quote') {
      const quote = await this.quoteRepo.findById(objectId, tx);
      if (!quote) {
        return {
          request: { id: '0', status: 'artisans_bidding', version: 0, cancelled_at: null },
          quote: { id: objectId, status: 'active', version: 0 },
        };
      }
      const parentRequest = await this.quoteRequestRepo.findById(
        quote.request_id,
        tx,
      );
      return {
        request: {
          id: parentRequest?.id ?? quote.request_id,
          status: parentRequest?.status ?? 'artisans_bidding',
          version: parentRequest?.version ?? 1,
          cancelled_at: parentRequest?.cancelled_at
            ? parentRequest.cancelled_at instanceof Date
              ? parentRequest.cancelled_at.toISOString()
              : String(parentRequest.cancelled_at)
            : null,
        },
        quote: {
          id: quote.id,
          status: quote.status,
          version: quote.version,
        },
      };
    }

    if (normalizedType === 'requestrecipient' || normalizedType === 'recipient') {
      const recipient = await this.recipientRepo.findById(objectId, tx);
      if (!recipient) {
        return {
          request: {
            id: objectId,
            status: 'draft_request',
            version: 1,
            cancelled_at: null,
          },
        };
      }
      const parentRequestId =
        (recipient as { requestId?: Id; request_id?: Id }).requestId ??
        (recipient as { request_id?: Id }).request_id;
      const parentRequest = parentRequestId
        ? await this.quoteRequestRepo.findById(parentRequestId, tx)
        : null;
      const recipientStatus =
        (recipient as { responseStatus?: any; response_status?: any }).responseStatus ??
        (recipient as { response_status?: any }).response_status;

      return {
        request: {
          id: parentRequest?.id ?? parentRequestId ?? objectId,
          status: parentRequest?.status ?? 'sent_to_artisans',
          version: parentRequest?.version ?? 1,
          cancelled_at: parentRequest?.cancelled_at
            ? parentRequest.cancelled_at instanceof Date
              ? parentRequest.cancelled_at.toISOString()
              : String(parentRequest.cancelled_at)
            : null,
        },
        recipient: {
          id: recipient.id,
          status: recipientStatus,
          version: recipient.version,
        },
      };
    }

    // Default fallback
    return {
      request: {
        id: objectId,
        status: 'draft_request',
        version: 1,
        cancelled_at: null,
      },
    };
  }
}
