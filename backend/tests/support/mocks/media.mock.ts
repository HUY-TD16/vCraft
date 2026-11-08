import type { IMediaContract } from '../../../src/modules/media/public/contracts/media.contract';
import { unconfigured } from './unconfigured';

export class MockMediaContract implements IMediaContract {
  readonly replaceImages = unconfigured<IMediaContract['replaceImages']>('IMediaContract.replaceImages');
  readonly retainHistoryImages = unconfigured<IMediaContract['retainHistoryImages']>('IMediaContract.retainHistoryImages');
  readonly attachInitialWorkshopScope = unconfigured<IMediaContract['attachInitialWorkshopScope']>('IMediaContract.attachInitialWorkshopScope');
  readonly getImageDto = unconfigured<IMediaContract['getImageDto']>('IMediaContract.getImageDto');
}
