import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';
import { NumericIdSchema, PaginationQuerySchema } from '../../../../../common/validators/common-schemas';

export const ListPublicWorkshopsQuerySchema = PaginationQuerySchema.extend({
  search: z.string().trim().optional(),
  accepting_visitors: z.preprocess(
    val => (val === 'true' ? true : val === 'false' ? false : val),
    z.boolean().optional(),
  ),
});

export class ListPublicWorkshopsQueryDto extends createZodDto(ListPublicWorkshopsQuerySchema) {}

export const UpdateWorkshopProfileSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    story: z.string().trim().max(5000).nullable().optional(),
    address: z.string().trim().max(500).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    avatar_image_id: NumericIdSchema.nullable().optional(),
    image_ids: z.array(NumericIdSchema).default([]),
    certificates: z
      .array(
        z.strictObject({
          id: NumericIdSchema.optional(),
          name: z.string().trim().min(1).max(200),
          image_id: NumericIdSchema,
        }),
      )
      .default([]),
  })
  .refine(
    data => {
      const hasLat = data.latitude !== null && data.latitude !== undefined;
      const hasLng = data.longitude !== null && data.longitude !== undefined;
      return (hasLat && hasLng) || (!hasLat && !hasLng);
    },
    {
      message: 'Latitude and longitude must both be present or both null.',
      path: ['latitude'],
    },
  )
  .refine(
    data => {
      if (data.avatar_image_id && data.image_ids) {
        return data.image_ids.includes(data.avatar_image_id);
      }
      return true;
    },
    {
      message: 'avatar_image_id must be included in image_ids.',
      path: ['avatar_image_id'],
    },
  );

export class UpdateWorkshopProfileDto extends createZodDto(UpdateWorkshopProfileSchema) {}

export const UpdateWorkshopVisitorsSchema = z.strictObject({
  accepting_visitors: z.boolean(),
});

export class UpdateWorkshopVisitorsDto extends createZodDto(UpdateWorkshopVisitorsSchema) {}

export const ListAdminWorkshopsQuerySchema = PaginationQuerySchema.extend({
  search: z.string().trim().optional(),
  status: z.enum(['active', 'suspended']).optional(),
});

export class ListAdminWorkshopsQueryDto extends createZodDto(ListAdminWorkshopsQuerySchema) {}

export const ChangeWorkshopStatusSchema = z.strictObject({
  status: z.enum(['active', 'suspended']),
  reason: z.string().trim().min(1, 'Reason is required.'),
});

export class ChangeWorkshopStatusDto extends createZodDto(ChangeWorkshopStatusSchema) {}

export class PaginationQueryDto extends createZodDto(PaginationQuerySchema) {}
