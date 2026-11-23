import { assertTradingActor } from '../helpers/trading-actor.helper';
import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
  Id,
  TrustedActor,
} from '../../../../common/application/types/contract-types';
import type { IWorkshopContract } from '../../../workshops/public/contracts/workshop.contract';
import {
  Allocation,
  ConcurrencyConflictError,
  EntityId,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  QuoteRequestNotFoundError,
  TRADING_INVARIANTS,
  TradingDomainError,
  TradingIdempotencyPolicy,
  TradingPermissionDeniedError,
  TradingResourceNotFoundError,
  Version,
} from '../../domain';
import {
  computeCanonicalFingerprint,
  validateUuidV4,
} from '../../domain/utilities';
import type {
  AcceptanceCurrentStateDto,
  AcceptanceDto,
  AcceptanceOperationDto,
  AllocationDto,
} from '../../public/dtos/acceptance.dto';
import type {
  AcceptanceExecutionOptions,
  AcceptanceInput,
  ITradingContract,
} from '../../public/contracts/trading.contract';
import type {
  WorkshopRefDto,
} from '../dtos/trading-persistence.dtos';
import type {
  IAllocationRepository,
  IIdempotencyRecordRepository,
  IQuoteRepository,
  IQuoteRequestRepository,
  IRequestRecipientRepository,
} from '../ports/repositories/trading-repositories.port';

const DEFAULT_IDEMPOTENCY_TTL_HOURS = 24;

export interface ExecuteAcceptanceInternalInput
  extends AcceptanceExecutionOptions {
  readonly requestId: Id;
  readonly expectedRequestVersion: number;
  readonly actor: TrustedActor | AuthenticatedActor;
  readonly quoteId: Id;
  readonly expectedQuoteVersion: number;
}

export interface ExecuteAcceptanceResult {
  readonly data: AcceptanceDto;
  readonly currentState: AcceptanceCurrentStateDto;
}

/**
 * Application service implementing `ITradingContract` (`docs/contracts/backend.md`,
 * `UC-19`, `BR-16`, `BR-20`, `BR-27`, `SEC-06`, `SEC-13`).
 */
export class TradingAcceptanceService implements ITradingContract {
  constructor(
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly recipientRepo: IRequestRecipientRepository,
    private readonly quoteRepo: IQuoteRepository,
    private readonly allocationRepo: IAllocationRepository,
    private readonly idempotencyRepo: IIdempotencyRecordRepository,
    private readonly workshopContract?: IWorkshopContract,
  ) {}

  async findAcceptanceReplay(
    input: AcceptanceInput & { idempotencyKey: string },
    tx: TransactionContext,
  ): Promise<{
    data: AcceptanceDto;
    operation: AcceptanceOperationDto;
  } | null> {
    const actorId = this.assertBuyerActor(input.actor);
    const requestId = EntityId.of(input.requestId, 'id').value;
    const quoteId = EntityId.of(input.quoteId, 'quote_id').value;
    const expectedRequestVersion = Version.of(
      input.expectedRequestVersion,
      'expected_request_version',
    ).value;
    const expectedQuoteVersion = Version.of(
      input.expectedQuoteVersion,
      'expected_quote_version',
    ).value;

    const normalizedKey = this.validateIdempotencyKey(input.idempotencyKey);

    const request = await this.quoteRequestRepo.findById(requestId, tx);
    if (!request || request.buyer_id !== actorId) {
      throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
    }

    const existing = await this.idempotencyRepo.findByScope<AcceptanceDto>(
      {
        account_id: actorId,
        action: 'accept_quote',
        object_type: 'QuoteRequest',
        object_id: requestId,
        idempotency_key: normalizedKey,
      },
      tx,
    );

    if (!existing) {
      return null;
    }

    const incomingFingerprint = this.buildAcceptanceFingerprint({
      quoteId,
      expectedRequestVersion,
      expectedQuoteVersion,
    });
    TradingIdempotencyPolicy.assertFingerprintMatches(
      existing.request_fingerprint,
      incomingFingerprint,
    );

    const quote = await this.quoteRepo.findById(quoteId, tx);

    const currentState: AcceptanceOperationDto['current_state'] = Object.freeze(
      {
        request: Object.freeze({
          id: request.id,
          status: request.status,
          version: request.version,
          cancelled_at: request.cancelled_at
            ? request.cancelled_at.toISOString()
            : null,
        }),
        quote:
          quote && quote.request_id === request.id
            ? Object.freeze({
                id: quote.id,
                status: quote.status,
                version: quote.version,
              })
            : null,
      },
    );

    return {
      data: existing.result_snapshot,
      operation: Object.freeze({
        id: existing.id,
        replayed: true,
        committed_at: existing.created_at.toISOString(),
        current_state: currentState,
      }),
    };
  }

