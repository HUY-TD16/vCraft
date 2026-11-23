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
  EntityId,
  type IneligibleQuoteReason,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  MAX_DECLINE_REASON_LENGTH,
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
  RecipientDto,
  TradingCurrentStateDto,
  WorkshopRefDto,
} from '../../dtos/trading-persistence.dtos';

export interface DeclineQuoteRequestInput {
  readonly actor: AuthenticatedActor | TrustedActor;
  readonly requestId?: Id;
  readonly id?: Id;
  readonly expectedRecipientVersion?: number;
  readonly expected_recipient_version?: number;
  readonly declineReason?: string | null;
  readonly decline_reason?: string | null;
  readonly now?: Date;
  readonly tx?: TransactionContext;
}

export interface DeclineQuoteRequestResult {
  readonly recipient: RecipientDto;
  readonly currentState: TradingCurrentStateDto;
}

export class DeclineQuoteRequestUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly recipientRepo: IRequestRecipientRepository,
    private readonly quoteRepo?: IQuoteRepository,
    private readonly workshopContract?: IWorkshopContract,
  ) {}

  async execute(
    input: DeclineQuoteRequestInput,
  ): Promise<DeclineQuoteRequestResult> {
    assertTradingActor(input.actor, {
      expectedRole: 'artisan',
      tempPasswordMessage: 'Temporary password session cannot decline quote requests.',
      roleDeniedMessage: 'Only artisans can decline quote request invitations.',
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

    const rawExpectedVersion =
      input.expectedRecipientVersion ?? input.expected_recipient_version;
    if (rawExpectedVersion === undefined || rawExpectedVersion === null) {
      throw new InvalidTradingInputError(
        'expected_recipient_version is required to decline an invitation.',
        { field: 'expected_recipient_version' },
      );
    }
    const expectedVersion = Version.of(
      rawExpectedVersion,
      'expected_recipient_version',
    ).value;

    const rawReason =
      input.declineReason !== undefined
        ? input.declineReason
        : input.decline_reason;
    if (rawReason !== undefined && rawReason !== null) {
      if (typeof rawReason !== 'string') {
        throw new InvalidTradingInputError('decline_reason must be a string.', {
          field: 'decline_reason',
        });
      }
      if (rawReason.trim().length > MAX_DECLINE_REASON_LENGTH) {
        throw new InvalidTradingInputError(
          `decline_reason cannot exceed ${MAX_DECLINE_REASON_LENGTH} characters.`,
          { field: 'decline_reason' },
        );
      }
    }

    const runWithTx = async (
      tx: TransactionContext,
    ): Promise<DeclineQuoteRequestResult> => {
      // Deterministic lock ordering (BR-27, data-design §4.2):
      // 1. QuoteRequest -> 2. RequestRecipient -> 3. Quote
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

      const existingQuote = this.quoteRepo
        ? await this.quoteRepo.lockByRequestAndWorkshop(
            requestId,
            workshopId,
            tx,
          )
        : null;

      const now = input.now ?? new Date();
      const { recipient: declinedRecipient, history } = recipient.decline({
        actorId,
        expectedVersion,
        reason: rawReason ?? null,
        requestBiddingOpen: request.isBiddingOpenAt(now),
        requestAcceptedOrCancelled:
          request.isCancelled() ||
          request.isAcceptedOrBeyond() ||
          request.status === 'draft_request',
        now,
      });

      // BR-15 defense-in-depth: workshop must never have submitted a quote
      if (existingQuote !== null) {
        throw new InvalidStateTransitionError(
          'Cannot decline invitation after a quote has already been submitted.',
          {
            invariant: TRADING_INVARIANTS.INV_01_STATE_MACHINE_AND_CANCELLATION,
            entity: 'RequestRecipient',
          },
        );
      }

      const savedRecipient = await this.recipientRepo.update(
        {
          recipient: declinedRecipient,
          expectedVersion,
          history,
        },
        tx,
      );

      let workshopRef: WorkshopRefDto = Object.freeze({
        id: workshopId,
        name: '',
      });
      const eligibilityLabels: IneligibleQuoteReason[] = [];

      if (this.workshopContract) {
        const summary =
          await this.workshopContract.getWorkshopSummary(workshopId);
        if (summary) {
          workshopRef = Object.freeze({
            id: summary.id,
            name: summary.name,
          });
          if (summary.status === 'suspended') {
            eligibilityLabels.push('WORKSHOP_SUSPENDED');
          }
        }
      }

      const recipientDto: RecipientDto = Object.freeze({
        id: savedRecipient.id,
        request_id: savedRecipient.request_id,
        workshop: workshopRef,
        response_status: savedRecipient.response_status,
        version: savedRecipient.version,
        sent_at: savedRecipient.sent_at.toISOString(),
        responded_at: savedRecipient.responded_at
          ? savedRecipient.responded_at.toISOString()
          : null,
        decline_reason: savedRecipient.decline_reason,
        eligibility_labels: Object.freeze(eligibilityLabels),
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
          id: savedRecipient.id,
          status: savedRecipient.response_status,
          version: savedRecipient.version,
        }),
      });

      return Object.freeze({
        recipient: recipientDto,
        currentState,
      });
    };

    if (input.tx) {
      return runWithTx(input.tx);
    }

    return this.txRunner.run((tx) => runWithTx(tx));
  }
}
