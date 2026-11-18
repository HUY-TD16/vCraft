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
  EntityId,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  MAX_WITHDRAW_REASON_LENGTH,
  QuoteRequestNotFoundError,
  TRADING_INVARIANTS,
  TradingDomainError,
  TradingPermissionDeniedError,
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

export interface WithdrawQuoteInput {
  readonly actor: AuthenticatedActor | TrustedActor;
  readonly requestId?: Id;
  readonly id?: Id;
  readonly expectedRecipientVersion?: number;
  readonly expected_recipient_version?: number;
  readonly expectedQuoteVersion?: number;
  readonly expected_quote_version?: number;
  readonly withdrawReason?: string;
  readonly withdraw_reason?: string;
  readonly now?: Date;
  readonly tx?: TransactionContext;
}

export interface WithdrawQuoteResult {
  readonly result: QuoteMutationDto;
  readonly currentState: TradingCurrentStateDto;
}

/**
 * Use Case UC-16 (`BR-05`, `BR-12`, `BR-15`, `BR-21`, `BR-22`, `BR-23`, `BR-26`, `BR-27`, `SEC-06`):
 * Allows an invited Artisan workshop that owns an active quote to withdraw it
 * as long as the QuoteRequest is neither accepted nor cancelled — even when
 * bidding is closed or the workshop is currently suspended.
 */
export class WithdrawQuoteUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly recipientRepo: IRequestRecipientRepository,
    private readonly quoteRepo: IQuoteRepository,
    private readonly workshopContract?: IWorkshopContract,
  ) {}

  async execute(input: WithdrawQuoteInput): Promise<WithdrawQuoteResult> {
    if (
      'sessionLevel' in input.actor &&
      input.actor.sessionLevel === 'temp_password'
    ) {
      throw new TradingDomainError(
        'TEMP_PASSWORD_RESTRICTED',
        'Temporary password session cannot withdraw quotes.',
      );
    }

    if (input.actor.role !== 'artisan') {
      throw new TradingPermissionDeniedError(
        'Only artisans can withdraw quotes for quote requests.',
      );
    }

    if (!input.actor.workshopId) {
      throw new TradingPermissionDeniedError(
        'Artisan actor is not associated with any workshop.',
      );
    }

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
        'expected_recipient_version is required to withdraw a quote.',
        { field: 'expected_recipient_version' },
      );
    }
    const expectedRecipientVersion = Version.of(
      rawExpectedRecipientVersion,
      'expected_recipient_version',
    ).value;

    const rawExpectedQuoteVersion =
      input.expectedQuoteVersion ?? input.expected_quote_version;
    if (
      rawExpectedQuoteVersion === undefined ||
      rawExpectedQuoteVersion === null
    ) {
      throw new InvalidTradingInputError(
        'expected_quote_version is required to withdraw a quote.',
        { field: 'expected_quote_version' },
      );
    }
    const expectedQuoteVersion = Version.of(
      rawExpectedQuoteVersion,
      'expected_quote_version',
    ).value;

    const rawWithdrawReason =
      input.withdrawReason !== undefined
        ? input.withdrawReason
        : input.withdraw_reason;
    if (typeof rawWithdrawReason !== 'string') {
      throw new InvalidTradingInputError(
        'withdraw_reason is required when withdrawing a quote.',
        { field: 'withdraw_reason' },
      );
    }
    const trimmedWithdrawReason = rawWithdrawReason.trim();
    if (trimmedWithdrawReason.length === 0) {
      throw new InvalidTradingInputError(
        'withdraw_reason is required when withdrawing a quote.',
        { field: 'withdraw_reason' },
      );
    }
    if (trimmedWithdrawReason.length > MAX_WITHDRAW_REASON_LENGTH) {
      throw new InvalidTradingInputError(
        `withdraw_reason cannot exceed ${MAX_WITHDRAW_REASON_LENGTH} characters.`,
        { field: 'withdraw_reason' },
      );
    }

    const runWithTx = async (
      tx: TransactionContext,
    ): Promise<WithdrawQuoteResult> => {
      // Mandatory lock ordering (data-design.md §4.2, BR-27):
      // 1. QuoteRequest -> 2. RequestRecipient -> 3. Quote
      // Note (BR-15, UC-16): NEVER call workshopContract.lockAndAssertActive
      // because suspended workshops are explicitly permitted to withdraw quotes.
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

      // Optimistic concurrency check on RequestRecipient (BR-27)
      recipient.assertVersionMatches(expectedRecipientVersion);

      // Request & quote state preconditions (BR-15, BR-21, BR-22)
      request.assertNotCancelled();
      if (request.status === 'draft_request' || request.isAcceptedOrBeyond()) {
        throw new InvalidStateTransitionError(
          `Cannot withdraw a quote when QuoteRequest is in "${request.status}" status.`,
          {
            invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
            entity: 'QuoteRequest',
          },
        );
      }

      if (existingQuote === null) {
        throw new InvalidStateTransitionError(
          'Only an active quote can be withdrawn.',
          {
            invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
            entity: 'Quote',
          },
        );
      }

      const now = input.now ?? new Date();
      const withdrawn = existingQuote.withdraw({
        request,
        recipient,
        actorId,
        expectedQuoteVersion,
        withdrawReason: trimmedWithdrawReason,
        now,
      });

      const savedQuote = await this.quoteRepo.update(
        {
          quote: withdrawn.quote,
          expectedVersion: expectedQuoteVersion,
          recipient: withdrawn.recipient,
          recipientHistory: withdrawn.recipientHistory,
        },
        tx,
      );

      let workshopRef: WorkshopRefDto = Object.freeze({
        id: workshopId,
        name: '',
      });
      let workshopIsActive = true;
      if (this.workshopContract) {
        const summary =
          await this.workshopContract.getWorkshopSummary(workshopId);
        if (summary) {
          workshopRef = Object.freeze({
            id: summary.id,
            name: summary.name,
          });
          workshopIsActive = summary.status === 'active';
        }
      }

      const eligibility = savedQuote.evaluateEligibility({
        request,
        workshopIsActive,
        now,
      });
      const ineligibleReasons = Object.freeze([
        ...eligibility.ineligible_reasons,
      ]);

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
        ineligible_reasons: ineligibleReasons,
        created_at: savedQuote.created_at.toISOString(),
        updated_at: savedQuote.updated_at.toISOString(),
      });

      const recipientDto: RecipientDto = Object.freeze({
        id: withdrawn.recipient.id,
        request_id: withdrawn.recipient.request_id,
        workshop: workshopRef,
        response_status: withdrawn.recipient.response_status,
        version: withdrawn.recipient.version,
        sent_at: withdrawn.recipient.sent_at.toISOString(),
        responded_at: withdrawn.recipient.responded_at
          ? withdrawn.recipient.responded_at.toISOString()
          : null,
        decline_reason: withdrawn.recipient.decline_reason,
        eligibility_labels: ineligibleReasons,
      });

      const mutationDto: QuoteMutationDto = Object.freeze({
        quote: quoteDto,
        recipient: recipientDto,
      });

      const currentState: TradingCurrentStateDto = Object.freeze({
        request: Object.freeze({
          id: request.id,
          status: request.status,
          version: request.version,
          cancelled_at: request.cancelled_at
            ? request.cancelled_at.toISOString()
            : null,
        }),
        recipient: Object.freeze({
          id: withdrawn.recipient.id,
          status: withdrawn.recipient.response_status,
          version: withdrawn.recipient.version,
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
      });
    };

    if (input.tx) {
      return runWithTx(input.tx);
    }

    return this.txRunner.run((tx) => runWithTx(tx));
  }
}