  async prepareAcceptance(
    input: AcceptanceInput,
    tx: TransactionContext,
  ): Promise<{ workshopIds: Id[] }> {
    const actorId = this.assertBuyerActor(input.actor);
    const requestId = EntityId.of(input.requestId, 'id').value;
    const quoteId = EntityId.of(input.quoteId, 'quote_id').value;
    Version.of(input.expectedRequestVersion, 'expected_request_version');
    Version.of(input.expectedQuoteVersion, 'expected_quote_version');
    this.requireWorkshopContract();

    // Pre-read without locks to verify Buyer ownership and discover workshopId
    // before acquiring the cross-module Workshop lock (data-design.md §4.2).
    const request = await this.quoteRequestRepo.findById(requestId, tx);
    if (!request || request.buyer_id !== actorId) {
      throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
    }

    const quote = await this.quoteRepo.findById(quoteId, tx);
    if (!quote || quote.request_id !== request.id) {
      throw new TradingResourceNotFoundError('Quote was not found.', {
        entity: 'Quote',
      });
    }

    return { workshopIds: [quote.workshop_id] };
  }

  async accept(
    input: AcceptanceInput & { idempotencyKey: string },
    tx: TransactionContext,
    options?: AcceptanceExecutionOptions,
  ): Promise<{
    data: AcceptanceDto;
    operation: AcceptanceOperationDto;
  }> {
    const normalizedKey = this.validateIdempotencyKey(input.idempotencyKey);
    const actorId = this.assertBuyerActor(input.actor);
    const requestId = EntityId.of(input.requestId, 'id').value;
    const quoteId = EntityId.of(input.quoteId, 'quote_id').value;
    const expectedRequestVersion = Version.of(
      input.expectedRequestVersion,
      'expected_request_version',
    ).value;
    const expectedQuoteVersion = Version.of(
      input.expectedQuoteVersion,
      'expected_quote_version',
    ).value;
    this.requireWorkshopContract();

    const now = options?.now ?? new Date();
    const { data, currentState } = await this.executeAcceptance(
      {
        requestId,
        expectedRequestVersion,
        actor: input.actor,
        quoteId,
        expectedQuoteVersion,
        expectedWorkshopId: options?.expectedWorkshopId,
        now,
      },
      tx,
    );

    const fingerprint = this.buildAcceptanceFingerprint({
      quoteId,
      expectedRequestVersion,
      expectedQuoteVersion,
    });
    const expiresAt = new Date(
      now.getTime() + DEFAULT_IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000,
    );

    const savedRecord = await this.idempotencyRepo.save<AcceptanceDto>(
      {
        idempotency_key: normalizedKey,
        request_fingerprint: fingerprint,
        account_id: actorId,
        action: 'accept_quote',
        object_type: 'QuoteRequest',
        object_id: requestId,
        result_snapshot: data,
        created_at: now,
        expires_at: expiresAt,
      },
      tx,
    );

    return {
      data,
      operation: Object.freeze({
        id: savedRecord.id,
        replayed: false,
        committed_at: savedRecord.created_at.toISOString(),
        current_state: {
          request: currentState.request,
          quote: currentState.quote ?? null,
        },
      }),
    };
  }

