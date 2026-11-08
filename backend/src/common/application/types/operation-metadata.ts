import type { Id, Instant } from './contract-types';

export interface OperationMetadata<TState> {
  readonly id: Id;
  readonly replayed: boolean;
  readonly committed_at: Instant;
  readonly current_state: TState;
}
