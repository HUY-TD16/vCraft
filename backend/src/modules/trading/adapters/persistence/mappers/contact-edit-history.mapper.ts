import type {
  ContactEditHistory as PrismaContactEditHistory,
  Prisma,
} from '../../../../../generated/prisma/client';
import type { Id } from '../../../../../common/application/types/contract-types';
import type {
  ActorDto,
  ContactEventDto,
  PersistedContactEditRecord,
} from '../../../application/dtos/trading-persistence.dtos';
import {
  type ContactEditRecord,
  EntityId,
  RecipientContact,
  Version,
} from '../../../domain';
import {
  bigintToId,
  dateToInstant,
  idToBigInt,
  optionalIdToBigInt,
  parseInstantOrDate,
  toActorDto,
} from './shared-persistence.mapper';

export class ContactEditHistoryMapper {
  static toDomain(row: PrismaContactEditHistory): PersistedContactEditRecord {
    const prevContact = RecipientContact.of(
      row.prev_recipient_name,
      row.prev_recipient_phone,
    );
    const newContact = RecipientContact.of(
      row.new_recipient_name,
      row.new_recipient_phone,
    );

    return Object.freeze({
      id: bigintToId(row.id, 'contact_edit_history.id'),
      request_id: bigintToId(row.request_id, 'contact_edit_history.request_id'),
      edited_by: bigintToId(row.edited_by, 'contact_edit_history.edited_by'),
      prev_recipient_name: prevContact.recipientName,
      prev_recipient_phone: prevContact.recipientPhone,
      new_recipient_name: newContact.recipientName,
      new_recipient_phone: newContact.recipientPhone,
      edited_at: parseInstantOrDate(
        row.edited_at,
        'contact_edit_history.edited_at',
      ),
      version: Version.of(row.version, 'contact_edit_history.version').value,
    });
  }

  static toPrismaCreateInput(
    record: ContactEditRecord & { readonly id?: Id },
  ): Prisma.ContactEditHistoryUncheckedCreateInput {
    const prevContact = RecipientContact.of(
      record.prev_recipient_name,
      record.prev_recipient_phone,
    );
    const newContact = RecipientContact.of(
      record.new_recipient_name,
      record.new_recipient_phone,
    );
    const version = Version.of(
      record.version,
      'contact_edit_history.version',
    ).value;

    return {
      ...(record.id !== undefined
        ? { id: optionalIdToBigInt(record.id, 'contact_edit_history.id') }
        : {}),
      request_id: idToBigInt(
        record.request_id,
        'contact_edit_history.request_id',
      ),
      edited_by: idToBigInt(record.edited_by, 'contact_edit_history.edited_by'),
      prev_recipient_name: prevContact.recipientName,
      prev_recipient_phone: prevContact.recipientPhone,
      new_recipient_name: newContact.recipientName,
      new_recipient_phone: newContact.recipientPhone,
      edited_at: parseInstantOrDate(
        record.edited_at,
        'contact_edit_history.edited_at',
      ),
      version,
    };
  }

  static toDto(
    record: PersistedContactEditRecord,
    editedByActor: ActorDto,
  ): ContactEventDto {
    return Object.freeze({
      id: EntityId.of(record.id, 'contact_edit_history.id').value,
      prev_recipient_name: record.prev_recipient_name,
      prev_recipient_phone: record.prev_recipient_phone,
      new_recipient_name: record.new_recipient_name,
      new_recipient_phone: record.new_recipient_phone,
      edited_by: toActorDto(editedByActor),
      edited_at: dateToInstant(
        record.edited_at,
        'contact_edit_history.edited_at',
      ),
      version: record.version,
    });
  }

  static fromPrismaWithActorToDto(
    row: PrismaContactEditHistory & {
      readonly editedBy: {
        readonly id: bigint;
        readonly display_name: string | null;
      };
    },
  ): ContactEventDto {
    const domain = ContactEditHistoryMapper.toDomain(row);
    return ContactEditHistoryMapper.toDto(domain, toActorDto(row.editedBy));
  }
}
