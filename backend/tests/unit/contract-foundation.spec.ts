import { Module, type ArgumentsHost } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { BusinessRuleException } from '../../src/common/domain/errors/business-rule.exception';
import { ProblemDetailsFilter } from '../../src/common/http/filters/problem-details.filter';
import { WorkshopsModule } from '../../src/modules/workshops/workshops.module';
import { WORKSHOP_CONTRACT } from '../../src/modules/workshops/public/contracts/workshop.contract';
import { MockWorkshopContract } from '../support/mocks/workshop.mock';
import { MockCatalogContract } from '../support/mocks/catalog.mock';
import { MockTransactionRunner } from '../support/mocks/transaction-runner.mock';

describe('contract foundations', () => {
  it('maps a provider business error to Problem Details without exposing internal messages', () => {
    const response = {
      status: vi.fn().mockReturnThis(), type: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn(), removeHeader: vi.fn(),
    };
    const error = new BusinessRuleException('WORKSHOP_SUSPENDED');
    error.message = 'private implementation details';
    const host = { switchToHttp: () => ({ getResponse: () => response }) } as ArgumentsHost;
    new ProblemDetailsFilter().catch(error, host);
    expect(response.status).toHaveBeenCalledWith(422);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'WORKSHOP_SUSPENDED', status: 422 }));
    expect(JSON.stringify(response.json.mock.calls)).not.toContain(error.message);
  });

  it('uses one implementation instance for both the class and contract token', async () => {
    const definition = WorkshopsModule.register(MockWorkshopContract);
    @Module({ providers: definition.providers, exports: definition.exports })
    class IsolatedWorkshopModule {}
    const app = await NestFactory.createApplicationContext(IsolatedWorkshopModule, { logger: false });
    try {
      expect(app.get(WORKSHOP_CONTRACT)).toBe(app.get(MockWorkshopContract));
    } finally {
      await app.close();
    }
  });

  it('returns unique numerically sorted eligible ids and preserves transaction identity', async () => {
    const catalog = new MockCatalogContract().givenEligibleWorkshops('1', '10', '2', '2');
    await new MockTransactionRunner().run(async tx => {
      expect(await catalog.findEligibleWorkshopIds({ categoryId: '1' }, tx)).toEqual(['2', '10']);
      expect(catalog.findEligibleWorkshopIds).toHaveBeenCalledWith({ categoryId: '1' }, tx);
      await expect(catalog.assertEligibleWorkshops({ categoryId: '1', workshopIds: ['3'] }, tx))
        .rejects.toEqual(new BusinessRuleException('NO_ELIGIBLE_WORKSHOP'));
    });
  });
});
