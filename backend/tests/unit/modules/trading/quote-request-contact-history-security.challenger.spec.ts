import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureHttp } from '../../../../src/bootstrap/configure-http';
import { AppLogger } from '../../../../src/common/observability/app-logger';
import { AppConfigModule } from '../../../../src/common/config/app-config';
import { SecurityModule } from '../../../../src/common/security/security.module';
import { IDENTITY_CONTRACT } from '../../../../src/modules/identity/public/contracts/identity.contract';
import { MockIdentityContract } from '../../../support/mocks/identity.mock';
import { MockTransactionRunner } from '../../../support/mocks/transaction-runner.mock';
import { TRANSACTION_RUNNER } from '../../../../src/common/application/ports/transaction-runner';
import {
  type IQuoteRequestRepository,
  type IContactEditHistoryRepository,
  type IAllocationRepository,
  QUOTE_REQUEST_REPOSITORY,
  CONTACT_EDIT_HISTORY_REPOSITORY,
  ALLOCATION_REPOSITORY,
} from '../../../../src/modules/trading/application/ports/repositories/trading-repositories.port';
import { GetQuoteRequestByIdUseCase } from '../../../../src/modules/trading/application/use-cases/requests/get-quote-request-by-id.use-case';
import { GetContactHistoryUseCase } from '../../../../src/modules/trading/application/use-cases/requests/get-contact-history.use-case';
import { QuoteRequestController } from '../../../../src/modules/trading/adapters/http/controllers/quote-request.controller';
import {
  Allocation,
  QuoteRequest,
  QuoteRequestNotFoundError,
  TradingDomainError,
  TradingPermissionDeniedError,
} from '../../../../src/modules/trading/domain';
import type { AuthenticatedActor } from '../../../../src/common/security/guards/authenticated-request';
import type { ContactEventDto } from '../../../../src/modules/trading/application/dtos/trading-persistence.dtos';

/**
 * Deep-extract all key names from any nested structure (object/array)
 * to verify that no sensitive fields or unauthorized attributes are leaked.
 */
function extractAllKeys(obj: unknown): Set<string> {
  const keys = new Set<string>();
  function recurse(curr: unknown) {
    if (curr === null || typeof curr !== 'object') return;
    if (Array.isArray(curr)) {
      for (const item of curr) recurse(item);
    } else {
      for (const [k, v] of Object.entries(curr)) {
        keys.add(k);
        recurse(v);
      }
    }
  }
  recurse(obj);
  return keys;
}

// ---------------------------------------------------------------------------
// Adversarial Actor & Session Fixtures
// ---------------------------------------------------------------------------

// Legitimate Owner Buyer (owns QuoteRequest 100)
const buyerOwnerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-buyer-owner',
  sessionLevel: 'normal',
});

// Hostile/Foreign Buyer (Buyer B attempting IDOR on Buyer A's request)
const hostileBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '99',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-hostile-buyer',
  sessionLevel: 'normal',
});

// Admin Actor (super-user with global auditing rights)
const adminActor: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-admin',
  sessionLevel: 'normal',
});

// Artisan with Won Allocation on QuoteRequest 100 (Workshop 200)
const artisanWonAllocationActor: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '200',
  authVersion: 1,
  sessionId: 'session-artisan-won-alloc',
  sessionLevel: 'normal',
});

// Artisan invited in RequestRecipient (Workshop 300) but NEVER allocated
const artisanInvitedUnallocatedActor: AuthenticatedActor = Object.freeze({
  accountId: '30',
  role: 'artisan',
  workshopId: '300',
  authVersion: 1,
  sessionId: 'session-artisan-invited-unallocated',
  sessionLevel: 'normal',
});

// Artisan completely uninvited to QuoteRequest 100 (Workshop 400)
const artisanUninvitedActor: AuthenticatedActor = Object.freeze({
  accountId: '40',
  role: 'artisan',
  workshopId: '400',
  authVersion: 1,
  sessionId: 'session-artisan-uninvited',
  sessionLevel: 'normal',
});

// Artisan won Allocation on Request X (200), attempting cross-tenant access to Request Y (100)
const artisanWonOtherRequestActor: AuthenticatedActor = Object.freeze({
  accountId: '50',
  role: 'artisan',
  workshopId: '500',
  authVersion: 1,
  sessionId: 'session-artisan-won-other',
  sessionLevel: 'normal',
});

