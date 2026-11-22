import { z } from 'zod';
import { createZodDto } from '../../../../../common/http/pipes/global-validation.pipe';
import { MAX_ADMIN_HANDOVER_TEXT_LENGTH } from '../../../domain/entities/allocation.entity';
import {
  ALLOCATION_STATUSES,
  REQUEST_STATUSES,
} from '../../../domain/value-objects/trading-enums';

/**
 * Request DTO for `POST /api/v1/admin/allocations/:id/handover-by-admin`
 * (`docsAI/04-architecture/api-design.md` §9.6, §10.5; `UC-24`, `BR-24`, `BR-27`).
 * Maps `reason` -> `Allocation.admin_handover_reason`,
 * `evidence` -> `Allocation.admin_delivery_evidence`,
 * `actual_handover_at` -> `Allocation.admin_handover_actual_at`.
 */
export const handoverAllocationByAdminSchema = z.strictObject({
  expected_allocation_version: z.int().min(1).max(2_147_483_647),
  reason: z.string().trim().min(1).max(MAX_ADMIN_HANDOVER_TEXT_LENGTH),
  evidence: z.string().trim().min(1).max(MAX_ADMIN_HANDOVER_TEXT_LENGTH),
  actual_handover_at: z.string().datetime({ offset: true }),
});

export const recordAdminHandoverSchema = handoverAllocationByAdminSchema;

export class HandoverAllocationByAdminDto extends createZodDto(
  handoverAllocationByAdminSchema,
) {}

export { HandoverAllocationByAdminDto as RecordAdminHandoverDto };

import { allocationOperationResponseSchema } from './trading-openapi-response.schemas';
export const handoverAllocationByAdminOperationResponseSchema = allocationOperationResponseSchema;

export const recordAdminHandoverOperationResponseSchema =
  handoverAllocationByAdminOperationResponseSchema;
