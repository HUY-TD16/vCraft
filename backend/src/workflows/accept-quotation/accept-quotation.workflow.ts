import type {
  TransactionContext,
  TransactionRunner,
} from '../../common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
  Id,
  TrustedActor,
} from '../../common/application/types/contract-types';
import { BusinessRuleException } from '../../common/domain/errors/business-rule.exception';
import type { IWorkshopContract } from '../../modules/workshops/public/contracts/workshop.contract';
import type {
  AcceptanceCurrentStateDto,
  AcceptanceDto,
  AcceptanceInput,
  AcceptanceOperationDto,
  ITradingContract,
} from '../../modules/trading/public';
import {
  EntityId,
  InvalidTradingInputError,
  TradingDomainError,
  TradingPermissionDeniedError,
  TradingResourceNotFoundError,
  Version,
  validateUuidV4,
} from '../../modules/trading/domain';

export interface AcceptQuotationWorkflowInput {
  readonly actor: TrustedActor | AuthenticatedActor;
  readonly requestId: Id;
  readonly quoteId: Id;
  readonly expectedRequestVersion: number;
  readonly expectedQuoteVersion: number;
  readonly idempotencyKey?: string;
  readonly now?: Date;
  readonly tx?: TransactionContext;
}

export interface AcceptQuotationWorkflowResult {
  readonly data: AcceptanceDto;
  readonly currentState: AcceptanceCurrentStateDto;
  readonly operation?: AcceptanceOperationDto;
}

function isP2002Error(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as Record<string, unknown>;
  if (err.code === 'P2002') {
    return true;
  }
  if (
    typeof err.message === 'string' &&
    (err.message.includes('P2002') ||
      err.message.toLowerCase().includes('unique constraint'))
  ) {
    return true;
  }
  return false;
}

function isConcurrentRaceDomainError(error: unknown): boolean {
  return (
    error instanceof BusinessRuleException &&
    (error.code === 'CONCURRENCY_CONFLICT' ||
      error.code === 'INVALID_STATE' ||
      error.code === 'BIDDING_CLOSED')
  );
}

/**
 * Cross-module workflow coordinating `Trading` (`ITradingContract`) and `Workshops`
 * (`IWorkshopContract`) for direct 100% quote acceptance (`UC-19`, `BR-16`, `BR-20`,
 * `docs/contracts/backend.md`).
 *
 * Enforces deterministic locking order:
 * `Workshop` (`lockAndAssertActive`) -> `QuoteRequest` -> `RequestRecipient` -> `Quote`.
 *
 * Reuses `input.tx` when invoked inside `TradingMutationInterceptor` so no nested
 * transaction is opened.
 */