// Artisan actor lacking workshopId (malformed/unassigned workshop profile)
const artisanNoWorkshopActor: AuthenticatedActor = Object.freeze({
  accountId: '60',
  role: 'artisan',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-artisan-no-workshop',
  sessionLevel: 'normal',
});

// Temporary password session actors across all 3 roles (SEC-05 restriction)
const tempPasswordBuyerActor: AuthenticatedActor = Object.freeze({
  accountId: '10',
  role: 'buyer',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-temp-password-buyer',
  sessionLevel: 'temp_password',
});

const tempPasswordArtisanActor: AuthenticatedActor = Object.freeze({
  accountId: '20',
  role: 'artisan',
  workshopId: '200',
  authVersion: 1,
  sessionId: 'session-temp-password-artisan',
  sessionLevel: 'temp_password',
});

const tempPasswordAdminActor: AuthenticatedActor = Object.freeze({
  accountId: '1',
  role: 'admin',
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-temp-password-admin',
  sessionLevel: 'temp_password',
});

// Spoofed role actor
const spoofedRoleActor: AuthenticatedActor = Object.freeze({
  accountId: '88',
  role: 'moderator' as any,
  workshopId: null,
  authVersion: 1,
  sessionId: 'session-spoofed-role',
  sessionLevel: 'normal',
});

// ---------------------------------------------------------------------------
// Entity & DTO Builders
// ---------------------------------------------------------------------------
function buildQuoteRequestEntity(
  overrides: Partial<{
    id: string;
    buyer_id: string;
    status: any;
    version: number;
    cancelled_at: Date | null;
    cancelled_by: string | null;
    cancel_reason: string | null;
  }> = {},
): QuoteRequest {
  const isCancelled = overrides.status === 'cancelled';
  const cancelledAt =
    overrides.cancelled_at !== undefined
      ? overrides.cancelled_at
      : isCancelled
        ? new Date('2026-11-13T10:00:00.000Z')
        : null;
  const cancelledBy =
    overrides.cancelled_by !== undefined
      ? overrides.cancelled_by
      : cancelledAt !== null
        ? overrides.buyer_id ?? '10'
        : null;

  return QuoteRequest.reconstitute({
    id: overrides.id ?? '100',
    buyer_id: overrides.buyer_id ?? '10',
    category_id: '1',
    spec: 'Bộ ấm chén gốm sứ men lam Bát Tràng vẽ vàng hoàng gia',
    quantity: 50,
    unit: 'set',
    unit_set_description: '1 ấm trà + 6 chén + 1 đĩa lót',
    status: overrides.status ?? 'sent_to_artisans',
    delivery_mode: 'at_buyer_address',
    delivery_region: 'Hà Nội',
    delivery_address: '123 Phố Huế, Hai Bà Trưng, Hà Nội',
    recipient_name: 'Nguyễn Văn A',
    recipient_phone: '0912345678',
    bidding_deadline: new Date(Date.now() + 86400000 * 2),
    delivery_deadline: new Date(Date.now() + 86400000 * 10),
    bidding_closed_at: null,
    version: overrides.version ?? 1,
    cancelled_at: cancelledAt,
    cancelled_by: cancelledBy,
    cancel_reason:
      overrides.cancel_reason !== undefined
        ? overrides.cancel_reason
        : isCancelled
          ? 'Người mua hủy do kế hoạch thay đổi'
          : null,
    split_requested_at: null,
    created_at: new Date('2026-11-10T08:00:00.000Z'),
    updated_at: new Date('2026-11-10T08:00:00.000Z'),
  });
}

function buildAllocationEntity(params: {
  id?: string;
  requestId: string;
  workshopId: string;
}): Allocation {
  return Allocation.reconstitute({
    id: params.id ?? '901',
    request_id: params.requestId,
    workshop_id: params.workshopId,
    quote_id: '801',
    quantity: 50,
    unit_price: 350000,
    committed_delivery_at: new Date(Date.now() + 86400000 * 8),
    status: 'confirmed',
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
    batch_links: [],
    created_at: new Date('2026-11-12T10:00:00.000Z'),
    updated_at: new Date('2026-11-12T10:00:00.000Z'),
  });
}

