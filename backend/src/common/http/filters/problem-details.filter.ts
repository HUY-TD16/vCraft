import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { InputValidationError } from '../pipes/zod-validation.pipe';
import { ApiProblem } from './api-problem';

const problems = {
  400: ['INVALID_INPUT', 'Dữ liệu không hợp lệ', 'Kiểm tra lại dữ liệu đã gửi.'],
  401: ['AUTHENTICATION_REQUIRED', 'Cần đăng nhập', 'Vui lòng đăng nhập để tiếp tục.'],
  403: ['PERMISSION_DENIED', 'Không có quyền', 'Bạn không có quyền thực hiện thao tác này.'],
  404: ['RESOURCE_NOT_FOUND', 'Không tìm thấy tài nguyên', 'Tài nguyên yêu cầu không tồn tại hoặc không thể truy cập.'],
  409: ['CONCURRENCY_CONFLICT', 'Xung đột dữ liệu', 'Tải lại dữ liệu trước khi thử lại.'],
  413: ['PAYLOAD_TOO_LARGE', 'Dữ liệu quá lớn', 'Giảm kích thước dữ liệu rồi thử lại.'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'Kiểu nội dung không được hỗ trợ', 'Kiểm tra Content-Type của yêu cầu.'],
  422: ['INVALID_STATE', 'Trạng thái không hợp lệ', 'Thao tác không phù hợp với trạng thái hiện tại.'],
  429: ['RATE_LIMIT_EXCEEDED', 'Quá nhiều yêu cầu', 'Vui lòng thử lại sau.'],
  500: ['INTERNAL_SERVER_ERROR', 'Lỗi hệ thống', 'Cung cấp mã tra cứu khi liên hệ hỗ trợ.'],
  503: ['SECURITY_SERVICE_UNAVAILABLE', 'Dịch vụ tạm thời gián đoạn', 'Vui lòng thử lại sau.'],
} as const;

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    let status = 500;
    if (error instanceof HttpException) {
      status = error.getStatus();
    } else if (error instanceof Error && 'type' in error && 'status' in error && typeof error.status === 'number') {
      status = error.status;
    }
    const httpStatus = Object.hasOwn(problems, status) ? status : 500;
    const [defaultCode, title, detail] = problems[httpStatus as keyof typeof problems];
    const code = error instanceof ApiProblem ? error.code : defaultCode;
    if (error instanceof ApiProblem && error.retryAfter !== undefined) {
      response.setHeader('Retry-After', Math.ceil(error.retryAfter));
    }
    const tracking_id = randomUUID();
    if (httpStatus === 500) this.logger.error({ tracking_id, code });
    response.status(httpStatus).type('application/problem+json').json({
      type: `urn:vcraft:problem:${code}`, title, status: httpStatus, detail, code, tracking_id,
      ...(error instanceof InputValidationError && { errors: error.errors }),
    });
  }
}
