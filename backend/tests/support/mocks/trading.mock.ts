import type { ITradingContract } from '../../../src/modules/trading/public/contracts/trading.contract';
import type {
  AcceptanceDto,
  AcceptanceOperationDto,
} from '../../../src/modules/trading/public/dtos/acceptance.dto';
import type { Id } from '../../../src/common/application/types/contract-types';
import { unconfigured } from './unconfigured';

export class MockTradingContract implements ITradingContract {
  readonly findAcceptanceReplay = unconfigured<
    ITradingContract['findAcceptanceReplay']
  >('ITradingContract.findAcceptanceReplay');
  readonly prepareAcceptance = unconfigured<
    ITradingContract['prepareAcceptance']
  >('ITradingContract.prepareAcceptance');
  readonly accept = unconfigured<ITradingContract['accept']>(
    'ITradingContract.accept',
  );

  givenPreparedWorkshops(...workshopIds: Id[]): this {
    this.prepareAcceptance.mockResolvedValue({ workshopIds: [...workshopIds] });
    return this;
  }

  givenReplay(
    replay: { data: AcceptanceDto; operation: AcceptanceOperationDto } | null,
  ): this {
    this.findAcceptanceReplay.mockResolvedValue(replay);
    return this;
  }

  givenAcceptSuccess(result: {
    data: AcceptanceDto;
    operation: AcceptanceOperationDto;
  }): this {
    this.accept.mockResolvedValue(result);
    return this;
  }
}
