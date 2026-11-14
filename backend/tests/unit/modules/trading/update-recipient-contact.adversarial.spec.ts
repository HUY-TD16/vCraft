import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';
import { UpdateRecipientContactUseCase } from '../../../../src/modules/trading/application/use-cases/requests/update-recipient-contact.use-case';
import {
  ConcurrencyConflictError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  QuoteRequest,
  type QuoteRequestProps,
  TradingPermissionDeniedError,
  QuoteRequestNotFoundError,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';

const buyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-1',
  sessionLevel: 'normal',
});

function createSampleSentQuoteRequest(
  overrides: Partial<QuoteRequestProps> = {},
): QuoteRequest {
  const now = new Date('2026-11-10T10:00:00.000Z');
  return QuoteRequest.reconstitute({
    id: '100',
    buyer_id: '10',
    category_id: '1',
    spec: 'Bat Trang Glazed Tea Set Spec',
    quantity: 100,
    unit: 'piece',
    unit_set_description: null,
    status: 'sent_to_artisans',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'HN',
    delivery_address: '123 Craft St',
    recipient_name: 'Nguyen Van An',
    recipient_phone: '0987654321',
    bidding_deadline: new Date('2026-12-01T10:00:00.000Z'),
    delivery_deadline: new Date('2026-12-15T10:00:00.000Z'),
    bidding_closed_at: null,
    split_requested_at: null,
    version: 1,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

describe('Task 8 Adversarial & Stress Testing: UpdateRecipientContact', () => {
  it('ADV-01: handles boundary length for recipient_name (exact 200 characters) and recipient_phone (exact 20 characters)', async () => {
    const txRunner = new MockTransactionRunner();
    const existing = createSampleSentQuoteRequest({ version: 1 });
    let savedRequest: QuoteRequest | null = null;
    let savedHistory: any = null;

    const singleRepo = {
      lockById: vi.fn().mockResolvedValue(existing),
      update: vi.fn().mockImplementation(async ({ request, contactEditHistory }) => {
        savedRequest = request;
        savedHistory = contactEditHistory;
        return request;
      }),
    };

    const useCase = new UpdateRecipientContactUseCase(
      txRunner as any,
      singleRepo as any,
    );

    const boundaryName = 'A'.repeat(200);
    const boundaryPhone = '+84 987 654 321 00'; // 18 chars <= 20

    const result = await useCase.execute({
      actor: buyerActor,
      requestId: '100',
      expectedRequestVersion: 1,
      recipientName: boundaryName,
      recipientPhone: boundaryPhone,
    });

    expect(result.recipient_name).toBe(boundaryName);
    expect(result.recipient_phone).toBe(boundaryPhone);
    expect(result.version).toBe(2);
    expect(savedHistory.new_recipient_name).toBe(boundaryName);
    expect(savedHistory.new_recipient_phone).toBe(boundaryPhone);
  });

  it('ADV-02: rejects recipient_name exceeding 200 characters with InvalidTradingInputError', async () => {
    const txRunner = new MockTransactionRunner();
    const existing = createSampleSentQuoteRequest({ version: 1 });
    const singleRepo = {
      lockById: vi.fn().mockResolvedValue(existing),
      update: vi.fn(),
    };

    const useCase = new UpdateRecipientContactUseCase(
      txRunner as any,
      singleRepo as any,
    );

    const tooLongName = 'A'.repeat(201);

    await expect(
      useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
        recipientName: tooLongName,
      }),
    ).rejects.toThrow(InvalidTradingInputError);

    expect(singleRepo.update).not.toHaveBeenCalled();
  });

  it('ADV-03: rejects recipient_phone exceeding 20 characters with InvalidTradingInputError', async () => {
    const txRunner = new MockTransactionRunner();
    const existing = createSampleSentQuoteRequest({ version: 1 });
    const singleRepo = {
      lockById: vi.fn().mockResolvedValue(existing),
      update: vi.fn(),
    };

    const useCase = new UpdateRecipientContactUseCase(
      txRunner as any,
      singleRepo as any,
    );

    const tooLongPhone = '123456789012345678901'; // 21 chars

    await expect(
      useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
        recipientPhone: tooLongPhone,
      }),
    ).rejects.toThrow(InvalidTradingInputError);

    expect(singleRepo.update).not.toHaveBeenCalled();
  });

  it('ADV-04: preserves complex Vietnamese diacritics and Unicode characters correctly', async () => {
    const txRunner = new MockTransactionRunner();
    const existing = createSampleSentQuoteRequest({ version: 1 });
    let savedHistory: any = null;

    const singleRepo = {
      lockById: vi.fn().mockResolvedValue(existing),
      update: vi.fn().mockImplementation(async ({ request, contactEditHistory }) => {
        savedHistory = contactEditHistory;
        return request;
      }),
    };

    const useCase = new UpdateRecipientContactUseCase(
      txRunner as any,
      singleRepo as any,
    );

    const vietnameseName = 'Bà Nguyễn Thị Quỳnh Như (Công ty Gốm Sứ Bát Tràng)';
    const formattedPhone = '(+84) 98-765-4321';

    const result = await useCase.execute({
      actor: buyerActor,
      requestId: '100',
      expectedRequestVersion: 1,
      recipientName: vietnameseName,
      recipientPhone: formattedPhone,
    });

    expect(result.recipient_name).toBe(vietnameseName);
    expect(result.recipient_phone).toBe(formattedPhone);
    expect(savedHistory.new_recipient_name).toBe(vietnameseName);
    expect(savedHistory.new_recipient_phone).toBe(formattedPhone);
  });

  it('ADV-05: handles successive contact edits correctly across multiple versions (v1 -> v2 -> v3)', async () => {
    const txRunner = new MockTransactionRunner();
    let current = createSampleSentQuoteRequest({ version: 1, recipient_name: 'Contact V1' });
    const histories: any[] = [];

    const singleRepo = {
      lockById: vi.fn().mockImplementation(async () => current),
      update: vi.fn().mockImplementation(async ({ request, contactEditHistory }) => {
        current = request;
        histories.push(contactEditHistory);
        return request;
      }),
    };

    const useCase = new UpdateRecipientContactUseCase(
      txRunner as any,
      singleRepo as any,
    );

    // Edit 1: v1 -> v2
    const v2 = await useCase.execute({
      actor: buyerActor,
      requestId: '100',
      expectedRequestVersion: 1,
      recipientName: 'Contact V2',
    });
    expect(v2.version).toBe(2);
    expect(v2.recipient_name).toBe('Contact V2');

    // Edit 2: v2 -> v3
    const v3 = await useCase.execute({
      actor: buyerActor,
      requestId: '100',
      expectedRequestVersion: 2,
      recipientPhone: '0999888777',
    });
    expect(v3.version).toBe(3);
    expect(v3.recipient_name).toBe('Contact V2');
    expect(v3.recipient_phone).toBe('0999888777');

    expect(histories).toHaveLength(2);
    expect(histories[0].prev_recipient_name).toBe('Contact V1');
    expect(histories[0].new_recipient_name).toBe('Contact V2');
    expect(histories[0].version).toBe(2);

    expect(histories[1].prev_recipient_name).toBe('Contact V2');
    expect(histories[1].new_recipient_name).toBe('Contact V2');
    expect(histories[1].prev_recipient_phone).toBe('0987654321');
    expect(histories[1].new_recipient_phone).toBe('0999888777');
    expect(histories[1].version).toBe(3);
  });

  it('ADV-06: rejects concurrent update when repository throws ConcurrencyConflictError during update', async () => {
    const txRunner = new MockTransactionRunner();
    const existing = createSampleSentQuoteRequest({ version: 1 });

    const singleRepo = {
      lockById: vi.fn().mockResolvedValue(existing),
      update: vi.fn().mockRejectedValue(
        new ConcurrencyConflictError('QuoteRequest 100 version conflict (expected version 1).'),
      ),
    };

    const useCase = new UpdateRecipientContactUseCase(
      txRunner as any,
      singleRepo as any,
    );

    await expect(
      useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
        recipientName: 'Racing Update',
      }),
    ).rejects.toThrow(ConcurrencyConflictError);
  });

  it('ADV-07: propagates database/transaction errors transparently without swallowing (NC-08)', async () => {
    const txRunner = new MockTransactionRunner();
    const existing = createSampleSentQuoteRequest({ version: 1 });

    const singleRepo = {
      lockById: vi.fn().mockResolvedValue(existing),
      update: vi.fn().mockRejectedValue(new Error('PostgreSQL connection dropped unexpectedly.')),
    };

    const useCase = new UpdateRecipientContactUseCase(
      txRunner as any,
      singleRepo as any,
    );

    await expect(
      useCase.execute({
        actor: buyerActor,
        requestId: '100',
        expectedRequestVersion: 1,
        recipientName: 'Connection Fail Test',
      }),
    ).rejects.toThrow('PostgreSQL connection dropped unexpectedly.');
  });
});