  /**
   * Executes the core locked acceptance mutation inside an active transaction.
   * Used directly when `TradingMutationInterceptor` owns `IdempotencyRecord` persistence.
   */
  async executeAcceptance(
    input: ExecuteAcceptanceInternalInput,
    tx: TransactionContext,
  ): Promise<ExecuteAcceptanceResult> {
    const actorId = this.assertBuyerActor(input.actor);
    const requestId = EntityId.of(input.requestId, 'id').value;
    const quoteId = EntityId.of(input.quoteId, 'quote_id').value;
    const expectedRequestVersion = Version.of(
      input.expectedRequestVersion,
      'expected_request_version',
    ).value;
    const expectedQuoteVersion = Version.of(
      input.expectedQuoteVersion,
      'expected_quote_version',
    ).value;
    const workshopContract = this.requireWorkshopContract();

    // Strict lock acquisition order (`data-design.md` §4.2, `TradingLockOrderingPolicy`):
    // (Workshop already locked by workflow) -> QuoteRequest -> RequestRecipient -> Quote
    const lockedRequest = await this.quoteRequestRepo.lockById(requestId, tx);
    if (!lockedRequest || lockedRequest.buyer_id !== actorId) {
      throw new QuoteRequestNotFoundError('QuoteRequest was not found.');
    }

    let workshopIdToLock = input.expectedWorkshopId;
    if (!workshopIdToLock) {
      const preQuote = await this.quoteRepo.findById(quoteId, tx);
      if (!preQuote || preQuote.request_id !== lockedRequest.id) {
        throw new TradingResourceNotFoundError('Quote was not found.', {
          entity: 'Quote',
        });
      }
      workshopIdToLock = preQuote.workshop_id;
    }

    const lockedRecipient = await this.recipientRepo.lockByRequestAndWorkshop(
      requestId,
      workshopIdToLock,
      tx,
    );
    if (!lockedRecipient) {
      throw new TradingResourceNotFoundError(
        'RequestRecipient was not found.',
        { entity: 'RequestRecipient' },
      );
    }

    const lockedQuote = await this.quoteRepo.lockById(quoteId, tx);
    if (!lockedQuote || lockedQuote.request_id !== lockedRequest.id) {
      throw new TradingResourceNotFoundError('Quote was not found.', {
        entity: 'Quote',
      });
    }

    if (lockedQuote.workshop_id !== workshopIdToLock) {
      throw new ConcurrencyConflictError(
        `Quote ${quoteId} workshop changed concurrently during acceptance.`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'Quote',
        },
      );
    }

    // Validate request cancellation before optimistic version (matching `QuoteRequest.markBuyerAccepted`
    // at `quote-request.entity.ts:916-917` and `concurrency-optimistic.challenger.spec.ts:824-829`),
    // and check `expectedRequestVersion` BEFORE `lockedQuote.acceptDirect` so non-cancelled concurrent
    // updates (e.g., `buyer_accepted`) return 409 CONCURRENCY_CONFLICT rather than 422 INVALID_STATE.
    lockedRequest.assertNotCancelled();
    lockedRequest.assertVersionMatches(expectedRequestVersion);

    let workshopIsActive = false;
    const summary = await workshopContract.getWorkshopSummary(
      lockedQuote.workshop_id,
    );
    if (!summary) {
      throw new TradingResourceNotFoundError('Workshop was not found.', {
        entity: 'Workshop',
      });
    }

    const workshopName = summary.name.trim();
    if (workshopName.length === 0) {
      throw new InvalidStateTransitionError(
        'Workshop summary name cannot be empty.',
        { entity: 'Workshop' },
      );
    }

    const workshopRef: WorkshopRefDto = Object.freeze({
      id: summary.id,
      name: workshopName,
    });
    workshopIsActive = summary.status === 'active';

    const now = input.now ?? new Date();

    // Domain transition for Quote (`UC-19`, `BR-16`, `BR-20`)
    const { quote: acceptedQuote, recipientHistory } = lockedQuote.acceptDirect(
      {
        request: lockedRequest,
        recipientId: lockedRecipient.id,
        actorId,
        expectedQuoteVersion,
        workshopIsActive,
        now,
      },
    );

    // Domain transition for QuoteRequest (closes bidding if open, marks buyer_accepted)
    const { request: acceptedRequest, statusLogs } =
      lockedRequest.markBuyerAccepted({
        buyerId: actorId,
        expectedVersion: expectedRequestVersion,
        now,
      });

    // Create 1 Allocation (`status: 'not_started'`, `version: 1`, `quantity = request.quantity`)
    const { allocation, log: allocationLog } =
      Allocation.createFromAcceptedQuote({
        id: '1',
        request_id: acceptedRequest.id,
        workshop_id: acceptedQuote.workshop_id,
        quote_id: acceptedQuote.id,
        quantity: acceptedRequest.quantity!,
        unit_price: acceptedQuote.unit_price,
        committed_delivery_at: acceptedQuote.committed_delivery_at,
        actorId,
        now,
      });