function buildSampleContactEvents(): ContactEventDto[] {
  return [
    {
      id: '1',
      prev_recipient_name: 'Nguyễn Văn A',
      prev_recipient_phone: '0912345678',
      new_recipient_name: 'Nguyễn Văn A (Cập nhật)',
      new_recipient_phone: '0987654321',
      edited_by: {
        id: '10',
        display_name: 'Nguyễn Văn A - Buyer',
      },
      edited_at: '2026-11-12T14:30:00.000Z',
      version: 2,
    },
    {
      id: '2',
      prev_recipient_name: 'Nguyễn Văn A (Cập nhật)',
      prev_recipient_phone: '0987654321',
      new_recipient_name: 'Trần Thị B',
      new_recipient_phone: '0901122334',
      edited_by: {
        id: '10',
        display_name: 'Nguyễn Văn A - Buyer',
      },
      edited_at: '2026-11-13T09:15:00.000Z',
      version: 3,
    },
  ];
}

// ---------------------------------------------------------------------------
// Challenger Adversarial Security Test Suite
// ---------------------------------------------------------------------------
describe('Adversarial Security Suite: GET /api/v1/quote-requests/:id/contact-history (Task 15: SEC-06, SEC-05, BR-04, BR-11, RFC 9457)', () => {
  const identityMock = new MockIdentityContract();
  const txRunner = new MockTransactionRunner();

  const mockQuoteRequestRepo = {
    findById: vi.fn(),
    findDetailById: vi.fn(),
  };

  const mockContactEditHistoryRepo = {
    findEventsWithPagination: vi.fn(),
  };

  const mockAllocationRepo = {
    findByRequestAndWorkshop: vi.fn(),
  };

  let app: NestExpressApplication;
  let base: string;
  let useCase: GetContactHistoryUseCase;

  class TestIdentityModule {}
  Module({
    providers: [{ provide: IDENTITY_CONTRACT, useValue: identityMock }],
    exports: [IDENTITY_CONTRACT],
  })(TestIdentityModule);

  class TestAppModule {}
  Module({
    imports: [AppConfigModule, SecurityModule.register([TestIdentityModule])],
    controllers: [QuoteRequestController],
    providers: [
      { provide: TRANSACTION_RUNNER, useValue: txRunner },
      { provide: QUOTE_REQUEST_REPOSITORY, useValue: mockQuoteRequestRepo },
      {
        provide: CONTACT_EDIT_HISTORY_REPOSITORY,
        useValue: mockContactEditHistoryRepo,
      },
      { provide: ALLOCATION_REPOSITORY, useValue: mockAllocationRepo },
      {
        provide: GetQuoteRequestByIdUseCase,
        useFactory: (runner: any, repo: any) =>
          new GetQuoteRequestByIdUseCase(runner, repo),
        inject: [TRANSACTION_RUNNER, QUOTE_REQUEST_REPOSITORY],
      },
      {
        provide: GetContactHistoryUseCase,
        useFactory: (
          runner: any,
          qRepo: any,
          cRepo: any,
          aRepo: any,
        ) => new GetContactHistoryUseCase(runner, qRepo, cRepo, aRepo),
        inject: [
          TRANSACTION_RUNNER,
          QUOTE_REQUEST_REPOSITORY,
          CONTACT_EDIT_HISTORY_REPOSITORY,
          ALLOCATION_REPOSITORY,
        ],
      },
    ],
  })(TestAppModule);

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/test');
    vi.stubEnv(
      'SESSION_SECRET',
      'test_secret_32_chars_for_development_purposes',
    );
    vi.stubEnv('NODE_ENV', 'development');

    app = await NestFactory.create<NestExpressApplication>(TestAppModule, {
      bodyParser: false,
      logger: false,
      abortOnError: false,
    });
    configureHttp(app, new AppLogger('error', (_line, done) => done()));
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()) + '/api/v1';

    useCase = new GetContactHistoryUseCase(
      txRunner,
      mockQuoteRequestRepo as unknown as IQuoteRequestRepository,
      mockContactEditHistoryRepo as unknown as IContactEditHistoryRepository,
      mockAllocationRepo as unknown as IAllocationRepository,
    );
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // DIMENSION 1: Anti-IDOR & Multi-Tenant Isolation (SEC-06)
  // =========================================================================
  describe('Dimension 1: Anti-IDOR & Multi-Tenant Isolation (SEC-06)', () => {
    it('SEC-CHALLENGE-01: Foreign Buyer attempts IDOR on another Buyer QuoteRequest -> Uniform HTTP 404 RESOURCE_NOT_FOUND (never 403)', async () => {
      const request = buildQuoteRequestEntity({ id: '100', buyer_id: '10' });
      mockQuoteRequestRepo.findById.mockResolvedValue(request);

      // 1. Direct use-case layer challenge
      await expect(
        useCase.execute({
          actor: hostileBuyerActor,
          requestId: '100',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      // 2. HTTP layer challenge
      identityMock.resolveSession.mockResolvedValueOnce(hostileBuyerActor);
      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-hostile-buyer' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
      expect(json.status).toBe(404);
      expect(json.type).toBe('urn:vcraft:problem:RESOURCE_NOT_FOUND');
      // Ensure repository pagination was not executed
      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('SEC-CHALLENGE-02: Artisan completely uninvited attempts access -> Uniform HTTP 404 RESOURCE_NOT_FOUND', async () => {
      const request = buildQuoteRequestEntity({ id: '100', buyer_id: '10' });
      mockQuoteRequestRepo.findById.mockResolvedValue(request);
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValue(null);

      // 1. Unit layer
      await expect(
        useCase.execute({
          actor: artisanUninvitedActor,
          requestId: '100',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      // 2. HTTP layer
      identityMock.resolveSession.mockResolvedValueOnce(artisanUninvitedActor);
      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-artisan-uninvited' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
      expect(json.status).toBe(404);
      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('SEC-CHALLENGE-03: Artisan invited in RequestRecipient (pending/quoted/declined) but NEVER allocated -> Uniform HTTP 404 RESOURCE_NOT_FOUND', async () => {
      const request = buildQuoteRequestEntity({ id: '100', buyer_id: '10' });
      mockQuoteRequestRepo.findById.mockResolvedValue(request);
      // Artisan 300 was invited but no Allocation exists for workshop 300
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValue(null);

      // 1. Unit layer
      await expect(
        useCase.execute({
          actor: artisanInvitedUnallocatedActor,
          requestId: '100',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      // 2. HTTP layer
      identityMock.resolveSession.mockResolvedValueOnce(artisanInvitedUnallocatedActor);
      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-artisan-invited-unallocated' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
      expect(json.status).toBe(404);
      expect(mockAllocationRepo.findByRequestAndWorkshop).toHaveBeenCalledWith('100', '300', expect.anything());
      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('SEC-CHALLENGE-04: Artisan with won Allocation on Request X attempts to read contact history of Request Y -> Uniform HTTP 404 RESOURCE_NOT_FOUND', async () => {
      // Request Y is id '100'
      const requestY = buildQuoteRequestEntity({ id: '100', buyer_id: '10' });
      mockQuoteRequestRepo.findById.mockResolvedValue(requestY);
      // Workshop 500 won Request X (200), but has NO allocation on Request Y (100)
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValue(null);

      // 1. Unit layer
      await expect(
        useCase.execute({
          actor: artisanWonOtherRequestActor,
          requestId: '100',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      // 2. HTTP layer
      identityMock.resolveSession.mockResolvedValueOnce(artisanWonOtherRequestActor);
      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-artisan-won-other' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
      expect(json.status).toBe(404);
      expect(mockAllocationRepo.findByRequestAndWorkshop).toHaveBeenCalledWith('100', '500', expect.anything());
      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('SEC-CHALLENGE-05: Non-existent QuoteRequest ID -> Uniform HTTP 404 RESOURCE_NOT_FOUND', async () => {
      mockQuoteRequestRepo.findById.mockResolvedValue(null);

      // 1. Unit layer
      await expect(
        useCase.execute({
          actor: buyerOwnerActor,
          requestId: '999999',
        }),
      ).rejects.toThrow(QuoteRequestNotFoundError);

      // 2. HTTP layer
      identityMock.resolveSession.mockResolvedValueOnce(buyerOwnerActor);
      const res = await fetch(`${base}/quote-requests/999999/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe('RESOURCE_NOT_FOUND');
      expect(json.status).toBe(404);
    });

    it('SEC-CHALLENGE-06: Anti-Oracle Parity: Responses for (non-existent ID), (unauthorized Buyer), and (unallocated Artisan) are strictly indistinguishable', async () => {
      const request = buildQuoteRequestEntity({ id: '100', buyer_id: '10' });

      // Scenario A: Non-existent ID
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(null);
      identityMock.resolveSession.mockResolvedValueOnce(buyerOwnerActor);
      const resNonExistent = await fetch(`${base}/quote-requests/999999/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });
      const jsonNonExistent = await resNonExistent.json();

      // Scenario B: Foreign Buyer
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      identityMock.resolveSession.mockResolvedValueOnce(hostileBuyerActor);
      const resForeignBuyer = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-hostile-buyer' },
      });
      const jsonForeignBuyer = await resForeignBuyer.json();

      // Scenario C: Unallocated Artisan
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValueOnce(null);
      identityMock.resolveSession.mockResolvedValueOnce(artisanInvitedUnallocatedActor);
      const resUnallocatedArtisan = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-artisan-invited-unallocated' },
      });
      const jsonUnallocatedArtisan = await resUnallocatedArtisan.json();

      // Anti-Oracle Proof: All 3 statuses must be 404
      expect(resNonExistent.status).toBe(404);
      expect(resForeignBuyer.status).toBe(404);
      expect(resUnallocatedArtisan.status).toBe(404);

      // Anti-Oracle Proof: All 3 payload structures and error codes are identical
      expect(jsonNonExistent.code).toBe(jsonForeignBuyer.code);
      expect(jsonForeignBuyer.code).toBe(jsonUnallocatedArtisan.code);
      expect(jsonNonExistent.code).toBe('RESOURCE_NOT_FOUND');

      expect(jsonNonExistent.title).toBe(jsonForeignBuyer.title);
      expect(jsonForeignBuyer.title).toBe(jsonUnallocatedArtisan.title);

      expect(jsonNonExistent.type).toBe(jsonForeignBuyer.type);
      expect(jsonForeignBuyer.type).toBe(jsonUnallocatedArtisan.type);

      expect(jsonNonExistent.detail).toBe(jsonForeignBuyer.detail);
      expect(jsonForeignBuyer.detail).toBe(jsonUnallocatedArtisan.detail);
    });

    it('SEC-CHALLENGE-07: Artisan account without workshopId is denied with TradingPermissionDeniedError (HTTP 403 PERMISSION_DENIED)', async () => {
      const request = buildQuoteRequestEntity({ id: '100', buyer_id: '10' });
      mockQuoteRequestRepo.findById.mockResolvedValue(request);

      // 1. Unit layer: throws TradingPermissionDeniedError
      await expect(
        useCase.execute({
          actor: artisanNoWorkshopActor,
          requestId: '100',
        }),
      ).rejects.toThrow(TradingPermissionDeniedError);

      // 2. HTTP layer: returns HTTP 403 PERMISSION_DENIED
      identityMock.resolveSession.mockResolvedValueOnce(artisanNoWorkshopActor);
      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-artisan-no-workshop' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
      expect(json.status).toBe(403);
      expect(json.type).toBe('urn:vcraft:problem:PERMISSION_DENIED');
      expect(mockAllocationRepo.findByRequestAndWorkshop).not.toHaveBeenCalled();
      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('SEC-CHALLENGE-08: Actor with invalid or spoofed role is rejected by Guards with HTTP 403', async () => {
      identityMock.resolveSession.mockResolvedValueOnce(spoofedRoleActor);
      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-spoofed-role' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('PERMISSION_DENIED');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // DIMENSION 2: Session Security & Temporary Password Policy (SEC-05)
  // =========================================================================
  describe('Dimension 2: Session Security & Temporary Password Policy (SEC-05)', () => {
    it('SEC-CHALLENGE-09: Buyer with temp_password session is denied access -> HTTP 403 TEMP_PASSWORD_RESTRICTED', async () => {
      // 1. Unit layer
      await expect(
        useCase.execute({
          actor: tempPasswordBuyerActor,
          requestId: '100',
        }),
      ).rejects.toThrow(TradingDomainError);

      // 2. HTTP layer
      identityMock.resolveSession.mockResolvedValueOnce(tempPasswordBuyerActor);
      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-temp-password-buyer' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
      expect(json.status).toBe(403);
      expect(json.type).toBe('urn:vcraft:problem:TEMP_PASSWORD_RESTRICTED');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('SEC-CHALLENGE-10: Artisan with temp_password session is denied access -> HTTP 403 TEMP_PASSWORD_RESTRICTED', async () => {
      // 1. Unit layer
      await expect(
        useCase.execute({
          actor: tempPasswordArtisanActor,
          requestId: '100',
        }),
      ).rejects.toThrow(TradingDomainError);

      // 2. HTTP layer
      identityMock.resolveSession.mockResolvedValueOnce(tempPasswordArtisanActor);
      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-temp-password-artisan' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
      expect(json.status).toBe(403);
      expect(json.type).toBe('urn:vcraft:problem:TEMP_PASSWORD_RESTRICTED');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });

    it('SEC-CHALLENGE-11: Admin with temp_password session is denied access -> HTTP 403 TEMP_PASSWORD_RESTRICTED', async () => {
      // 1. Unit layer
      await expect(
        useCase.execute({
          actor: tempPasswordAdminActor,
          requestId: '100',
        }),
      ).rejects.toThrow(TradingDomainError);

      // 2. HTTP layer
      identityMock.resolveSession.mockResolvedValueOnce(tempPasswordAdminActor);
      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-temp-password-admin' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('TEMP_PASSWORD_RESTRICTED');
      expect(json.status).toBe(403);
      expect(json.type).toBe('urn:vcraft:problem:TEMP_PASSWORD_RESTRICTED');
      expect(mockQuoteRequestRepo.findById).not.toHaveBeenCalled();
      expect(mockContactEditHistoryRepo.findEventsWithPagination).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // DIMENSION 3: Lifecycle Retention (BR-04, BR-11, api-design §10.4)
  // =========================================================================
  describe('Dimension 3: Lifecycle Retention (BR-04, BR-11, api-design §10.4)', () => {
    describe('Lifecycle Phase: CANCELLED (cancelled_at !== null)', () => {
      const cancelledRequest = buildQuoteRequestEntity({
        id: '100',
        buyer_id: '10',
        status: 'cancelled',
        cancelled_at: new Date('2026-11-13T10:00:00.000Z'),
        cancelled_by: '10',
        cancel_reason: 'Người mua chủ động hủy yêu cầu',
      });
      const events = buildSampleContactEvents();
      const allocation = buildAllocationEntity({
        requestId: '100',
        workshopId: '200',
      });

      it('SEC-CHALLENGE-12: Buyer owner retains access on cancelled QuoteRequest (HTTP 200 OK)', async () => {
        mockQuoteRequestRepo.findById.mockResolvedValueOnce(cancelledRequest);
        mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
          rows: events,
          totalRecords: 2,
        });

        identityMock.resolveSession.mockResolvedValueOnce(buyerOwnerActor);
        const res = await fetch(`${base}/quote-requests/100/contact-history`, {
          headers: { Cookie: 'vcraft-session=session-buyer-owner' },
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.data).toHaveLength(2);
        expect(json.pagination.total_records).toBe(2);
      });

      it('SEC-CHALLENGE-13: Admin retains access on cancelled QuoteRequest (HTTP 200 OK)', async () => {
        mockQuoteRequestRepo.findById.mockResolvedValueOnce(cancelledRequest);
        mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
          rows: events,
          totalRecords: 2,
        });

        identityMock.resolveSession.mockResolvedValueOnce(adminActor);
        const res = await fetch(`${base}/quote-requests/100/contact-history`, {
          headers: { Cookie: 'vcraft-session=session-admin' },
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.data).toHaveLength(2);
      });

      it('SEC-CHALLENGE-14: Won Artisan with Allocation retains access on cancelled QuoteRequest (HTTP 200 OK)', async () => {
        mockQuoteRequestRepo.findById.mockResolvedValueOnce(cancelledRequest);
        mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValueOnce(allocation);
        mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
          rows: events,
          totalRecords: 2,
        });

        identityMock.resolveSession.mockResolvedValueOnce(artisanWonAllocationActor);
        const res = await fetch(`${base}/quote-requests/100/contact-history`, {
          headers: { Cookie: 'vcraft-session=session-artisan-won-alloc' },
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.data).toHaveLength(2);
      });

      it('SEC-CHALLENGE-15: Non-owner Buyer on cancelled QuoteRequest is blocked -> HTTP 404 RESOURCE_NOT_FOUND', async () => {
        mockQuoteRequestRepo.findById.mockResolvedValueOnce(cancelledRequest);

        identityMock.resolveSession.mockResolvedValueOnce(hostileBuyerActor);
        const res = await fetch(`${base}/quote-requests/100/contact-history`, {
          headers: { Cookie: 'vcraft-session=session-hostile-buyer' },
        });

        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe('RESOURCE_NOT_FOUND');
      });

      it('SEC-CHALLENGE-16: Unallocated Artisan on cancelled QuoteRequest is blocked -> HTTP 404 RESOURCE_NOT_FOUND', async () => {
        mockQuoteRequestRepo.findById.mockResolvedValueOnce(cancelledRequest);
        mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValueOnce(null);

        identityMock.resolveSession.mockResolvedValueOnce(artisanInvitedUnallocatedActor);
        const res = await fetch(`${base}/quote-requests/100/contact-history`, {
          headers: { Cookie: 'vcraft-session=session-artisan-invited-unallocated' },
        });

        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe('RESOURCE_NOT_FOUND');
      });
    });

    describe('Lifecycle Phase: DELIVERED (status === "delivered")', () => {
      const deliveredRequest = buildQuoteRequestEntity({
        id: '100',
        buyer_id: '10',
        status: 'delivered',
        version: 5,
      });
      const events = buildSampleContactEvents();
      const allocation = buildAllocationEntity({
        requestId: '100',
        workshopId: '200',
      });

      it('SEC-CHALLENGE-17: Buyer owner retains access on delivered QuoteRequest (HTTP 200 OK)', async () => {
        mockQuoteRequestRepo.findById.mockResolvedValueOnce(deliveredRequest);
        mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
          rows: events,
          totalRecords: 2,
        });

        identityMock.resolveSession.mockResolvedValueOnce(buyerOwnerActor);
        const res = await fetch(`${base}/quote-requests/100/contact-history`, {
          headers: { Cookie: 'vcraft-session=session-buyer-owner' },
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.data).toHaveLength(2);
      });

      it('SEC-CHALLENGE-18: Admin retains access on delivered QuoteRequest (HTTP 200 OK)', async () => {
        mockQuoteRequestRepo.findById.mockResolvedValueOnce(deliveredRequest);
        mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
          rows: events,
          totalRecords: 2,
        });

        identityMock.resolveSession.mockResolvedValueOnce(adminActor);
        const res = await fetch(`${base}/quote-requests/100/contact-history`, {
          headers: { Cookie: 'vcraft-session=session-admin' },
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.data).toHaveLength(2);
      });

      it('SEC-CHALLENGE-19: Won Artisan with Allocation retains access on delivered QuoteRequest (HTTP 200 OK)', async () => {
        mockQuoteRequestRepo.findById.mockResolvedValueOnce(deliveredRequest);
        mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValueOnce(allocation);
        mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
          rows: events,
          totalRecords: 2,
        });

        identityMock.resolveSession.mockResolvedValueOnce(artisanWonAllocationActor);
        const res = await fetch(`${base}/quote-requests/100/contact-history`, {
          headers: { Cookie: 'vcraft-session=session-artisan-won-alloc' },
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.data).toHaveLength(2);
      });

      it('SEC-CHALLENGE-20: Non-owner Buyer on delivered QuoteRequest is blocked -> HTTP 404 RESOURCE_NOT_FOUND', async () => {
        mockQuoteRequestRepo.findById.mockResolvedValueOnce(deliveredRequest);

        identityMock.resolveSession.mockResolvedValueOnce(hostileBuyerActor);
        const res = await fetch(`${base}/quote-requests/100/contact-history`, {
          headers: { Cookie: 'vcraft-session=session-hostile-buyer' },
        });

        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe('RESOURCE_NOT_FOUND');
      });

      it('SEC-CHALLENGE-21: Unallocated Artisan on delivered QuoteRequest is blocked -> HTTP 404 RESOURCE_NOT_FOUND', async () => {
        mockQuoteRequestRepo.findById.mockResolvedValueOnce(deliveredRequest);
        mockAllocationRepo.findByRequestAndWorkshop.mockResolvedValueOnce(null);

        identityMock.resolveSession.mockResolvedValueOnce(artisanInvitedUnallocatedActor);
        const res = await fetch(`${base}/quote-requests/100/contact-history`, {
          headers: { Cookie: 'vcraft-session=session-artisan-invited-unallocated' },
        });

        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe('RESOURCE_NOT_FOUND');
      });
    });
  });

  // =========================================================================
  // DIMENSION 4: RFC 9457 Problem Details & Sensitive PII Leakage Penetration
  // =========================================================================
  describe('Dimension 4: RFC 9457 Problem Details & Sensitive PII Leakage Penetration', () => {
    it('SEC-CHALLENGE-22: Full RFC 9457 conformance check across 400, 401, 403, and 404 responses', async () => {
      // 1. HTTP 401: Unauthenticated request (no session cookie)
      const res401 = await fetch(`${base}/quote-requests/100/contact-history`);
      expect(res401.status).toBe(401);
      expect(res401.headers.get('content-type')).toContain('application/problem+json');
      const json401 = await res401.json();
      expect(json401).toMatchObject({
        type: 'urn:vcraft:problem:AUTHENTICATION_REQUIRED',
        status: 401,
        code: 'AUTHENTICATION_REQUIRED',
      });
      expect(typeof json401.title).toBe('string');
      expect(typeof json401.detail).toBe('string');
      expect(typeof json401.tracking_id).toBe('string');

      // 2. HTTP 400: Malformed requestId parameter (e.g. non-numeric string)
      identityMock.resolveSession.mockResolvedValueOnce(buyerOwnerActor);
      const res400 = await fetch(`${base}/quote-requests/invalid-not-numeric-id/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });
      expect(res400.status).toBe(400);
      expect(res400.headers.get('content-type')).toContain('application/problem+json');
      const json400 = await res400.json();
      expect(json400).toMatchObject({
        type: 'urn:vcraft:problem:INVALID_INPUT',
        status: 400,
        code: 'INVALID_INPUT',
      });
      expect(typeof json400.title).toBe('string');
      expect(typeof json400.detail).toBe('string');
      expect(typeof json400.tracking_id).toBe('string');

      // 3. HTTP 403: Temp password session restriction
      identityMock.resolveSession.mockResolvedValueOnce(tempPasswordBuyerActor);
      const res403 = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-temp-password-buyer' },
      });
      expect(res403.status).toBe(403);
      expect(res403.headers.get('content-type')).toContain('application/problem+json');
      const json403 = await res403.json();
      expect(json403).toMatchObject({
        type: 'urn:vcraft:problem:TEMP_PASSWORD_RESTRICTED',
        status: 403,
        code: 'TEMP_PASSWORD_RESTRICTED',
      });
      expect(typeof json403.title).toBe('string');
      expect(typeof json403.detail).toBe('string');
      expect(typeof json403.tracking_id).toBe('string');

      // 4. HTTP 404: Anti-IDOR non-existent or unauthorized access
      mockQuoteRequestRepo.findById.mockResolvedValueOnce(null);
      identityMock.resolveSession.mockResolvedValueOnce(buyerOwnerActor);
      const res404 = await fetch(`${base}/quote-requests/999999/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });
      expect(res404.status).toBe(404);
      expect(res404.headers.get('content-type')).toContain('application/problem+json');
      const json404 = await res404.json();
      expect(json404).toMatchObject({
        type: 'urn:vcraft:problem:RESOURCE_NOT_FOUND',
        status: 404,
        code: 'RESOURCE_NOT_FOUND',
      });
      expect(typeof json404.title).toBe('string');
      expect(typeof json404.detail).toBe('string');
      expect(typeof json404.tracking_id).toBe('string');
    });

    it('SEC-CHALLENGE-23: Deep PII & Secret Leakage Inspection: edited_by contains ONLY ActorDto { id, display_name } without account internals', async () => {
      const request = buildQuoteRequestEntity({ id: '100', buyer_id: '10' });
      const events = buildSampleContactEvents();

      mockQuoteRequestRepo.findById.mockResolvedValueOnce(request);
      mockContactEditHistoryRepo.findEventsWithPagination.mockResolvedValueOnce({
        rows: events,
        totalRecords: 2,
      });

      identityMock.resolveSession.mockResolvedValueOnce(buyerOwnerActor);
      const res = await fetch(`${base}/quote-requests/100/contact-history`, {
        headers: { Cookie: 'vcraft-session=session-buyer-owner' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toBeInstanceOf(Array);
      expect(json.data.length).toBeGreaterThan(0);

      const allExtractedKeys = extractAllKeys(json);

      // Verify that sensitive authentication or internal database fields NEVER appear
      const strictlyForbiddenKeys = [
        'password',
        'password_hash',
        'passwordHash',
        'salt',
        'email',
        'phone',
        'phone_number',
        'role',
        'authVersion',
        'auth_version',
        'session_id',
        'sessionLevel',
        'session_level',
        'workshopId',
        'workshop_id',
        'temp_password',
      ];

      for (const forbiddenKey of strictlyForbiddenKeys) {
        expect(allExtractedKeys.has(forbiddenKey)).toBe(false);
      }

      // Verify edited_by structure strictly matches ActorDto
      for (const item of json.data) {
        expect(item.edited_by).toBeDefined();
        expect(typeof item.edited_by.id).toBe('string');
        expect(
          typeof item.edited_by.display_name === 'string' ||
            item.edited_by.display_name === null,
        ).toBe(true);

        const editedByKeys = Object.keys(item.edited_by);
        expect(editedByKeys.sort()).toEqual(['display_name', 'id'].sort());
      }
    });
  });
});
