import type {
  TransactionContext,
  TransactionRunner,
} from '../../common/application/ports/transaction-runner';
import type {
  Id,
  TrustedActor,
} from '../../common/application/types/contract-types';
import type { ICatalogContract } from '../../modules/catalog/public/contracts/catalog.contract';
import type { IWorkshopContract } from '../../modules/workshops/public/contracts/workshop.contract';
import type {
  IQuoteRequestRepository,
  IRequestRecipientRepository,
} from '../../modules/trading/application/ports/repositories/trading-repositories.port';
import {
  ConcurrencyConflictError,
  EntityId,
  InvalidTradingInputError,
  NoEligibleWorkshopError,
  QuoteRequest,
  QuoteRequestNotFoundError,
  TRADING_INVARIANTS,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../modules/trading/domain';

export interface SendQuoteRequestInput {
  readonly actor: TrustedActor;
  readonly requestId?: Id;
  readonly id?: Id;
  readonly expectedRequestVersion?: number;
  readonly expected_request_version?: number;
  readonly now?: Date;
  readonly tx?: TransactionContext;
}

export class SendRequestWorkflow {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly quoteRequestRepo: IQuoteRequestRepository,
    private readonly recipientRepo: IRequestRecipientRepository,
    private readonly catalogContract?: ICatalogContract,
    private readonly workshopContract?: IWorkshopContract,
  ) {}

  async execute(input: SendQuoteRequestInput): Promise<QuoteRequest> {
    if (
      'sessionLevel' in input.actor &&
      input.actor.sessionLevel === 'temp_password'
    ) {
      throw new TradingDomainError(
        'TEMP_PASSWORD_RESTRICTED',
        'Temporary password session cannot send quote requests.',
      );
    }

    if (input.actor.role !== 'buyer') {
      throw new TradingPermissionDeniedError('Only buyers can send quote requests.');
    }

    const requestId = input.requestId ?? input.id;
    if (!requestId) {
      throw new InvalidTradingInputError('requestId is required.', {
        field: 'requestId',
      });
    }

    const expectedVersion =
      input.expectedRequestVersion ?? input.expected_request_version;
    if (expectedVersion === undefined || expectedVersion === null) {
      throw new InvalidTradingInputError(
        'expected_request_version is required for sending a quote request.',
        { field: 'expected_request_version' },
      );
    }

    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new InvalidTradingInputError(
        'expected_request_version must be a positive integer.',
        { field: 'expected_request_version' },
      );
    }

    const runWithTx = async (tx: TransactionContext): Promise<QuoteRequest> => {
      // Step 1: Read draft snapshot. Call catalogContract.findEligibleWorkshopIds({ categoryId: draft.category_id }, tx).
      // If empty [], throw NoEligibleWorkshopError (code NO_ELIGIBLE_WORKSHOP, status 422). Keep draft untouched.
      const draft = await this.quoteRequestRepo.findById(requestId, tx);
      if (!draft) {
        throw new QuoteRequestNotFoundError(
          `QuoteRequest ${requestId} was not found.`,
          { entity: 'QuoteRequest', id: requestId },
        );
      }

      draft.assertOwner(input.actor.accountId);

      if (!draft.category_id) {
        throw new InvalidTradingInputError(
          'category_id is required before sending a QuoteRequest.',
          { field: 'category_id' },
        );
      }

      if (!this.catalogContract) {
        throw new Error('Catalog contract is required for send-request workflow.');
      }
      if (!this.workshopContract) {
        throw new Error('Workshop contract is required for send-request workflow.');
      }

      const eligibleWorkshopIds = await this.catalogContract.findEligibleWorkshopIds(
        { categoryId: draft.category_id },
        tx,
      );

      if (!eligibleWorkshopIds || eligibleWorkshopIds.length === 0) {
        throw new NoEligibleWorkshopError(
          'Cannot send QuoteRequest because there are no active public workshops with published products for this category.',
          {
            invariant: TRADING_INVARIANTS.INV_02_DEADLINES_AND_BIDDING_WINDOW,
            entity: 'QuoteRequest',
          },
        );
      }

      // Step 2: Sort workshop IDs ascending (EntityId.sortAscending). Call workshopContract.lockAndAssertActive(sortedIds, tx).
      const sortedWorkshopIds = EntityId.sortAscending(
        Array.from(new Set(eligibleWorkshopIds)),
      );
      await this.workshopContract.lockAndAssertActive(sortedWorkshopIds, tx);

      // Step 3: Call quoteRequestRepo.lockById(requestId, tx).
      const lockedRequest = await this.quoteRequestRepo.lockById(requestId, tx);
      if (!lockedRequest) {
        throw new QuoteRequestNotFoundError(
          `QuoteRequest ${requestId} was not found.`,
          { entity: 'QuoteRequest', id: requestId },
        );
      }

      lockedRequest.assertOwner(input.actor.accountId);

      if (!lockedRequest.category_id) {
        throw new InvalidTradingInputError(
          'category_id is required before sending a QuoteRequest.',
          { field: 'category_id' },
        );
      }

      if (lockedRequest.category_id !== draft.category_id) {
        throw new ConcurrencyConflictError(
          'QuoteRequest category_id changed concurrently while acquiring locks.',
          {
            invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
            entity: 'QuoteRequest',
          },
        );
      }

      // Step 4: Call catalogContract.assertEligibleWorkshops({ categoryId: locked.category_id!, workshopIds: sortedIds }, tx).
      await this.catalogContract.assertEligibleWorkshops(
        {
          categoryId: lockedRequest.category_id,
          workshopIds: sortedWorkshopIds,
        },
        tx,
      );

      // Step 5: Call domain entity locked.sendToArtisans({ buyerId, expectedVersion, eligibleWorkshopIds: sortedIds, now }).
      // Update quoteRequest in repo with new status, version, and statusLog ('sent').
      // Create RequestRecipient records in requestRecipientRepo for each workshop (response_status: 'pending', sent_at: now).
      const now = input.now ?? new Date();
      const { request: updated, statusLog, recipientWorkshopIds } =
        lockedRequest.sendToArtisans({
          buyerId: input.actor.accountId,
          expectedVersion,
          eligibleWorkshopIds: sortedWorkshopIds,
          now,
        });

      const saved = await this.quoteRequestRepo.update(
        {
          request: updated,
          expectedVersion,
          statusLogs: [statusLog],
        },
        tx,
      );

      await this.recipientRepo.createMany(
        recipientWorkshopIds.map((workshopId) => ({
          request_id: updated.id,
          workshop_id: workshopId,
          sent_at: now,
        })),
        tx,
      );

      return saved;
    };

    if (input.tx) {
      return runWithTx(input.tx);
    }

    return this.txRunner.run((tx) => runWithTx(tx));
  }
}
