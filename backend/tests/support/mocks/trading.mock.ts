import type { ITradingContract } from '../../../src/modules/trading/public/contracts/trading.contract';
import { unconfigured } from './unconfigured';

export class MockTradingContract implements ITradingContract {
  readonly findAcceptanceReplay = unconfigured<ITradingContract['findAcceptanceReplay']>('ITradingContract.findAcceptanceReplay');
  readonly prepareAcceptance = unconfigured<ITradingContract['prepareAcceptance']>('ITradingContract.prepareAcceptance');
  readonly accept = unconfigured<ITradingContract['accept']>('ITradingContract.accept');
}
