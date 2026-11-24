import { BusinessRuleException, type BusinessRuleCode, type BusinessRuleDetails } from '../../domain/errors/business-rule.exception';

export async function findOrThrow<T>(
  finder: () => Promise<T | null | undefined>,
  errorCode: BusinessRuleCode = 'RESOURCE_NOT_FOUND',
  details: BusinessRuleDetails = {},
): Promise<T> {
  const record = await finder();
  if (record === null || record === undefined) {
    throw new BusinessRuleException(errorCode, errorCode, details);
  }
  return record;
}

export function toBigIntId(id: string | bigint): bigint {
  if (typeof id === 'bigint') return id;
  const trimmed = String(id).trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new BusinessRuleException('INVALID_INPUT', 'INVALID_INPUT', { field: 'id' });
  }
  return BigInt(trimmed);
}
