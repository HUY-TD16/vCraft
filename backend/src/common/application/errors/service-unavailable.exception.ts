export type ServiceUnavailableCode =
  | 'SECURITY_SERVICE_UNAVAILABLE'
  | 'STORAGE_CAPACITY_LOW'
  | 'IMAGE_PROCESSING_UNAVAILABLE';

export class ServiceUnavailableException extends Error {
  constructor(readonly code: ServiceUnavailableCode) {
    super(code);
    this.name = 'ServiceUnavailableException';
  }
}
