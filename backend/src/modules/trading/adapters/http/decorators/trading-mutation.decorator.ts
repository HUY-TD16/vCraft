import {
  SetMetadata,
  createParamDecorator,
  type CustomDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import type { Id } from '../../../../../common/application/types/contract-types';

export const TRADING_MUTATION_METADATA_KEY = 'trading:mutation';
export const TRADING_MUTATION_METADATA = TRADING_MUTATION_METADATA_KEY;
export const TRADING_TX_REQUEST_KEY = Symbol('TRADING_TX_REQUEST_KEY');

export interface TradingMutationOptions {
  /**
   * Business action name (e.g. 'accept_quote', 'cancel', 'submit_quote', 'handover_allocation').
   */
  readonly action: string;

  /**
   * Target domain entity type (e.g. 'QuoteRequest', 'Allocation', 'Quote').
   */
  readonly objectType: string;

  /**
   * Parameter key in req.params or req.body representing the target object ID.
   * Defaults to 'id' (extracted from req.params.id).
   */
  readonly objectIdParam?: string;

  /**
   * Field name in req.body representing the target object ID (alias for objectIdSource: 'body').
   */
  readonly objectIdBodyField?: string;

  /**
   * Extraction source for target object ID: 'param' | 'body' | custom extractor function.
   * Defaults to 'param'.
   */
  readonly objectIdSource?: 'param' | 'body' | ((req: Request) => Id);

  /**
   * Expected version field name(s) in req.body for optimistic concurrency verification.
   * e.g. 'expected_request_version' or ['expected_request_version', 'expected_quote_version'].
   */
  readonly expectedVersionField?: string | readonly string[];

  /**
   * Plural alias for expectedVersionField.
   */
  readonly expectedVersionFields?: readonly string[];

  /**
   * List of version fields allowed to be null on initial execution.
   * e.g. ['expected_quote_version'] on initial quote submission.
   */
  readonly allowNullableVersion?: readonly string[];

  /**
   * Boolean flag allowing the expectedVersionField to be null (e.g. on initial submission).
   */
  readonly allowNullVersion?: boolean;

  /**
   * Custom TTL duration in hours for idempotency record persistence (defaults to 24).
   */
  readonly ttlHours?: number;
}

/**
 * Method decorator declaring trading mutation metadata for idempotency and optimistic concurrency.
 */
export function TradingMutation(
  options: TradingMutationOptions,
): CustomDecorator<string> {
  return SetMetadata(TRADING_MUTATION_METADATA_KEY, Object.freeze({ ...options }));
}

/**
 * Parameter decorator extracting the validated X-Idempotency-Key UUID v4 string from the request.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const req = context.switchToHttp().getRequest<Request>();
    const rawKey = req.headers['x-idempotency-key'] ?? req.get?.('x-idempotency-key');
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey ?? '';
    return key.trim().toLowerCase();
  },
);

/**
 * Parameter decorator extracting the active transactional context managed by TradingMutationInterceptor.
 */
export const TradingTx = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TransactionContext => {
    const req = context
      .switchToHttp()
      .getRequest<Request & { [TRADING_TX_REQUEST_KEY]?: TransactionContext }>();
    const tx = req[TRADING_TX_REQUEST_KEY];
    if (!tx) {
      throw new Error(
        'TradingTx decorator invoked outside an active TradingMutation transactional context.',
      );
    }
    return tx;
  },
);
