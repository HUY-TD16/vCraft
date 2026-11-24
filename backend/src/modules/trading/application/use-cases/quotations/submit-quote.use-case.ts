import { assertTradingActor } from '../../helpers/trading-actor.helper';
import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
  Id,
  TrustedActor,
} from '../../../../../common/application/types/contract-types';
import type { IWorkshopContract } from '../../../../workshops/public/contracts/workshop.contract';
import {
  ConcurrencyConflictError,
  EntityId,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  Quantity,
  Quote,
  QuoteRequestNotFoundError,
  type RequestRecipient,
  TRADING_INVARIANTS,
  TradingDomainError,
  TradingPermissionDeniedError,
  UnitPrice,
  Version,
} from '../../../domain';
import type {
  IQuoteRepository,
  IQuoteRequestRepository,
  IRequestRecipientRepository,
} from '../../ports/repositories/trading-repositories.port';
import type {
  QuoteDto,
  QuoteMutationDto,
  RecipientDto,
  TradingCurrentStateDto,
  WorkshopRefDto,
} from '../../dtos/trading-persistence.dtos';

export interface SubmitQuoteInput {
  readonly actor: AuthenticatedActor | TrustedActor;
  readonly requestId?: Id;
  readonly id?: Id;
  readonly expectedRecipientVersion?: number;
  readonly expected_recipient_version?: number;
  readonly expectedQuoteVersion?: number | null;
  readonly expected_quote_version?: number | null;
  readonly unitPrice?: number;
  readonly unit_price?: number;
  readonly maxQuantity?: number;
  readonly max_quantity?: number;
  readonly bidAcceptDeadline?: Date | string;
  readonly bid_accept_deadline?: Date | string;
  readonly committedDeliveryAt?: Date | string;
  readonly committed_delivery_at?: Date | string;
  readonly now?: Date;
  readonly tx?: TransactionContext;
}

export interface SubmitQuoteResult {
  readonly result: QuoteMutationDto;
  readonly currentState: TradingCurrentStateDto;
  readonly created: boolean;
}

function parseInstant(raw: unknown, field: string): Date {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) {
      throw new InvalidTradingInputError(`${field} must be a valid Date.`, {
        field,
      });
    }
    return new Date(raw.getTime());
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new InvalidTradingInputError(
        `${field} must be a valid ISO 8601 UTC datetime.`,
        { field },
      );
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      throw new InvalidTradingInputError(
        `${field} must be a valid ISO 8601 UTC datetime.`,
        { field },
      );
    }
    return parsed;
  }

  throw new InvalidTradingInputError(
    `${field} must be a valid ISO 8601 UTC datetime.`,
    { field },
  );
}

/**
 * Use Case UC-16 (`BR-14`, `BR-15`, `BR-26`, `BR-27`, `SEC-06`):
 * Allows an invited, active Artisan workshop to submit an initial quote,
 * edit an active quote, or resubmit a withdrawn quote on an open QuoteRequest.
 */
