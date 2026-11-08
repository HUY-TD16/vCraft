import { BusinessRuleException } from '../../../../common/domain/errors/business-rule.exception';

export class WorkshopSuspended extends BusinessRuleException {
  constructor() {
    super('WORKSHOP_SUSPENDED', 'Workshop is suspended.');
  }
}
