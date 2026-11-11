import {
  ConcurrencyConflictError,
  InvalidTradingInputError,
  TRADING_INVARIANTS,
} from '../errors/trading-domain.errors';
import { EntityId } from './entity-id';

const MAX_INT32 = 2147483647;

export type ProposalExpectation =
  | { readonly expected_proposal_id: null; readonly expected_proposal_version: null }
  | { readonly expected_proposal_id: string; readonly expected_proposal_version: number };

export class Version {
  readonly value: number;

  private constructor(value: number) {
    this.value = value;
    Object.freeze(this);
  }

  static initial(): Version {
    return new Version(1);
  }

  static of(value: number, fieldName: string = 'version'): Version {
    if (!Number.isInteger(value) || value < 1 || value > MAX_INT32) {
      throw new InvalidTradingInputError(
        `${fieldName} must be an integer between 1 and ${MAX_INT32}.`,
        { field: fieldName },
      );
    }
    return new Version(value);
  }

  next(): Version {
    if (this.value >= MAX_INT32) {
      throw new InvalidTradingInputError('Version overflow beyond 32-bit signed integer limit.', {
        field: 'version',
      });
    }
    return new Version(this.value + 1);
  }

  equals(other: Version | number): boolean {
    const otherValue = typeof other === 'number' ? other : other.value;
    return this.value === otherValue;
  }

  assertMatches(expected: Version | number, entityName: string = 'Entity'): void {
    const expectedVersion =
      expected instanceof Version ? expected : Version.of(expected, 'expected_version');
    if (this.value !== expectedVersion.value) {
      throw new ConcurrencyConflictError(
        `${entityName} version mismatch: expected ${expectedVersion.value}, actual ${this.value}.`,
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: entityName,
        },
      );
    }
  }
}

export class ProposalExpectationVO {
  readonly expectedProposalId: string | null;
  readonly expectedProposalVersion: number | null;

  private constructor(
    expectedProposalId: string | null,
    expectedProposalVersion: number | null,
  ) {
    this.expectedProposalId = expectedProposalId;
    this.expectedProposalVersion = expectedProposalVersion;
    Object.freeze(this);
  }

  static of(expectation: ProposalExpectation): ProposalExpectationVO {
    const { expected_proposal_id, expected_proposal_version } = expectation;
    if (expected_proposal_id === null && expected_proposal_version === null) {
      return new ProposalExpectationVO(null, null);
    }
    if (expected_proposal_id === null || expected_proposal_version === null) {
      throw new InvalidTradingInputError(
        'expected_proposal_id and expected_proposal_version must either both be null or both be provided.',
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          field: 'expected_proposal_id',
        },
      );
    }

    const id = EntityId.of(expected_proposal_id, 'expected_proposal_id').value;
    const version = Version.of(expected_proposal_version, 'expected_proposal_version').value;
    return new ProposalExpectationVO(id, version);
  }

  assertMatchesCurrent(
    currentProposal: { readonly id: string; readonly version: number } | null,
  ): void {
    if (this.expectedProposalId === null && this.expectedProposalVersion === null) {
      if (currentProposal !== null) {
        throw new ConcurrencyConflictError(
          `Expected no active SplitProposal, but found proposal ${currentProposal.id} (v${currentProposal.version}).`,
          {
            invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
            entity: 'SplitProposal',
          },
        );
      }
      return;
    }

    if (
      currentProposal === null ||
      currentProposal.id !== this.expectedProposalId ||
      currentProposal.version !== this.expectedProposalVersion
    ) {
      throw new ConcurrencyConflictError(
        'Current SplitProposal does not match expected_proposal_id and expected_proposal_version.',
        {
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          entity: 'SplitProposal',
        },
      );
    }
  }
}