export class AcceptQuotationWorkflow {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly tradingContract: ITradingContract,
    private readonly workshopContract?: IWorkshopContract,
  ) {}

  async execute(
    input: AcceptQuotationWorkflowInput,
  ): Promise<AcceptQuotationWorkflowResult> {
    if (
      'sessionLevel' in input.actor &&
      input.actor.sessionLevel === 'temp_password'
    ) {
      throw new TradingDomainError(
        'TEMP_PASSWORD_RESTRICTED',
        'Temporary password session cannot accept quotes.',
      );
    }

    if (input.actor.role !== 'buyer') {
      throw new TradingPermissionDeniedError(
        'Only buyers can accept quotes for quote requests.',
      );
    }

    const actorId = EntityId.of(input.actor.accountId, 'accountId').value;

    if (!input.requestId) {
      throw new InvalidTradingInputError('requestId is required.', {
        field: 'requestId',
      });
    }
    if (!input.quoteId) {
      throw new InvalidTradingInputError('quote_id is required.', {
        field: 'quote_id',
      });
    }

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

    let normalizedIdempotencyKey: string | undefined;
    if (input.idempotencyKey !== undefined) {
      if (
        typeof input.idempotencyKey !== 'string' ||
        !validateUuidV4(input.idempotencyKey, { trim: true })
      ) {
        throw new InvalidTradingInputError(
          'Header X-Idempotency-Key must be a valid UUID v4.',
          { field: 'X-Idempotency-Key' },
        );
      }
      normalizedIdempotencyKey = input.idempotencyKey.trim().toLowerCase();
    }

    const workshopContract = this.workshopContract;
    if (!workshopContract) {
      throw new Error(
        'Workshop contract is required for accept-quotation workflow.',
      );
    }

    if (
      normalizedIdempotencyKey === undefined &&
      !this.tradingContract.executeAcceptance
    ) {
      throw new InvalidTradingInputError(
        'Header X-Idempotency-Key must be a valid UUID v4.',
        { field: 'X-Idempotency-Key' },
      );
    }

    const acceptanceInput: AcceptanceInput = {
      requestId,
      expectedRequestVersion,
      actor: {
        ...input.actor,
        accountId: actorId,
      },
      quoteId,
      expectedQuoteVersion,
    };

    const runWithTx = async (
      tx: TransactionContext,
    ): Promise<AcceptQuotationWorkflowResult> => {
      // Step 1: Check idempotency replay whenever idempotencyKey is supplied
      if (normalizedIdempotencyKey !== undefined) {
        const replay = await this.tradingContract.findAcceptanceReplay(
          {
            ...acceptanceInput,
            idempotencyKey: normalizedIdempotencyKey,
          },
          tx,
        );
        if (replay !== null) {
          return {
            data: replay.data,
            currentState: replay.operation.current_state,
            operation: replay.operation,
          };
        }
      }

      // Pre-read without reverse locks to identify target workshop(s)
      const prepared = await this.tradingContract.prepareAcceptance(
        acceptanceInput,
        tx,
      );
      const sortedWorkshopIds = EntityId.sortAscending(
        Array.from(new Set(prepared.workshopIds)),
      );
      if (sortedWorkshopIds.length === 0) {
        throw new TradingResourceNotFoundError('Workshop was not found.', {
          entity: 'Workshop',
        });
      }

      // Step 2: Acquire Workshop lock FIRST in ascending ID order and assert active (fail-closed)
      await workshopContract.lockAndAssertActive(sortedWorkshopIds, tx);

      // Steps 3-7: Acquire Trading locks (QuoteRequest -> RequestRecipient -> Quote),
      // re-verify invariants under lock, create Allocation + audit logs, and persist IdempotencyRecord.
      if (normalizedIdempotencyKey === undefined) {
        const coreResult = await this.tradingContract.executeAcceptance!(
          {
            ...acceptanceInput,
            expectedWorkshopId: sortedWorkshopIds[0],
            now: input.now,
          },
          tx,
        );
        return {
          data: coreResult.data,
          currentState: coreResult.currentState,
        };
      }

      const accepted = await this.tradingContract.accept(
        {
          ...acceptanceInput,
          idempotencyKey: normalizedIdempotencyKey,
        },
        tx,
        {
          expectedWorkshopId: sortedWorkshopIds[0],
          now: input.now,
        },
      );

      return {
        data: accepted.data,
        currentState: accepted.operation.current_state,
        operation: accepted.operation,
      };
    };

    if (input.tx) {
      return runWithTx(input.tx);
    }

    try {
      // Step 8: Commit transaction
      return await this.txRunner.run((tx) => runWithTx(tx));
    } catch (error: unknown) {
      if (
        normalizedIdempotencyKey !== undefined &&
        (isP2002Error(error) || isConcurrentRaceDomainError(error))
      ) {
        const replay = await this.txRunner.run((replayTx) =>
          this.tradingContract.findAcceptanceReplay(
            {
              ...acceptanceInput,
              idempotencyKey: normalizedIdempotencyKey,
            },
            replayTx,
          ),
        );
        if (replay !== null) {
          return {
            data: replay.data,
            currentState: replay.operation.current_state,
            operation: replay.operation,
          };
        }
      }

      throw error;
    }
  }
}
