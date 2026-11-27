import type { TransactionContext } from '../../../../common/application/ports/transaction-runner';
import type {
  AttachInitialWorkshopScopeInput,
  GetImageDtoInput,
  ImageDto,
  ReplaceImagesInput,
  RetainHistoryImagesInput,
} from '../dtos/media.dto';

export const MEDIA_CONTRACT = Symbol('MEDIA_CONTRACT');

export interface IMediaContract {
  /** Replaces the image set atomically with the caller's workflow transaction. */
  replaceImages(input: ReplaceImagesInput, tx: TransactionContext): Promise<void>;
  /** Retains the previous journal image set so edits remain readable in history. */
  retainHistoryImages(input: RetainHistoryImagesInput, tx: TransactionContext): Promise<void>;
  /** Transfers selected images from an Admin's initial upload scope to a newly created workshop. */
  attachInitialWorkshopScope(input: AttachInitialWorkshopScopeInput, tx: TransactionContext): Promise<void>;
  /** Builds safe image URLs only when the caller is allowed to read the requested context. */
  getImageDto(input: GetImageDtoInput, tx: TransactionContext): Promise<ImageDto | null>;
}