    // Persist atomically within `tx`
    const savedQuote = await this.quoteRepo.update(
      {
        quote: acceptedQuote,
        expectedVersion: expectedQuoteVersion,
        recipientHistory,
      },
      tx,
    );

    const savedRequest = await this.quoteRequestRepo.update(
      {
        request: acceptedRequest,
        expectedVersion: expectedRequestVersion,
        statusLogs,
      },
      tx,
    );

    const savedAllocation = await this.allocationRepo.create(
      {
        allocation,
        log: allocationLog,
        useEntityId: false,
      },
      tx,
    );

    const allocationDto: AllocationDto = Object.freeze({
      id: savedAllocation.id,
      request_id: savedAllocation.request_id,
      workshop: workshopRef,
      quote_id: savedAllocation.quote_id,
      quantity: savedAllocation.quantity,
      unit_price: savedAllocation.unit_price,
      committed_delivery_at: savedAllocation.committed_delivery_at.toISOString(),
      status: savedAllocation.status,
      version: savedAllocation.version,
      started_at: savedAllocation.started_at
        ? savedAllocation.started_at.toISOString()
        : null,
      started_by: null,
      handed_over_at: savedAllocation.handed_over_at
        ? savedAllocation.handed_over_at.toISOString()
        : null,
      handed_over_by: null,
      delivery_note: savedAllocation.delivery_note,
      admin_handed_over: savedAllocation.admin_handed_over,
      admin_handover_reason: savedAllocation.admin_handover_reason,
      admin_delivery_evidence: savedAllocation.admin_delivery_evidence,
      admin_handover_actual_at: savedAllocation.admin_handover_actual_at
        ? savedAllocation.admin_handover_actual_at.toISOString()
        : null,
      traceability_warning: savedAllocation.deriveTraceabilityWarning(
        new Set<string>(),
      ),
    });

    const acceptanceDto: AcceptanceDto = Object.freeze({
      request_id: savedRequest.id,
      request_status: savedRequest.status,
      request_version: savedRequest.version,
      allocations: Object.freeze([allocationDto]) as AllocationDto[],
    });

    const currentState: AcceptanceCurrentStateDto = Object.freeze({
      request: Object.freeze({
        id: savedRequest.id,
        status: savedRequest.status,
        version: savedRequest.version,
        cancelled_at: savedRequest.cancelled_at
          ? savedRequest.cancelled_at.toISOString()
          : null,
      }),
      quote: Object.freeze({
        id: savedQuote.id,
        status: savedQuote.status,
        version: savedQuote.version,
      }),
    });

    return {
      data: acceptanceDto,
      currentState,
    };
  }

  private requireWorkshopContract(): IWorkshopContract {
    if (!this.workshopContract) {
      throw new Error(
        'Workshop contract is required for trading acceptance.',
      );
    }
    return this.workshopContract;
  }

  private assertBuyerActor(actor: TrustedActor | AuthenticatedActor): Id {
    assertTradingActor(actor, {
      expectedRole: 'buyer',
      tempPasswordMessage: 'Temporary password session cannot accept quotes.',
      roleDeniedMessage: 'Only buyers can accept quotes for quote requests.',
    });

    return EntityId.of(actor.accountId, 'accountId').value;
  }

  private validateIdempotencyKey(rawKey: string): string {
    if (typeof rawKey !== 'string' || !validateUuidV4(rawKey, { trim: true })) {
      throw new InvalidTradingInputError(
        'Header X-Idempotency-Key must be a valid UUID v4.',
        {
          field: 'X-Idempotency-Key',
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
        },
      );
    }
    return rawKey.trim().toLowerCase();
  }

  private buildAcceptanceFingerprint(params: {
    readonly quoteId: Id;
    readonly expectedRequestVersion: number;
    readonly expectedQuoteVersion: number;
  }): string {
    return computeCanonicalFingerprint({
      quote_id: params.quoteId,
      expected_request_version: params.expectedRequestVersion,
      expected_quote_version: params.expectedQuoteVersion,
    });
  }
}
