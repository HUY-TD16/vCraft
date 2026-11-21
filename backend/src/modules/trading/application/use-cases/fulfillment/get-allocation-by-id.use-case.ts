import { assertTradingNormalSession } from '../../helpers/trading-actor.helper';
import type {
  TransactionContext,
  TransactionRunner,
} from '../../../../../common/application/ports/transaction-runner';
import type {
  AuthenticatedActor,
  Id,
} from '../../../../../common/application/types/contract-types';
import {
  AllocationNotFoundError,
  EntityId,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../domain';
import type { AllocationDetailDto } from '../../dtos/trading-persistence.dtos';
import type { IAllocationRepository } from '../../ports/repositories/trading-repositories.port';

export interface GetAllocationByIdCommand {
  readonly actor: AuthenticatedActor;
  readonly id: string;
  readonly tx?: TransactionContext;
}

/**
 * Use Case UC-23 (`BR-04`, `BR-05`, `BR-20`, `BR-24`, `SEC-05`, `SEC-06`):
 * Retrieves the detailed view of a specific Allocation by its ID (`GET /api/v1/allocations/:id`).
 * - Authorized principals: owning Artisan (`allocation.workshop.id === actor.workshopId`),
 *   owning Buyer (`requestBuyerId === actor.accountId`), and Admin.
 * - Unlocks full Buyer recipient contact and delivery address (`recipient_name`,
 *   `recipient_phone`, `delivery_address`) for the owning Artisan (as well as owning Buyer and Admin),
 *   retaining access across suspended workshops (`BR-05`) and completed/cancelled requests (`BR-04`).
 * - Anti-IDOR (`SEC-06`): non-owner Buyer, other/unassigned Artisan, and missing IDs all fail
 *   with `AllocationNotFoundError` (HTTP 404 `RESOURCE_NOT_FOUND`) without leaking any contact fields.
 */
export class GetAllocationByIdUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly allocationRepo: IAllocationRepository,
  ) {}

  async execute(
    command: GetAllocationByIdCommand,
  ): Promise<AllocationDetailDto> {
    // 1. Enforce normal session level (SEC-05)
    assertTradingNormalSession(
      command.actor,
      'Temporary password session cannot access allocation details.',
    );

    // 2. Validate path :id (positive 64-bit decimal integer)
    const allocationId = EntityId.of(command.id, 'id').value;

    // 3. Pre-query actor role and workshop check (SEC-06)
    let artisanWorkshopId: Id | undefined;
    if (command.actor.role === 'artisan') {
      if (!command.actor.workshopId) {
        throw new TradingPermissionDeniedError(
          'Artisan actor must belong to a workshop.',
        );
      }
      artisanWorkshopId = EntityId.of(
        command.actor.workshopId,
        'workshopId',
      ).value;
    } else if (
      command.actor.role !== 'admin' &&
      command.actor.role !== 'buyer'
    ) {
      throw new TradingPermissionDeniedError('Unauthorized trading role.');
    }

    // 4. Load Allocation + Buyer request ownership & contact projection
    const detail = command.tx
      ? await this.allocationRepo.findDetailById(allocationId, command.tx)
      : await this.txRunner.run(async (tx: TransactionContext) => {
          return this.allocationRepo.findDetailById(allocationId, tx);
        });

    if (!detail) {
      throw new AllocationNotFoundError('Allocation was not found.');
    }

    // 5. Enforce ownership & anti-IDOR visibility (BR-04, BR-05, SEC-06)
    if (command.actor.role === 'buyer') {
      if (detail.requestBuyerId !== command.actor.accountId) {
        throw new AllocationNotFoundError('Allocation was not found.');
      }
    } else if (command.actor.role === 'artisan') {
      if (detail.allocation.workshop.id !== artisanWorkshopId) {
        throw new AllocationNotFoundError('Allocation was not found.');
      }
    }

    // 6. Return frozen AllocationDetailDto without leaking internal buyer_id
    return Object.freeze({
      ...detail.allocation,
      recipient_name: detail.recipientName,
      recipient_phone: detail.recipientPhone,
      delivery_address: detail.deliveryAddress,
    });
  }
}
