import type {
  Prisma,
  RequestRecipient as PrismaRequestRecipient,
} from '../../../../../generated/prisma/client';
import type {
  RecipientDto,
  WorkshopRefDto,
} from '../../../application/dtos/trading-persistence.dtos';
import {
  type IneligibleQuoteReason,
  RECIPIENT_RESPONSE_STATUSES,
  RequestRecipient,
} from '../../../domain';
import {
  assertEnumValue,
  bigintToId,
  dateToInstant,
  idToBigInt,
  nullableBigintToId,
  nullableDateToInstant,
  nullableIdToBigInt,
  optionalIdToBigInt,
  toWorkshopRefDto,
} from './shared-persistence.mapper';

export class RequestRecipientMapper {
  static toDomain(row: PrismaRequestRecipient): RequestRecipient {
    return RequestRecipient.reconstitute({
      id: bigintToId(row.id, 'request_recipient.id'),
      request_id: bigintToId(row.request_id, 'request_recipient.request_id'),
      workshop_id: bigintToId(row.workshop_id, 'request_recipient.workshop_id'),
      response_status: assertEnumValue(
        row.response_status,
        RECIPIENT_RESPONSE_STATUSES,
        'request_recipient.response_status',
      ),
      decline_reason: row.decline_reason ?? null,
      responded_by: nullableBigintToId(
        row.responded_by,
        'request_recipient.responded_by',
      ),
      responded_at: row.responded_at ?? null,
      sent_at: row.sent_at,
      version: row.version,
    });
  }

  static toPrismaCreateInput(
    input: {
      readonly id?: string;
      readonly request_id: string;
      readonly workshop_id: string;
      readonly response_status?: string;
      readonly decline_reason?: string | null;
      readonly responded_by?: string | null;
      readonly responded_at?: Date | null;
      readonly sent_at: Date;
      readonly version?: number;
    },
    includeId: boolean = true,
  ): Prisma.RequestRecipientUncheckedCreateInput {
    const status = assertEnumValue(
      input.response_status ?? 'pending',
      RECIPIENT_RESPONSE_STATUSES,
      'request_recipient.response_status',
    );
    return {
      ...(includeId && input.id !== undefined
        ? { id: optionalIdToBigInt(input.id, 'request_recipient.id') }
        : {}),
      request_id: idToBigInt(input.request_id, 'request_recipient.request_id'),
      workshop_id: idToBigInt(
        input.workshop_id,
        'request_recipient.workshop_id',
      ),
      response_status: status,
      decline_reason: input.decline_reason ?? null,
      responded_by: nullableIdToBigInt(
        input.responded_by,
        'request_recipient.responded_by',
      ),
      responded_at: input.responded_at ?? null,
      sent_at: input.sent_at,
      version: input.version ?? 1,
    };
  }

  static toPrismaUpdateInput(
    entity: RequestRecipient,
  ): Prisma.RequestRecipientUncheckedUpdateManyInput {
    return {
      response_status: entity.response_status,
      decline_reason: entity.decline_reason,
      responded_by: nullableIdToBigInt(
        entity.responded_by,
        'request_recipient.responded_by',
      ),
      responded_at: entity.responded_at,
      version: entity.version,
    };
  }

  static toDto(
    entity: RequestRecipient,
    context: {
      readonly workshop: WorkshopRefDto;
      readonly eligibilityLabels?: readonly IneligibleQuoteReason[];
    },
  ): RecipientDto {
    return Object.freeze({
      id: entity.id,
      request_id: entity.request_id,
      workshop: toWorkshopRefDto(context.workshop),
      response_status: entity.response_status,
      version: entity.version,
      sent_at: dateToInstant(entity.sent_at, 'sent_at'),
      responded_at: nullableDateToInstant(entity.responded_at, 'responded_at'),
      decline_reason: entity.decline_reason,
      eligibility_labels: Object.freeze([...(context.eligibilityLabels ?? [])]),
    });
  }
}
