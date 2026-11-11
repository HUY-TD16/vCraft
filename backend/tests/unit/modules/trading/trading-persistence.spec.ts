import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../../../src/generated/prisma/client';
import type { TransactionContext } from '../../../../src/common/application/ports/transaction-runner';
import type { PrismaService } from '../../../../src/infrastructure/database/prisma/prisma.service';
import { PrismaTransactionRunner } from '../../../../src/infrastructure/database/transactions/prisma-transaction-runner';
import {
  Allocation,
  AllocationBatchLink,
  ConcurrencyConflictError,
  IdempotencyConflictError,
  InvalidStateTransitionError,
  InvalidTradingInputError,
  Quote,
  QuoteRequest,
  RequestRecipient,
  SplitProposal,
  SplitProposalItem,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import {
  AllocationBatchMapper,
  AllocationLogMapper,
  AllocationMapper,
  ContactEditHistoryMapper,
  IdempotencyRecordMapper,
  PrismaAllocationBatchRepository,
  PrismaAllocationLogRepository,
  PrismaAllocationRepository,
  PrismaContactEditHistoryRepository,
  PrismaIdempotencyRecordRepository,
  PrismaQuoteRepository,
  PrismaQuoteRequestRepository,
  PrismaRecipientResponseHistoryRepository,
  PrismaRequestRecipientRepository,
  PrismaSplitProposalItemRepository,
  PrismaSplitProposalRepository,
  PrismaStatusLogRepository,
  QuoteMapper,
  QuoteRequestMapper,
  RecipientResponseHistoryMapper,
  RequestRecipientMapper,
  SplitProposalItemMapper,
  SplitProposalMapper,
  StatusLogMapper,
  TRADING_PERSISTENCE_PROVIDERS,
  bigintToId,
  dateToInstant,
  decimalToUnitPrice,
  idToBigInt,
  toActorDto,
  toCategoryRefDto,
  toWorkshopRefDto,
  unitPriceToDecimal,
} from '../../../../src/modules/trading/adapters/persistence';

function collectTsFiles(dirPath: string): string[] {
  const entries = readdirSync(dirPath);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    } else if (fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

const NOW = new Date('2026-11-11T08:00:00.000Z');
const BIDDING_DEADLINE = new Date('2026-11-13T08:00:00.000Z');
const QUOTE_ACCEPT_DEADLINE = new Date('2026-11-14T10:00:00.000Z');
const COMMITTED_DELIVERY = new Date('2026-11-16T08:00:00.000Z');
const DELIVERY_DEADLINE = new Date('2026-11-20T08:00:00.000Z');

function buildSentQuoteRequestPrismaRow(
  overrides: Partial<{
    id: bigint;
    buyer_id: bigint;
    category_id: bigint | null;
    spec: string | null;
    quantity: number | null;
    unit: string | null;
    unit_set_description: string | null;
    status: string;
    delivery_mode: string | null;
    delivery_region: string | null;
    delivery_address: string | null;
    recipient_name: string | null;
    recipient_phone: string | null;
    bidding_deadline: Date | null;
    delivery_deadline: Date | null;
    bidding_closed_at: Date | null;
    split_requested_at: Date | null;
    version: number;
    cancelled_at: Date | null;
    cancelled_by: bigint | null;
    cancel_reason: string | null;
    created_at: Date;
    updated_at: Date;
  }> = {},
) {
  return {
    id: 100n,
    buyer_id: 10n,
    category_id: 5n,
    spec: 'Handwoven bamboo baskets',
    quantity: 50,
    unit: 'piece',
    unit_set_description: null,
    status: 'artisans_bidding',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hanoi',
    delivery_address: '123 Pho Hue, Hai Ba Trung, Hanoi',
    recipient_name: 'Nguyen Van A',
    recipient_phone: '0901234567',
    bidding_deadline: BIDDING_DEADLINE,
    delivery_deadline: DELIVERY_DEADLINE,
    bidding_closed_at: null,
    split_requested_at: null,
    version: 2,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function createMockTxRunner(mockClient: Record<string, unknown>) {
  const mockPrismaService = {
    $transaction: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) => await fn(mockClient),
    ),
  } as unknown as PrismaService;

  const txRunner = new PrismaTransactionRunner(mockPrismaService);
  return { txRunner, mockPrismaService };
}

describe('Trading Application Layer Purity & Persistence Exports', () => {
  it('ensures trading/application contains zero imports from NestJS, Prisma, Zod, or adapters', () => {
    const appDir = join(
      __dirname,
      '../../../../src/modules/trading/application',
    );
    const files = collectTsFiles(appDir);
    expect(files.length).toBeGreaterThan(0);

    const forbiddenPatterns = [
      /@nestjs\//,
      /@prisma\/client/,
      /generated\/prisma/,
      /from ['"]zod['"]/,
      /adapters\//,
    ];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      for (const pattern of forbiddenPatterns) {
        expect(content).not.toMatch(pattern);
      }
    }
  });

  it('registers all 12 repository classes and token bindings in TRADING_PERSISTENCE_PROVIDERS', () => {
    expect(TRADING_PERSISTENCE_PROVIDERS).toHaveLength(24);
  });
});

describe('Trading Persistence Mappers (12 Tables)', () => {
  it('converts shared primitive types (BigInt, Decimal, Date, ActorDto, WorkshopRefDto, CategoryRefDto) safely', () => {
    expect(bigintToId(42n)).toBe('42');
    expect(idToBigInt('42')).toBe(42n);
    expect(decimalToUnitPrice(new Prisma.Decimal('150000'))).toBe(150000);
    expect(unitPriceToDecimal(150000).toFixed()).toBe('150000');
    expect(dateToInstant(NOW)).toBe('2026-11-11T08:00:00.000Z');

    expect(() => decimalToUnitPrice(new Prisma.Decimal('150.5'))).toThrow(
      InvalidTradingInputError,
    );

    const actorWithExtras = {
      id: 7n,
      display_name: 'Buyer One',
      username: 'buyer1',
      password_hash: 'secret_hash',
      role: 'buyer',
    };
    const actorDto = toActorDto(actorWithExtras);
    expect(actorDto).toEqual({ id: '7', display_name: 'Buyer One' });
    expect('password_hash' in actorDto).toBe(false);
    expect('username' in actorDto).toBe(false);

    expect(toWorkshopRefDto({ id: 20n, name: 'Bat Trang Ceramics' })).toEqual({
      id: '20',
      name: 'Bat Trang Ceramics',
    });
    expect(toCategoryRefDto({ id: 5n, name: 'Ceramics' })).toEqual({
      id: '5',
      name: 'Ceramics',
    });
    expect(toCategoryRefDto(null)).toBeNull();
  });

  it('1. QuoteRequestMapper maps Prisma <-> Domain <-> DTOs and enforces BR-04 InvitedRequestDto contact masking', () => {
    const row = buildSentQuoteRequestPrismaRow();
    const domain = QuoteRequestMapper.toDomain(row);
    expect(domain.id).toBe('100');
    expect(domain.buyer_id).toBe('10');
    expect(domain.status).toBe('artisans_bidding');

    const createInput = QuoteRequestMapper.toPrismaCreateInput(domain);
    expect(createInput.id).toBe(100n);
    expect(createInput.buyer_id).toBe(10n);

    const buyerDto = QuoteRequestMapper.toBuyerRequestDto(domain, {
      category: { id: '5', name: 'Bamboo' },
      now: NOW,
      coordinationState: null,
      noValidQuotes: false,
      nearestAcceptDeadline: BIDDING_DEADLINE,
    });
    expect(buyerDto.recipient_name).toBe('Nguyen Van A');
    expect(buyerDto.recipient_phone).toBe('0901234567');
    expect(buyerDto.delivery_address).toBe('123 Pho Hue, Hai Ba Trung, Hanoi');
    expect(buyerDto.is_bidding_open).toBe(true);

    const summaryDto = QuoteRequestMapper.toSummaryDto(domain, {
      category: { id: '5', name: 'Bamboo' },
      now: NOW,
    });
    expect('delivery_address' in summaryDto).toBe(false);
    expect('recipient_name' in summaryDto).toBe(false);

    const ownRecipientDto = {
      id: '300',
      request_id: '100',
      workshop: { id: '20', name: 'Phu Vinh Bamboo' },
      response_status: 'pending' as const,
      version: 1,
      sent_at: NOW.toISOString(),
      responded_at: null,
      decline_reason: null,
      eligibility_labels: [],
    };

    // Unallocated artisan MUST NOT see contact details or delivery_address (BR-04, SEC-04)
    const unallocatedInvitedDto = QuoteRequestMapper.toInvitedRequestDto(
      domain,
      {
        category: { id: '5', name: 'Bamboo' },
        now: NOW,
        ownRecipient: ownRecipientDto,
        ownQuote: null,
        ownAllocationId: null,
      },
    );
    expect('own_allocation_id' in unallocatedInvitedDto).toBe(false);
    expect('recipient_name' in unallocatedInvitedDto).toBe(false);
    expect('recipient_phone' in unallocatedInvitedDto).toBe(false);
    expect('delivery_address' in unallocatedInvitedDto).toBe(false);

    // Allocated artisan sees contact details and delivery_address
    const allocatedInvitedDto = QuoteRequestMapper.toInvitedRequestDto(domain, {
      category: { id: '5', name: 'Bamboo' },
      now: NOW,
      ownRecipient: ownRecipientDto,
      ownQuote: null,
      ownAllocationId: '900',
    });
    expect(allocatedInvitedDto).toMatchObject({
      own_allocation_id: '900',
      recipient_name: 'Nguyen Van A',
      recipient_phone: '0901234567',
      delivery_address: '123 Pho Hue, Hai Ba Trung, Hanoi',
    });
  });

  it('2. ContactEditHistoryMapper maps Prisma <-> Domain <-> ContactEventDto', () => {
    const row = {
      id: 50n,
      request_id: 100n,
      edited_by: 10n,
      prev_recipient_name: 'Nguyen Van A',
      prev_recipient_phone: '0901234567',
      new_recipient_name: 'Tran Thi B',
      new_recipient_phone: '0912345678',
      edited_at: NOW,
      version: 3,
      editedBy: { id: 10n, display_name: 'Buyer One' },
    };

    const domain = ContactEditHistoryMapper.toDomain(row);
    expect(domain.id).toBe('50');
    expect(domain.new_recipient_phone).toBe('0912345678');

    const prismaInput = ContactEditHistoryMapper.toPrismaCreateInput(domain);
    expect(prismaInput.request_id).toBe(100n);
    expect(prismaInput.edited_by).toBe(10n);

    const dto = ContactEditHistoryMapper.fromPrismaWithActorToDto(row);
    expect(dto).toEqual({
      id: '50',
      prev_recipient_name: 'Nguyen Van A',
      prev_recipient_phone: '0901234567',
      new_recipient_name: 'Tran Thi B',
      new_recipient_phone: '0912345678',
      edited_by: { id: '10', display_name: 'Buyer One' },
      edited_at: NOW.toISOString(),
      version: 3,
    });
  });

  it('3. RequestRecipientMapper maps Prisma <-> Domain <-> RecipientDto', () => {
    const row = {
      id: 300n,
      request_id: 100n,
      workshop_id: 20n,
      response_status: 'quoted',
      decline_reason: null,
      responded_by: 21n,
      responded_at: NOW,
      sent_at: NOW,
      version: 2,
    };

    const domain = RequestRecipientMapper.toDomain(row);
    expect(domain.id).toBe('300');
    expect(domain.response_status).toBe('quoted');

    const dto = RequestRecipientMapper.toDto(domain, {
      workshop: { id: '20', name: 'Workshop 20' },
      eligibilityLabels: ['QUOTE_EXPIRED'],
    });
    expect(dto.eligibility_labels).toEqual(['QUOTE_EXPIRED']);
  });

  it('4. RecipientResponseHistoryMapper enforces strict 6-field allowlist on quote_snapshot', () => {
    const rowWithExtraSnapshotKeys = {
      id: 400n,
      recipient_id: 300n,
      quote_id: 500n,
      event_type: 'quote_submitted',
      prev_status: 'pending',
      new_status: 'quoted',
      reason: null,
      quote_snapshot: {
        unit_price: 120000,
        max_quantity: 30,
        bid_accept_deadline: BIDDING_DEADLINE.toISOString(),
        committed_delivery_at: COMMITTED_DELIVERY.toISOString(),
        status: 'active',
        version: 1,
        internal_secret_field: 'MUST_BE_STRIPPED',
        workshop_phone: '0999999999',
      },
      performed_by: 21n,
      created_at: NOW,
      performedBy: { id: 21n, display_name: 'Artisan 21' },
    };

    const domain = RecipientResponseHistoryMapper.toDomain(
      rowWithExtraSnapshotKeys,
    );
    expect(domain.quote_snapshot).not.toBeNull();
    expect(Object.keys(domain.quote_snapshot!)).toEqual([
      'unit_price',
      'max_quantity',
      'bid_accept_deadline',
      'committed_delivery_at',
      'status',
      'version',
    ]);

    const dto = RecipientResponseHistoryMapper.fromPrismaWithActorToDto(
      rowWithExtraSnapshotKeys,
    );
    expect(Object.keys(dto.quote_snapshot!)).toEqual([
      'unit_price',
      'max_quantity',
      'bid_accept_deadline',
      'committed_delivery_at',
      'status',
      'version',
    ]);
    expect('internal_secret_field' in (dto.quote_snapshot as object)).toBe(
      false,
    );

    // Declined event with non-null quote_snapshot must fail validation
    expect(() =>
      RecipientResponseHistoryMapper.toDomain({
        ...rowWithExtraSnapshotKeys,
        event_type: 'declined',
      }),
    ).toThrow(InvalidTradingInputError);
  });

  it('5. QuoteMapper maps Prisma <-> Domain <-> QuoteDto & QuoteMutationDto', () => {
    const request = QuoteRequestMapper.toDomain(
      buildSentQuoteRequestPrismaRow(),
    );
    const quoteRow = {
      id: 500n,
      request_id: 100n,
      workshop_id: 20n,
      unit_price: new Prisma.Decimal('120000'),
      max_quantity: 50,
      bid_accept_deadline: BIDDING_DEADLINE,
      committed_delivery_at: COMMITTED_DELIVERY,
      status: 'active',
      version: 1,
      withdraw_reason: null,
      withdrawn_by: null,
      withdrawn_at: null,
      created_at: NOW,
      updated_at: NOW,
    };

    const quoteDomain = QuoteMapper.toDomain(quoteRow);
    expect(quoteDomain.unit_price).toBe(120000);

    const quoteDto = QuoteMapper.toDto(quoteDomain, {
      workshop: { id: '20', name: 'Workshop 20' },
      evaluationContext: {
        request,
        workshopIsActive: true,
        now: NOW,
      },
    });
    expect(quoteDto.is_eligible).toBe(true);
    expect(quoteDto.ineligible_reasons).toEqual([]);
  });

  it('6 & 7. SplitProposalItemMapper and SplitProposalMapper map items, decision_deadline, and total_amount', () => {
    const item1Row = {
      id: 601n,
      proposal_id: 600n,
      request_id: 100n,
      workshop_id: 20n,
      quote_id: 501n,
      quote_version: 1,
      allocated_quantity: 30,
    };
    const item2Row = {
      id: 602n,
      proposal_id: 600n,
      request_id: 100n,
      workshop_id: 21n,
      quote_id: 502n,
      quote_version: 1,
      allocated_quantity: 20,
    };
    const proposalRow = {
      id: 600n,
      request_id: 100n,
      created_by: 1n,
      status: 'proposed',
      version: 1,
      expired_at: null,
      expire_reason: null,
      reject_reason: null,
      rejected_by: null,
      rejected_at: null,
      created_at: NOW,
      updated_at: NOW,
      splitProposalItems: [item1Row, item2Row],
    };

    const proposal = SplitProposalMapper.toDomain(proposalRow);
    expect(proposal.items).toHaveLength(2);

    const earlierAcceptDeadline = new Date('2026-11-12T10:00:00.000Z');
    const laterAcceptDeadline = new Date('2026-11-13T10:00:00.000Z');

    const dto = SplitProposalMapper.toDto(proposal, {
      quoteMetadataByQuoteId: new Map([
        [
          '501',
          {
            workshopName: 'Workshop 20',
            unitPrice: 100000,
            committedDeliveryAt: COMMITTED_DELIVERY,
            bidAcceptDeadline: laterAcceptDeadline,
          },
        ],
        [
          '502',
          {
            workshopName: 'Workshop 21',
            unitPrice: 150000,
            committedDeliveryAt: COMMITTED_DELIVERY,
            bidAcceptDeadline: earlierAcceptDeadline,
          },
        ],
      ]),
    });

    // 30 * 100,000 + 20 * 150,000 = 3,000,000 + 3,000,000 = 6,000,000
    expect(dto.total_amount).toBe('6000000');
    expect(dto.decision_deadline).toBe(earlierAcceptDeadline.toISOString());
    expect(dto.items[0]).toEqual({
      workshop_id: '20',
      workshop_name: 'Workshop 20',
      quote_id: '501',
      quote_version: 1,
      quantity: 30,
      unit_price: 100000,
      committed_delivery_at: COMMITTED_DELIVERY.toISOString(),
      line_total: '3000000',
    });
  });

  it('8 & 9. AllocationBatchMapper and AllocationMapper enforce trace_url masking on draft batches and derive traceability_warning', () => {
    const batchRow = {
      id: 801n,
      workshop_id: 20n,
      allocation_id: 700n,
      batch_id: 901n,
      linked_quantity: 50,
      linked_at: NOW,
      linked_by: 21n,
    };

    const linkDomain = AllocationBatchMapper.toDomain(batchRow);

    const draftBatchDto = AllocationBatchMapper.toDto(linkDomain, {
      batchName: 'Batch Autumn 01',
      batchStatus: 'draft',
      traceUrl: 'https://vcraft.vn/trace/secret-token',
    });
    expect(draftBatchDto.is_trace_public).toBe(false);
    expect(draftBatchDto.trace_url).toBeNull();

    const publishedBatchDto = AllocationBatchMapper.toDto(linkDomain, {
      batchName: 'Batch Autumn 01',
      batchStatus: 'published',
      traceUrl: 'https://vcraft.vn/trace/public-token',
    });
    expect(publishedBatchDto.is_trace_public).toBe(true);
    expect(publishedBatchDto.trace_url).toBe(
      'https://vcraft.vn/trace/public-token',
    );

    const allocationRow = {
      id: 700n,
      request_id: 100n,
      workshop_id: 20n,
      quote_id: 500n,
      quantity: 50,
      unit_price: new Prisma.Decimal('120000'),
      committed_delivery_at: COMMITTED_DELIVERY,
      status: 'in_production',
      version: 2,
      started_at: NOW,
      started_by: 21n,
      handed_over_at: null,
      handed_over_by: null,
      delivery_note: null,
      admin_handed_over: false,
      admin_delivery_evidence: null,
      admin_handover_reason: null,
      admin_handover_actual_at: null,
      created_at: NOW,
      updated_at: NOW,
      allocationBatches: [batchRow],
    };

    const allocationDomain = AllocationMapper.toDomain(allocationRow);
    const dtoWithDraftBatch = AllocationMapper.toDto(allocationDomain, {
      workshop: { id: '20', name: 'Workshop 20' },
      publishedBatchIds: new Set(),
    });
    expect(dtoWithDraftBatch.traceability_warning).toBe(
      'INCOMPLETE_TRACEABILITY',
    );

    const dtoWithPublishedBatch = AllocationMapper.toDto(allocationDomain, {
      workshop: { id: '20', name: 'Workshop 20' },
      publishedBatchIds: new Set(['901']),
    });
    expect(dtoWithPublishedBatch.traceability_warning).toBeNull();
  });

  it('10, 11 & 12. AllocationLogMapper, StatusLogMapper, and IdempotencyRecordMapper map records and validate invariants', () => {
    const allocLogRow = {
      id: 1001n,
      allocation_id: 700n,
      event_type: 'production_started',
      prev_status: 'not_started',
      new_status: 'in_production',
      performed_by: 21n,
      is_admin_action: false,
      note: null,
      evidence: null,
      created_at: NOW,
      performedBy: { id: 21n, display_name: 'Artisan 21' },
    };
    const allocEventDto =
      AllocationLogMapper.fromPrismaWithActorToDto(allocLogRow);
    expect(allocEventDto.event_type).toBe('production_started');
    expect(allocEventDto.performed_by).toEqual({
      id: '21',
      display_name: 'Artisan 21',
    });

    const statusLogRow = {
      id: 1002n,
      request_id: 100n,
      event_type: 'received_by_admin',
      prev_status: 'in_production',
      new_status: 'delivered',
      performed_by: 1n,
      is_admin_action: true,
      note: 'Buyer confirmed via support hotline',
      evidence: 'https://storage.vcraft.vn/evidence/call-123.png',
      created_at: NOW,
      performedBy: { id: 1n, display_name: 'Admin One' },
    };
    const statusDomain = StatusLogMapper.toDomain(statusLogRow);
    const deliveryConfirmation = StatusLogMapper.toDeliveryConfirmationDto(
      statusDomain,
      { id: '1', display_name: 'Admin One' },
    );
    expect(deliveryConfirmation).toEqual({
      performed_by: { id: '1', display_name: 'Admin One' },
      performed_at: NOW.toISOString(),
      is_admin_action: true,
      reason: 'Buyer confirmed via support hotline',
      evidence: 'https://storage.vcraft.vn/evidence/call-123.png',
    });

    const expiresAt = new Date('2026-11-12T08:00:00.000Z');
    const idemRow = {
      id: 2001n,
      idempotency_key: 'idem-key-001',
      request_fingerprint: 'sha256:abc123',
      account_id: 10n,
      action: 'accept_quote',
      object_type: 'QuoteRequest',
      object_id: 100n,
      result_snapshot: { accepted: true },
      created_at: NOW,
      expires_at: expiresAt,
    };
    const idemDomain = IdempotencyRecordMapper.toDomain(idemRow);
    expect(idemDomain.id).toBe('2001');
    expect(idemDomain.result_snapshot).toEqual({ accepted: true });

    const opMeta = IdempotencyRecordMapper.toOperationMetadata({
      id: '2001',
      replayed: true,
      committedAt: NOW,
      currentState: {
        request: {
          id: '100',
          status: 'buyer_accepted',
          version: 3,
          cancelled_at: null,
        },
      },
    });
    expect(opMeta.replayed).toBe(true);
    expect(opMeta.current_state.request.status).toBe('buyer_accepted');
  });
});

describe('Trading Prisma Repositories & PrismaTransactionRunner Integration (12 Tables)', () => {
  it('rejects forged or expired TransactionContext across repositories', async () => {
    const mockClient = {
      quoteRequest: { findUnique: vi.fn() },
    };
    const { txRunner } = createMockTxRunner(mockClient);
    const repo = new PrismaQuoteRequestRepository(txRunner);

    const forgedTx = {} as TransactionContext;
    await expect(repo.findById('100', forgedTx)).rejects.toThrow(
      'Invalid or expired transaction context',
    );

    let capturedTx!: TransactionContext;
    await txRunner.run(async (tx) => {
      capturedTx = tx;
    });

    await expect(repo.findById('100', capturedTx)).rejects.toThrow(
      'Invalid or expired transaction context',
    );
  });

  it('executes FOR UPDATE row locking in ascending numerical ID order (BR-27)', async () => {
    const sentRow10 = buildSentQuoteRequestPrismaRow({ id: 10n });
    const sentRow2 = buildSentQuoteRequestPrismaRow({ id: 2n });

    const mockClient = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 2n }, { id: 10n }]),
      quoteRequest: {
        findMany: vi.fn().mockResolvedValue([sentRow2, sentRow10]),
      },
    };
    const { txRunner } = createMockTxRunner(mockClient);
    const repo = new PrismaQuoteRequestRepository(txRunner);

    const results = await txRunner.run(async (tx) => {
      return repo.lockByIds(['10', '2', '10'], tx);
    });

    expect(results.map((r) => r.id)).toEqual(['2', '10']);
    expect(mockClient.$queryRaw).toHaveBeenCalledTimes(1);
    const sqlArg = mockClient.$queryRaw.mock.calls[0][0] as {
      values: unknown[];
    };
    expect(sqlArg.values).toEqual([2n, 10n]);
  });

  it('enforces optimistic concurrency control (ConcurrencyConflictError) on QuoteRequest, Quote, SplitProposal, and Allocation updates', async () => {
    const sentRow = buildSentQuoteRequestPrismaRow({ version: 2 });
    const domainRequest = QuoteRequestMapper.toDomain(sentRow);

    const mockClient = {
      quoteRequest: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const { txRunner } = createMockTxRunner(mockClient);
    const repo = new PrismaQuoteRequestRepository(txRunner);

    await expect(
      txRunner.run((tx) =>
        repo.update(
          {
            request: domainRequest,
            expectedVersion: 1,
          },
          tx,
        ),
      ),
    ).rejects.toThrow(ConcurrencyConflictError);
  });

  it('handles SplitProposal atomic replacement and workshop suspension lookup', async () => {
    const item1Row = {
      id: 601n,
      proposal_id: 600n,
      request_id: 100n,
      workshop_id: 20n,
      quote_id: 501n,
      quote_version: 1,
      allocated_quantity: 30,
    };
    const item2Row = {
      id: 602n,
      proposal_id: 600n,
      request_id: 100n,
      workshop_id: 21n,
      quote_id: 502n,
      quote_version: 1,
      allocated_quantity: 20,
    };
    const newProposalDomain = SplitProposalMapper.toDomain({
      id: 600n,
      request_id: 100n,
      created_by: 1n,
      status: 'proposed',
      version: 1,
      expired_at: null,
      expire_reason: null,
      reject_reason: null,
      rejected_by: null,
      rejected_at: null,
      created_at: NOW,
      updated_at: NOW,
      splitProposalItems: [item2Row, item1Row],
    });

    const replacedProposalDomain = SplitProposalMapper.toDomain({
      id: 599n,
      request_id: 100n,
      created_by: 1n,
      status: 'expired',
      version: 2,
      expired_at: NOW,
      expire_reason: 'replaced',
      reject_reason: null,
      rejected_by: null,
      rejected_at: null,
      created_at: NOW,
      updated_at: NOW,
      splitProposalItems: [
        { ...item1Row, proposal_id: 599n },
        { ...item2Row, proposal_id: 599n },
      ],
    });

    const createdWorkshopsOrder: bigint[] = [];
    const mockClient = {
      splitProposal: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({
          id: 600n,
          request_id: 100n,
          created_by: 1n,
          status: 'proposed',
          version: 1,
          expired_at: null,
          expire_reason: null,
          reject_reason: null,
          rejected_by: null,
          rejected_at: null,
          created_at: NOW,
          updated_at: NOW,
        }),
        findMany: vi
          .fn()
          .mockResolvedValue([{ request_id: 200n }, { request_id: 100n }]),
      },
      splitProposalItem: {
        create: vi.fn().mockImplementation(async ({ data }) => {
          createdWorkshopsOrder.push(data.workshop_id);
          return data.workshop_id === 20n ? item1Row : item2Row;
        }),
      },
    };

    const { txRunner } = createMockTxRunner(mockClient);
    const repo = new PrismaSplitProposalRepository(txRunner);

    const created = await txRunner.run((tx) =>
      repo.createProposal(
        {
          proposal: newProposalDomain,
          replacedProposal: replacedProposalDomain,
        },
        tx,
      ),
    );

    expect(created.id).toBe('600');
    expect(mockClient.splitProposal.updateMany).toHaveBeenCalledTimes(1);
    // Items inserted in ascending workshop_id order (20n then 21n)
    expect(createdWorkshopsOrder).toEqual([20n, 21n]);

    const affectedRequestIds = await txRunner.run((tx) =>
      repo.findProposedRequestIdsByWorkshopId('20', tx),
    );
    expect(affectedRequestIds).toEqual(['100', '200']);
  });

  it('handles AllocationBatch replacement, RecipientResponseHistory snapshot lookup, History/Log repositories, and IdempotencyRecord replay & conflict', async () => {
    const expiresAt = new Date('2026-11-12T08:00:00.000Z');
    const storedIdemRow = {
      id: 2001n,
      idempotency_key: 'idem-001',
      request_fingerprint: 'fp-original',
      account_id: 10n,
      action: 'accept_quote',
      object_type: 'QuoteRequest',
      object_id: 100n,
      result_snapshot: { status: 'buyer_accepted' },
      created_at: NOW,
      expires_at: expiresAt,
    };

    const mockClient = {
      allocationBatch: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockImplementation(async ({ data }) => ({
          id: 801n,
          ...data,
        })),
      },
      recipientResponseHistory: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 402n,
            recipient_id: 300n,
            quote_id: 500n,
            event_type: 'quote_updated',
            prev_status: 'quoted',
            new_status: 'quoted',
            reason: null,
            quote_snapshot: {
              unit_price: 110000,
              max_quantity: 50,
              bid_accept_deadline: BIDDING_DEADLINE.toISOString(),
              committed_delivery_at: COMMITTED_DELIVERY.toISOString(),
              status: 'active',
              version: 2,
            },
            performed_by: 21n,
            created_at: NOW,
          },
          {
            id: 401n,
            recipient_id: 300n,
            quote_id: 500n,
            event_type: 'quote_submitted',
            prev_status: 'pending',
            new_status: 'quoted',
            reason: null,
            quote_snapshot: {
              unit_price: 125000,
              max_quantity: 40,
              bid_accept_deadline: BIDDING_DEADLINE.toISOString(),
              committed_delivery_at: COMMITTED_DELIVERY.toISOString(),
              status: 'active',
              version: 1,
            },
            performed_by: 21n,
            created_at: NOW,
          },
        ]),
      },
      idempotencyRecord: {
        findUnique: vi.fn().mockResolvedValue(storedIdemRow),
        create: vi.fn().mockResolvedValue(storedIdemRow),
        deleteMany: vi.fn().mockResolvedValue({ count: 4 }),
      },
    };

    const { txRunner } = createMockTxRunner(mockClient);
    const batchRepo = new PrismaAllocationBatchRepository(txRunner);
    const historyRepo = new PrismaRecipientResponseHistoryRepository(txRunner);
    const idemRepo = new PrismaIdempotencyRecordRepository(txRunner);

    const link = AllocationBatchLink.reconstitute({
      workshop_id: '20',
      allocation_id: '700',
      batch_id: '901',
      linked_quantity: 25,
      linked_at: NOW,
      linked_by: '21',
    });

    const replacedLinks = await txRunner.run((tx) =>
      batchRepo.replaceForAllocation(
        {
          allocationId: '700',
          workshopId: '20',
          links: [link],
        },
        tx,
      ),
    );
    expect(replacedLinks).toHaveLength(1);
    expect(replacedLinks[0].batch_id).toBe('901');

    const snapshotV1 = await txRunner.run((tx) =>
      historyRepo.findSnapshotByQuoteVersion('500', 1, tx),
    );
    expect(snapshotV1?.unit_price).toBe(125000);
    expect(snapshotV1?.version).toBe(1);

    // Matching fingerprint replays stored record
    const replayed = await txRunner.run((tx) =>
      idemRepo.findAndVerifyReplay(
        {
          account_id: '10',
          action: 'accept_quote',
          object_type: 'QuoteRequest',
          object_id: '100',
          idempotency_key: 'idem-001',
          request_fingerprint: 'fp-original',
        },
        tx,
      ),
    );
    expect(replayed?.result_snapshot).toEqual({ status: 'buyer_accepted' });

    // Mismatched fingerprint throws 409 IdempotencyConflictError
    await expect(
      txRunner.run((tx) =>
        idemRepo.findAndVerifyReplay(
          {
            account_id: '10',
            action: 'accept_quote',
            object_type: 'QuoteRequest',
            object_id: '100',
            idempotency_key: 'idem-001',
            request_fingerprint: 'fp-DIFFERENT',
          },
          tx,
        ),
      ),
    ).rejects.toThrow(IdempotencyConflictError);

    const deletedCount = await txRunner.run((tx) =>
      idemRepo.deleteExpiredBefore(expiresAt, tx),
    );
    expect(deletedCount).toBe(4);
  });

  it('exercises remaining repositories (ContactEditHistory, RequestRecipient, Quote, SplitProposalItem, Allocation, AllocationLog, StatusLog)', async () => {
    const mockClient = {
      contactEditHistory: {
        create: vi.fn().mockResolvedValue({
          id: 50n,
          request_id: 100n,
          edited_by: 10n,
          prev_recipient_name: 'A',
          prev_recipient_phone: '0901111111',
          new_recipient_name: 'B',
          new_recipient_phone: '0902222222',
          edited_at: NOW,
          version: 3,
        }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      requestRecipient: {
        create: vi.fn().mockImplementation(async ({ data }) => ({
          id: 300n,
          ...data,
        })),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          id: 300n,
          request_id: 100n,
          workshop_id: 20n,
          response_status: 'quoted',
          decline_reason: null,
          responded_by: 21n,
          responded_at: NOW,
          sent_at: NOW,
          version: 2,
        }),
      },
      recipientResponseHistory: {
        create: vi.fn().mockResolvedValue({}),
      },
      quote: {
        create: vi.fn().mockResolvedValue({
          id: 500n,
          request_id: 100n,
          workshop_id: 20n,
          unit_price: new Prisma.Decimal('120000'),
          max_quantity: 50,
          bid_accept_deadline: BIDDING_DEADLINE,
          committed_delivery_at: COMMITTED_DELIVERY,
          status: 'active',
          version: 1,
          withdraw_reason: null,
          withdrawn_by: null,
          withdrawn_at: null,
          created_at: NOW,
          updated_at: NOW,
        }),
      },
      splitProposalItem: {
        create: vi.fn().mockImplementation(async ({ data }) => ({
          id: 601n,
          ...data,
        })),
        findMany: vi.fn().mockResolvedValue([]),
      },
      allocation: {
        create: vi.fn().mockResolvedValue({
          id: 700n,
          request_id: 100n,
          workshop_id: 20n,
          quote_id: 500n,
          quantity: 50,
          unit_price: new Prisma.Decimal('120000'),
          committed_delivery_at: COMMITTED_DELIVERY,
          status: 'not_started',
          version: 1,
          started_at: null,
          started_by: null,
          handed_over_at: null,
          handed_over_by: null,
          delivery_note: null,
          admin_handed_over: false,
          admin_delivery_evidence: null,
          admin_handover_reason: null,
          admin_handover_actual_at: null,
          created_at: NOW,
          updated_at: NOW,
          allocationBatches: [],
        }),
      },
      allocationLog: {
        create: vi.fn().mockResolvedValue({
          id: 1001n,
          allocation_id: 700n,
          event_type: 'created',
          prev_status: null,
          new_status: 'not_started',
          performed_by: 10n,
          is_admin_action: false,
          note: null,
          evidence: null,
          created_at: NOW,
        }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      statusLog: {
        create: vi.fn().mockResolvedValue({
          id: 1002n,
          request_id: 100n,
          event_type: 'created',
          prev_status: null,
          new_status: 'draft_request',
          performed_by: 10n,
          is_admin_action: false,
          note: null,
          evidence: null,
          created_at: NOW,
        }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    const { txRunner } = createMockTxRunner(mockClient);
    const contactRepo = new PrismaContactEditHistoryRepository(txRunner);
    const recipientRepo = new PrismaRequestRecipientRepository(txRunner);
    const quoteRepo = new PrismaQuoteRepository(txRunner);
    const itemRepo = new PrismaSplitProposalItemRepository(txRunner);
    const allocationRepo = new PrismaAllocationRepository(txRunner);
    const allocationLogRepo = new PrismaAllocationLogRepository(txRunner);
    const statusLogRepo = new PrismaStatusLogRepository(txRunner);

    await txRunner.run(async (tx) => {
      const contact = await contactRepo.create(
        {
          request_id: '100',
          edited_by: '10',
          prev_recipient_name: 'A',
          prev_recipient_phone: '0901111111',
          new_recipient_name: 'B',
          new_recipient_phone: '0902222222',
          edited_at: NOW,
          version: 3,
        },
        tx,
      );
      expect(contact.id).toBe('50');

      const recipients = await recipientRepo.createMany(
        [{ request_id: '100', workshop_id: '20', sent_at: NOW }],
        tx,
      );
      expect(recipients).toHaveLength(1);

      const request = QuoteRequestMapper.toDomain(
        buildSentQuoteRequestPrismaRow(),
      );
      const recipient = RequestRecipient.reconstitute({
        id: '300',
        request_id: '100',
        workshop_id: '20',
        response_status: 'pending',
        decline_reason: null,
        responded_by: null,
        responded_at: null,
        sent_at: NOW,
        version: 1,
      });

      const submission = Quote.submitNew({
        id: '500',
        request,
        recipient,
        actorId: '21',
        workshopIsActive: true,
        unitPrice: 120000,
        maxQuantity: 50,
        bidAcceptDeadline: QUOTE_ACCEPT_DEADLINE,
        committedDeliveryAt: COMMITTED_DELIVERY,
        now: NOW,
      });

      const savedQuote = await quoteRepo.create(submission, tx);
      expect(savedQuote.id).toBe('500');

      const savedItems = await itemRepo.createMany(
        [
          SplitProposalItem.reconstitute({
            id: '601',
            proposal_id: '600',
            request_id: '100',
            workshop_id: '20',
            quote_id: '500',
            quote_version: 1,
            allocated_quantity: 30,
          }),
        ],
        tx,
      );
      expect(savedItems).toHaveLength(1);

      const { allocation, log } = Allocation.createFromAcceptedQuote({
        id: '700',
        request_id: '100',
        workshop_id: '20',
        quote_id: '500',
        quantity: 50,
        unit_price: 120000,
        committed_delivery_at: COMMITTED_DELIVERY,
        actorId: '10',
        now: NOW,
      });

      const savedAllocation = await allocationRepo.create(
        { allocation, log },
        tx,
      );
      expect(savedAllocation.id).toBe('700');

      const savedAllocLog = await allocationLogRepo.create(log, tx);
      expect(savedAllocLog.id).toBe('1001');

      const savedStatusLog = await statusLogRepo.create(
        {
          request_id: '100',
          event_type: 'created',
          prev_status: null,
          new_status: 'draft_request',
          performed_by: '10',
          is_admin_action: false,
          note: null,
          evidence: null,
          created_at: NOW,
        },
        tx,
      );
      expect(savedStatusLog.id).toBe('1002');
    });
  });

  it('enforces deleteDraft ownership, status, version checks, and cleans up draft StatusLog in PrismaQuoteRequestRepository', async () => {
    const sentRow = buildSentQuoteRequestPrismaRow({
      id: 100n,
      buyer_id: 10n,
      status: 'sent_to_artisans',
      version: 2,
    });
    const draftRow = buildSentQuoteRequestPrismaRow({
      id: 101n,
      buyer_id: 10n,
      status: 'draft_request',
      version: 1,
    });
    const mockClient = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 101n }]),
      statusLog: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      quoteRequest: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi
          .fn()
          .mockImplementation(async ({ where }) =>
            where.id === 101n ? draftRow : sentRow,
          ),
      },
    };
    const { txRunner } = createMockTxRunner(mockClient);
    const repo = new PrismaQuoteRequestRepository(txRunner);

    // Wrong buyer -> TradingPermissionDeniedError
    await expect(
      txRunner.run((tx) =>
        repo.deleteDraft(
          { requestId: '100', buyerId: '999', expectedVersion: 2 },
          tx,
        ),
      ),
    ).rejects.toThrow(TradingPermissionDeniedError);

    // Non-draft status -> InvalidStateTransitionError
    await expect(
      txRunner.run((tx) =>
        repo.deleteDraft(
          { requestId: '100', buyerId: '10', expectedVersion: 2 },
          tx,
        ),
      ),
    ).rejects.toThrow(InvalidStateTransitionError);

    // Valid draft -> cleans up StatusLog and deletes draft QuoteRequest
    await txRunner.run((tx) =>
      repo.deleteDraft(
        { requestId: '101', buyerId: '10', expectedVersion: 1 },
        tx,
      ),
    );
    expect(mockClient.statusLog.deleteMany).toHaveBeenCalledWith({
      where: { request_id: 101n },
    });
    expect(mockClient.quoteRequest.deleteMany).toHaveBeenCalledWith({
      where: {
        id: 101n,
        buyer_id: 10n,
        status: 'draft_request',
        version: 1,
      },
    });
  });
});
