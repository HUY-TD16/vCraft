import { tradingContractSuite } from './trading.contract-suite';
import { MockTradingContract } from '../support/mocks/trading.mock';
import { MockTransactionRunner } from '../support/mocks/transaction-runner.mock';
import type {
  AcceptanceDto,
  AcceptanceOperationDto,
} from '../../src/modules/trading/public/dtos/acceptance.dto';
import { BusinessRuleException } from '../../src/common/domain/errors/business-rule.exception';

const sampleData: AcceptanceDto = {
  request_id: '1001',
  request_status: 'buyer_accepted',
  request_version: 4,
  allocations: [
    {
      id: '5001',
      request_id: '1001',
      workshop: { id: '301', name: 'Xưởng Gốm Minh Long' },
      quote_id: '401',
      quantity: 100,
      unit_price: 150000,
      committed_delivery_at: '2026-11-28T08:00:00.000Z',
      status: 'not_started',
      version: 1,
      started_at: null,
      started_by: null,
      handed_over_at: null,
      handed_over_by: null,
      delivery_note: null,
      admin_handed_over: false,
      admin_handover_reason: null,
      admin_delivery_evidence: null,
      admin_handover_actual_at: null,
      traceability_warning: 'NO_BATCH_LINK',
    },
  ],
};

const sampleOperation: AcceptanceOperationDto = {
  id: '9001',
  replayed: false,
  committed_at: '2026-11-18T10:00:00.000Z',
  current_state: {
    request: {
      id: '1001',
      status: 'buyer_accepted',
      version: 4,
      cancelled_at: null,
    },
    quote: {
      id: '401',
      status: 'accepted',
      version: 2,
    },
  },
};

tradingContractSuite('Trading mock contract', async () => {
  const mockTrading = new MockTradingContract();
  let replayRecord: {
    data: AcceptanceDto;
    operation: AcceptanceOperationDto;
  } | null = null;

  mockTrading.findAcceptanceReplay.mockImplementation(async () => {
    return replayRecord;
  });

  mockTrading.prepareAcceptance.mockImplementation(async (input) => {
    if (input.quoteId === 'missing') {
      throw new BusinessRuleException('RESOURCE_NOT_FOUND');
    }
    return { workshopIds: ['301'] };
  });

  mockTrading.accept.mockImplementation(async () => {
    replayRecord = {
      data: sampleData,
      operation: {
        ...sampleOperation,
        replayed: true,
      },
    };
    return {
      data: sampleData,
      operation: sampleOperation,
    };
  });

  return {
    contract: mockTrading,
    runner: new MockTransactionRunner(),
    validInput: {
      requestId: '1001',
      expectedRequestVersion: 3,
      actor: {
        accountId: '10',
        role: 'buyer',
        workshopId: null,
        authVersion: 1,
        sessionId: 'sess-buyer',
      },
      quoteId: '401',
      expectedQuoteVersion: 1,
      idempotencyKey: '11111111-2222-4333-8444-555555555555',
    },
    invalidQuoteInput: {
      requestId: '1001',
      expectedRequestVersion: 3,
      actor: {
        accountId: '10',
        role: 'buyer',
        workshopId: null,
        authVersion: 1,
        sessionId: 'sess-buyer',
      },
      quoteId: 'missing',
      expectedQuoteVersion: 1,
      idempotencyKey: '11111111-2222-4333-8444-555555555555',
    },
    dispose: async () => {},
  };
});
