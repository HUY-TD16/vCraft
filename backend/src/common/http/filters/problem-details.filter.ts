import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { InputValidationError } from '../pipes/zod-validation.pipe';
import { ApiProblem, statusByCode } from './api-problem';
import { BusinessRuleException } from '../../domain/errors/business-rule.exception';
import { ServiceUnavailableException } from '../../application/errors/service-unavailable.exception';
import { appLogger, type AppLogger } from '../../observability/app-logger';
import { requestContext } from '../../observability/request-context';

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
  constructor(private readonly logger: AppLogger = appLogger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    let status = 500;
    const contractError = error instanceof BusinessRuleException || error instanceof ServiceUnavailableException;
    if (contractError) {
      status = statusByCode[error.code];
    } else if (error instanceof HttpException) {
      status = error.getStatus();
    } else if (error instanceof Error && 'type' in error) {
      if (error.type === 'entity.too.large') status = 413;
      if (error.type === 'entity.parse.failed' || error.type === 'request.aborted'
        || error.type === 'request.size.invalid') status = 400;
      if (error.type === 'encoding.unsupported' || error.type === 'charset.unsupported') status = 415;
    }
    const httpStatus = Object.hasOwn(problems, status) ? status : 500;
    const [defaultCode, title, detail] = problems[httpStatus as keyof typeof problems];
    const code = error instanceof ApiProblem || contractError ? error.code : defaultCode;
    const context = requestContext.getStore();
    const tracking_id = context?.requestId ?? randomUUID();
    if (context) context.errorCode = code;
    else requestContext.run({ requestId: tracking_id, module: 'ProblemDetailsFilter' }, () =>
      this.logger.event(httpStatus >= 500 ? 'error' : 'warn', 'http_error', 'ProblemDetailsFilter', { code, status: httpStatus }));
    if (response.headersSent) { response.destroy(); return; }
    response.removeHeader('Content-Length');
    response.removeHeader('Content-Disposition');
    response.setHeader('X-Request-ID', tracking_id);
    if (error instanceof ApiProblem && error.retryAfter !== undefined) {
      response.setHeader('Retry-After', Math.ceil(error.retryAfter));
    }
    response.status(httpStatus).type('application/problem+json').json({
      type: `urn:vcraft:problem:${code}`, title, status: httpStatus, detail, code, tracking_id,
      ...(error instanceof InputValidationError && { errors: error.errors }),
    });
  }
}
