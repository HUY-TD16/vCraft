import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { statusByCode } from '../filters/api-problem';

export const problemSchema: SchemaObject = {
  type: 'object', required: ['type', 'title', 'status', 'detail', 'code', 'tracking_id'],
  properties: {
    type: { type: 'string', format: 'uri', example: 'urn:vcraft:problem:INVALID_INPUT' },
    title: { type: 'string', example: 'Dữ liệu không hợp lệ' },
    status: { type: 'integer', example: 400 },
    detail: { type: 'string', example: 'Kiểm tra lại dữ liệu đã gửi.' },
    code: { type: 'string', enum: Object.keys(statusByCode) },
    tracking_id: { type: 'string', format: 'uuid' },
    errors: { type: 'array', description: 'Chỉ xuất hiện khi validation thất bại.', items: {
      type: 'object', required: ['field', 'message'], properties: {
        field: { type: 'string', description: 'JSON Pointer', example: '/items/0/quantity' },
        message: { type: 'string', example: 'Giá trị không đúng định dạng hoặc giới hạn cho phép.' },
      },
    } },
  },
};

export const paginationSchema: SchemaObject = {
  type: 'object', required: ['page', 'limit', 'total_records', 'total_pages'],
  properties: {
    page: { type: 'integer', minimum: 1, example: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, example: 20 },
    total_records: { type: 'integer', minimum: 0, example: 0 },
    total_pages: { type: 'integer', minimum: 0, example: 0 },
  },
};

export const requestIdHeader = {
  description: 'UUID do backend cấp; trùng tracking_id trong lỗi và request_id trong log.',
  schema: { type: 'string', format: 'uuid' } as SchemaObject,
};
