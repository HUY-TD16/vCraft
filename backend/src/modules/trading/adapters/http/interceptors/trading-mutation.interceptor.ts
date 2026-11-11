import {
  Injectable,
  Inject,
  Optional,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { of, firstValueFrom, type Observable } from 'rxjs';
import { HttpResult } from '../../../../../common/http/interceptors/response-envelope.interceptor';
import { authenticatedActors } from '../../../../../common/security/guards/authenticated-request';
import type { Id } from '../../../../../common/application/types/contract-types';
import type { TransactionContext } from '../../../../../common/application/ports/transaction-runner';
import {
  EntityId,
  InvalidTradingInputError,
  TradingPermissionDeniedError,
  TRADING_INVARIANTS,
} from '../../../domain';
import { validateUuidV4 } from '../../../domain/utilities';
import { TradingIdempotencyService } from '../../../application/services/trading-idempotency.service';
import type { TradingCurrentStateDto } from '../../../application/dtos/trading-persistence.dtos';
import {
  TRADING_MUTATION_METADATA_KEY,
  TRADING_MUTATION_METADATA,
  TRADING_TX_REQUEST_KEY,
  type TradingMutationOptions,
} from '../decorators/trading-mutation.decorator';
import {
  TRADING_CURRENT_STATE_RESOLVER,
  type ITradingCurrentStateResolver,
} from './trading-current-state.resolver';

export {
  TRADING_MUTATION_METADATA_KEY,
  TRADING_MUTATION_METADATA,
  TRADING_TX_REQUEST_KEY,
  type TradingMutationOptions,
};

export interface HandlerMutationResult<T = unknown> {
  readonly result?: T;
  readonly data?: T;
  readonly currentState?: TradingCurrentStateDto;
}

@Injectable()
export class TradingMutationInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotencyService: TradingIdempotencyService,
    @Optional()
    @Inject(TRADING_CURRENT_STATE_RESOLVER)
    private readonly stateResolver?: ITradingCurrentStateResolver,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const options =
      this.reflector.getAllAndOverride<TradingMutationOptions>(
        TRADING_MUTATION_METADATA_KEY,
        [context.getHandler(), context.getClass()],
      ) ??
      this.reflector.getAllAndOverride<TradingMutationOptions>(
        'trading:mutation',
        [context.getHandler(), context.getClass()],
      );

    // 1. If route handler is not decorated with @TradingMutation, pass through directly
    if (!options) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<
      Request & { [TRADING_TX_REQUEST_KEY]?: TransactionContext }
    >();
    const res = http.getResponse<Response>();

    // 2. Extract and validate X-Idempotency-Key (RFC 4122 UUID v4)
    const rawHeader =
      req.headers?.['x-idempotency-key'] ??
      (typeof req.get === 'function' ? req.get('x-idempotency-key') : undefined);
    const headerVal = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (typeof headerVal !== 'string' || !validateUuidV4(headerVal, { trim: true })) {
      throw new InvalidTradingInputError(
        'Header X-Idempotency-Key must be a valid UUID v4.',
        {
          field: 'X-Idempotency-Key',
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
        },
      );
    }
    const normalizedKey = headerVal.trim().toLowerCase();

    // 3. Extract actor account ID
    const actor = authenticatedActors.get(req);
    const rawAccountId =
      actor?.accountId ??
      (req as any).user?.accountId ??
      (req as any).user?.id ??
      (req as any).actor?.accountId;

    if (
      rawAccountId === undefined ||
      rawAccountId === null ||
      String(rawAccountId).trim().length === 0
    ) {
      throw new TradingPermissionDeniedError(
        'Authenticated actor is required to execute trading mutations.',
        {
          field: 'account_id',
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
        },
      );
    }
    const account_id = EntityId.of(rawAccountId, 'account_id').value;

    // 4. Extract target object ID
    const object_id = this.extractObjectId(req, options);

    // 5. Pre-validate expected_*_version presence and type in request body
    this.validateExpectedVersions(req.body, options);

    // 6. Delegate execution to TradingIdempotencyService
    const result = await this.executeMutationPipeline({
      req,
      res,
      next,
      options,
      account_id,
      object_id,
      idempotencyKey: normalizedKey,
    });

    return of(result);
  }

  private async executeMutationPipeline(params: {
    readonly req: Request & { [TRADING_TX_REQUEST_KEY]?: TransactionContext };
    readonly res: Response;
    readonly next: CallHandler;
    readonly options: TradingMutationOptions;
    readonly account_id: Id;
    readonly object_id: Id;
    readonly idempotencyKey: string;
  }): Promise<HttpResult<unknown, TradingCurrentStateDto>> {
    const { req, res, next, options, account_id, object_id, idempotencyKey } = params;

    const payload = req.body ?? {};

    const executionResult = await this.idempotencyService.executeWithIdempotency<
      unknown,
      TradingCurrentStateDto
    >({
      accountId: account_id,
      account_id,
      action: options.action,
      objectType: options.objectType,
      object_type: options.objectType,
      objectId: object_id,
      object_id,
      idempotencyKey,
      idempotency_key: idempotencyKey,
      payload,
      ttlHours: options.ttlHours,

      // Query fresh state for fast replay
      getCurrentState: async (tx: TransactionContext) => {
        if (this.stateResolver) {
          return this.stateResolver.resolveCurrentState(
            options.objectType,
            object_id,
            tx,
          );
        }
        return {
          request: {
            id: object_id,
            status: 'draft_request',
            version: 1,
            cancelled_at: null,
          },
        } as TradingCurrentStateDto;
      },

      // Atomic transactional execution with route handler
      execute: async (tx: TransactionContext) => {
        req[TRADING_TX_REQUEST_KEY] = tx;

        try {
          const handlerOutput = await firstValueFrom(next.handle());

          // Extract mutation result and optional currentState from handler
          let resultData: unknown = handlerOutput;
          let explicitCurrentState: TradingCurrentStateDto | undefined = undefined;

          if (handlerOutput instanceof HttpResult) {
            resultData = handlerOutput.data;
            explicitCurrentState = (handlerOutput.metadata as any)?.operation
              ?.current_state;
          } else if (
            handlerOutput &&
            typeof handlerOutput === 'object' &&
            ('data' in handlerOutput || 'result' in handlerOutput)
          ) {
            const typedOutput = handlerOutput as HandlerMutationResult;
            resultData =
              typedOutput.data !== undefined ? typedOutput.data : typedOutput.result;
            explicitCurrentState = typedOutput.currentState;
          }

          const handlerObj =
            handlerOutput && typeof handlerOutput === 'object'
              ? (handlerOutput as Record<string, any>)
              : {};
          const fallbackStatus =
            handlerObj.request_status ?? handlerObj.status ?? 'draft_request';
          const fallbackVersion =
            handlerObj.request_version ?? handlerObj.version ?? 1;
          const fallbackId = handlerObj.request_id ?? handlerObj.id ?? object_id;
          const fallbackCancelledAt = handlerObj.cancelled_at ?? null;

          const currentState =
            explicitCurrentState ??
            (this.stateResolver
              ? await this.stateResolver.resolveCurrentState(
                  options.objectType,
                  object_id,
                  tx,
                )
              : ({
                  request: {
                    id: fallbackId,
                    status: fallbackStatus,
                    version: fallbackVersion,
                    cancelled_at: fallbackCancelledAt,
                  },
                } as TradingCurrentStateDto));

          return {
            result: resultData ?? null,
            currentState,
          };
        } finally {
          delete req[TRADING_TX_REQUEST_KEY];
        }
      },
    });

    // Handle HTTP 204 No Content (e.g. draft deletion)
    if (res?.statusCode === 204) {
      return new HttpResult(undefined, {
        operation: executionResult.operation,
      });
    }

    // Wrap into HttpResult for ResponseEnvelopeInterceptor
    return new HttpResult(executionResult.data, {
      operation: executionResult.operation,
    });
  }

  private extractObjectId(req: Request, options: TradingMutationOptions): Id {
    if (typeof options.objectIdSource === 'function') {
      const customId = options.objectIdSource(req);
      return EntityId.of(customId, 'object_id').value;
    }

    if (options.objectIdSource === 'body' || options.objectIdBodyField) {
      const bodyField = options.objectIdBodyField ?? options.objectIdParam ?? 'id';
      const rawBodyVal = req.body?.[bodyField];
      const bodyVal = Array.isArray(rawBodyVal) ? rawBodyVal[0] : rawBodyVal;
      if (
        bodyVal === undefined ||
        bodyVal === null ||
        String(bodyVal).trim().length === 0
      ) {
        throw new InvalidTradingInputError(
          `Field '${bodyField}' is required in body to identify the target object.`,
          {
            field: bodyField,
            invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          },
        );
      }
      return EntityId.of(bodyVal, bodyField).value;
    }

    const paramName = options.objectIdParam ?? 'id';
    const rawParamVal =
      req.params?.[paramName] ?? req.body?.[paramName] ?? req.body?.object_id;
    const paramVal = Array.isArray(rawParamVal) ? rawParamVal[0] : rawParamVal;
    if (
      paramVal === undefined ||
      paramVal === null ||
      String(paramVal).trim().length === 0
    ) {
      throw new InvalidTradingInputError(
        `Route parameter '${paramName}' is required to identify the target object.`,
        {
          field: paramName,
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
        },
      );
    }
    return EntityId.of(paramVal, paramName).value;
  }

  private validateExpectedVersions(
    body: unknown,
    options: TradingMutationOptions,
  ): void {
    const rawFields = options.expectedVersionFields ?? options.expectedVersionField;
    const versionFields: readonly string[] = Array.isArray(rawFields)
      ? rawFields
      : rawFields
        ? [rawFields]
        : [];

    if (versionFields.length === 0) {
      return;
    }

    if (body === null || body === undefined || typeof body !== 'object') {
      throw new InvalidTradingInputError(
        'Request body must be a valid JSON object containing expected version fields.',
        {
          field: 'body',
          invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
        },
      );
    }

    const bodyRecord = body as Record<string, unknown>;
    const allowNullable = new Set(options.allowNullableVersion ?? []);
    if (options.allowNullVersion) {
      for (const field of versionFields) {
        allowNullable.add(field);
      }
    }

    for (const field of versionFields) {
      if (!Object.prototype.hasOwnProperty.call(bodyRecord, field)) {
        throw new InvalidTradingInputError(
          `Field '${field}' is required for optimistic concurrency verification.`,
          {
            field,
            invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          },
        );
      }

      const val = bodyRecord[field];

      if (val === null) {
        if (allowNullable.has(field)) {
          continue;
        }
        throw new InvalidTradingInputError(
          `Field '${field}' cannot be null for this operation.`,
          {
            field,
            invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          },
        );
      }

      if (
        typeof val !== 'number' ||
        !Number.isInteger(val) ||
        Number.isNaN(val) ||
        val <= 0 ||
        val > 2147483647
      ) {
        throw new InvalidTradingInputError(
          `Field '${field}' must be a positive integer version.`,
          {
            field,
            value: String(val),
            invariant: TRADING_INVARIANTS.INV_05_CONCURRENCY_AND_IDEMPOTENCY,
          },
        );
      }
    }
  }
}