export class SubmitQuoteUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly recipientRepo: IRequestRecipientRepository,
    private readonly quoteRepo: IQuoteRepository,
    private readonly workshopContract?: IWorkshopContract,
  ) {}

  async execute(input: SubmitQuoteInput): Promise<SubmitQuoteResult> {
    assertTradingActor(input.actor, {
      expectedRole: 'artisan',
      tempPasswordMessage: 'Temporary password session cannot submit quotes.',
      roleDeniedMessage: 'Only artisans can submit quotes for quote requests.',
      requireWorkshop: true,
      workshopDeniedMessage: 'Artisan actor is not associated with any workshop.',
    });

    const actorId = EntityId.of(input.actor.accountId, 'accountId').value;
    const workshopId = EntityId.of(input.actor.workshopId, 'workshopId').value;

    const rawRequestId = input.requestId ?? input.id;
    if (!rawRequestId) {
      throw new InvalidTradingInputError('requestId is required.', {
        field: 'requestId',
      });
    }
    const requestId = EntityId.of(rawRequestId, 'id').value;

    const rawExpectedRecipientVersion =
      input.expectedRecipientVersion ?? input.expected_recipient_version;
    if (
      rawExpectedRecipientVersion === undefined ||
      rawExpectedRecipientVersion === null
    ) {
      throw new InvalidTradingInputError(
        'expected_recipient_version is required to submit a quote.',
        { field: 'expected_recipient_version' },
      );
    }
    const expectedRecipientVersion = Version.of(
      rawExpectedRecipientVersion,
      'expected_recipient_version',
    ).value;

    const rawExpectedQuoteVersion =
      'expectedQuoteVersion' in input
        ? input.expectedQuoteVersion
        : input.expected_quote_version;
    if (rawExpectedQuoteVersion === undefined) {
      throw new InvalidTradingInputError(
        'expected_quote_version is required (null for initial submission).',
        { field: 'expected_quote_version' },
      );
    }
    const expectedQuoteVersion =
      rawExpectedQuoteVersion === null
        ? null
        : Version.of(rawExpectedQuoteVersion, 'expected_quote_version').value;

    const rawUnitPrice = input.unitPrice ?? input.unit_price;
    if (rawUnitPrice === undefined || rawUnitPrice === null) {
      throw new InvalidTradingInputError('unit_price is required.', {
        field: 'unit_price',
      });
    }
    const unitPrice = UnitPrice.of(rawUnitPrice, 'unit_price').value;

    const rawMaxQuantity = input.maxQuantity ?? input.max_quantity;
    if (rawMaxQuantity === undefined || rawMaxQuantity === null) {
      throw new InvalidTradingInputError('max_quantity is required.', {
        field: 'max_quantity',
      });
    }
    const maxQuantity = Quantity.of(rawMaxQuantity, 'max_quantity').value;

    const bidAcceptDeadline = parseInstant(
      input.bidAcceptDeadline ?? input.bid_accept_deadline,
      'bid_accept_deadline',
    );
    const committedDeliveryAt = parseInstant(
      input.committedDeliveryAt ?? input.committed_delivery_at,
      'committed_delivery_at',
    );

    const runWithTx = async (
      tx: TransactionContext,
    ): Promise<SubmitQuoteResult> => {
      // Mandatory lock ordering (data-design.md §4.2, BR-27):
      // 1. Workshop -> 2. QuoteRequest -> 3. RequestRecipient -> 4. Quote
      if (this.workshopContract) {
        await this.workshopContract.lockAndAssertActive([workshopId], tx);
      }

      const request = await this.quoteRequestRepo.lockById(requestId, tx);
      if (!request) {
        throw new QuoteRequestNotFoundError(
          `QuoteRequest ${requestId} was not found.`,
          { entity: 'QuoteRequest', id: requestId },
        );
      }

      const recipient = await this.recipientRepo.lockByRequestAndWorkshop(
        requestId,
        workshopId,
        tx,
      );
      if (!recipient) {
        // SEC-06 anti-IDOR: uninvited workshops receive 404 RESOURCE_NOT_FOUND
        throw new QuoteRequestNotFoundError(
          `QuoteRequest ${requestId} was not found.`,
          { entity: 'QuoteRequest', id: requestId },
        );
      }

      const existingQuote = await this.quoteRepo.lockByRequestAndWorkshop(
        requestId,
        workshopId,
        tx,
      );

      // Optimistic concurrency checks (BR-27, api-design.md §9.4)
      recipient.assertVersionMatches(expectedRecipientVersion);

      if (existingQuote === null && expectedQuoteVersion !== null) {
        throw new ConcurrencyConflictError(
          'expected_quote_version must be null when submitting an initial quote.',
          {
            invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
            entity: 'Quote',
          },
        );
      }

      if (existingQuote !== null && expectedQuoteVersion === null) {
        throw new ConcurrencyConflictError(
          'expected_quote_version must match the existing quote version when editing or resubmitting.',
          {
            invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
            entity: 'Quote',
          },
        );
      }

      if (request.status === 'draft_request') {
        throw new InvalidStateTransitionError(
          'Cannot submit a quote for a draft QuoteRequest.',
          {
            invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
            entity: 'QuoteRequest',
          },
        );
      }

      const now = input.now ?? new Date();
      let savedQuote: Quote;
      let updatedRecipient: RequestRecipient;
      let created: boolean;

      if (existingQuote === null) {
        const submission = Quote.submitNew({
          id: '1',
          request,
          recipient,
          actorId,
          workshopIsActive: true,
          unitPrice,
          maxQuantity,
          bidAcceptDeadline,
          committedDeliveryAt,
          now,
        });

        savedQuote = await this.quoteRepo.create(
          {
            quote: submission.quote,
            recipient: submission.recipient,
            recipientHistory: submission.recipientHistory,
            useEntityId: false,
          },
          tx,
        );
        updatedRecipient = submission.recipient;
        created = true;
      } else {
        if (expectedQuoteVersion === null) {
          throw new ConcurrencyConflictError(
            'expected_quote_version must match the existing quote version when editing or resubmitting.',
            {
              invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
              entity: 'Quote',
            },
          );
        }

        const updated = existingQuote.updateOrResubmit({
          request,
          recipient,
          actorId,
          expectedQuoteVersion,
          workshopIsActive: true,
          unitPrice,
          maxQuantity,
          bidAcceptDeadline,
          committedDeliveryAt,
          now,
        });

        savedQuote = await this.quoteRepo.update(
          {
            quote: updated.quote,
            expectedVersion: expectedQuoteVersion,
            recipient: updated.recipient,
            recipientHistory: updated.recipientHistory,
          },
          tx,
        );
        updatedRecipient = updated.recipient;
        created = false;
      }

      // BR-15, BR-26: First valid quote transitions QuoteRequest sent_to_artisans -> artisans_bidding
      const { request: finalRequest, statusLog } =
        request.recordFirstQuoteReceived({ actorId, now });
      let persistedRequest = finalRequest;
      if (statusLog !== null) {
        persistedRequest = await this.quoteRequestRepo.update(
          {
            request: finalRequest,
            expectedVersion: request.version,
            statusLogs: [statusLog],
          },
          tx,
        );
      }

      let workshopRef: WorkshopRefDto = Object.freeze({
        id: workshopId,
        name: '',
      });
      if (this.workshopContract) {
        const summary =
          await this.workshopContract.getWorkshopSummary(workshopId);
        if (summary) {
          workshopRef = Object.freeze({
            id: summary.id,
            name: summary.name,
          });
        }
      }

      const eligibility = savedQuote.evaluateEligibility({
        request: persistedRequest,
        workshopIsActive: true,
        now,
      });

      const quoteDto: QuoteDto = Object.freeze({
        id: savedQuote.id,
        request_id: savedQuote.request_id,
        workshop: workshopRef,
        unit_price: savedQuote.unit_price,
        max_quantity: savedQuote.max_quantity,
        bid_accept_deadline: savedQuote.bid_accept_deadline.toISOString(),
        committed_delivery_at: savedQuote.committed_delivery_at.toISOString(),
        status: savedQuote.status,
        version: savedQuote.version,
        withdraw_reason: savedQuote.withdraw_reason,
        withdrawn_at: savedQuote.withdrawn_at
          ? savedQuote.withdrawn_at.toISOString()
          : null,
        is_eligible: eligibility.is_eligible,
        ineligible_reasons: Object.freeze([...eligibility.ineligible_reasons]),
        created_at: savedQuote.created_at.toISOString(),
        updated_at: savedQuote.updated_at.toISOString(),
      });

      const recipientDto: RecipientDto = Object.freeze({
        id: updatedRecipient.id,
        request_id: updatedRecipient.request_id,
        workshop: workshopRef,
        response_status: updatedRecipient.response_status,
        version: updatedRecipient.version,
        sent_at: updatedRecipient.sent_at.toISOString(),
        responded_at: updatedRecipient.responded_at
          ? updatedRecipient.responded_at.toISOString()
          : null,
        decline_reason: updatedRecipient.decline_reason,
        eligibility_labels: Object.freeze([]),
      });

      const mutationDto: QuoteMutationDto = Object.freeze({
        quote: quoteDto,
        recipient: recipientDto,
      });

      const currentState: TradingCurrentStateDto = Object.freeze({
        request: Object.freeze({
          id: persistedRequest.id,
          status: persistedRequest.status,
          version: persistedRequest.version,
          cancelled_at: persistedRequest.cancelled_at
            ? persistedRequest.cancelled_at.toISOString()
            : null,
        }),
        recipient: Object.freeze({
          id: updatedRecipient.id,
          status: updatedRecipient.response_status,
          version: updatedRecipient.version,
        }),
        quote: Object.freeze({
          id: savedQuote.id,
          status: savedQuote.status,
          version: savedQuote.version,
        }),
      });

      return Object.freeze({
        result: mutationDto,
        currentState,
        created,
      });
    };

    if (input.tx) {
      return runWithTx(input.tx);
    }

    return this.txRunner.run((tx) => runWithTx(tx));
  }
}
