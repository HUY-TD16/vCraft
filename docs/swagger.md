# Swagger dùng chung

Khi backend chạy với `NODE_ENV=development`, mở `/api/docs` qua cùng origin của API; JSON OpenAPI ở `/api/docs/openapi.json`. Với Docker mặc định: `http://localhost/api/docs`. Production/test không mở các đường tài liệu này. UI chỉ đọc, tắt Try it out và không lưu thông tin xác thực.

Mã dùng chung nằm trong `backend/src/common/http/swagger/`. Bootstrap gọi `configureSwagger` sau `configureHttp`. Tài liệu chỉ liệt kê controller thực sự được đăng ký; hiện AppModule chưa có controller nghiệp vụ nên danh sách endpoint còn trống, không có nghĩa toàn bộ API đặc tả đã được triển khai.

## Quy ước cho module

```typescript
class CreateDto extends createZodDto(createSchema) {}

@ApiTags('Catalog')
@Roles('artisan')
@Controller('artisan/products')
export class ProductsController {
  @Post()
  @ApiOperation({ summary: 'Tạo sản phẩm nháp' })
  @ApiZodBody(CreateDto)
  @ApiDataResponse(productResponseSchema, { status: 201 })
  @ApiProblemResponses('INVALID_INPUT', 'AUTHENTICATION_REQUIRED',
    'SESSION_EXPIRED', 'PERMISSION_DENIED', 'TEMP_PASSWORD_RESTRICTED',
    'CSRF_INVALID', 'RATE_LIMIT_EXCEEDED', 'SECURITY_SERVICE_UNAVAILABLE',
    'INTERNAL_SERVER_ERROR')
  create(@Body() dto: CreateDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.service.create(actor, dto);
  }
}
```

Ví dụ minh họa cách gắn decorator, không tạo endpoint mới. Module cung cấp schema DTO/response đúng `docsAI/04-architecture/api-dtos.md`, không đưa entity Prisma hay actor nội bộ vào response schema.

- `ApiZodBody(Dto)` lấy schema đầu vào từ chính DTO validation, giữ ràng buộc trường dư. `ApiZodParameters(Dto, 'query' | 'path')` mô tả tham số. Với phân trang chuẩn dùng `ApiPaginationQuery()` để ghi đủ mặc định và giới hạn; bộ lọc riêng dùng DTO schema riêng, tránh khai báo page/limit hai lần. Zod refine/transform không thể biểu diễn đầy đủ bằng OpenAPI; thêm mô tả quy tắc nghiệp vụ trong `ApiOperation`, vẫn kiểm tra ở runtime.
- `ApiDataResponse(schema)` mô tả `{success:true,data}`; `paginated:true` mô tả data là mảng và tham chiếu Pagination. Mặc định status 200, tạo tài nguyên dùng 201. `example` là toàn bộ envelope. Mutation có operation truyền thêm schema `operation` đúng hợp đồng, gồm current_state đã lọc quyền.
- `ApiProblemResponses(...codes)` gom các mã cùng HTTP status, dùng `application/problem+json`, schema ProblemDetails và ví dụ lấy title/detail từ cùng bảng với filter. Chọn đủ lỗi áp dụng cho endpoint theo đặc tả; không tự tạo mã lỗi. Validation có JSON Pointer; 429 có Retry-After; mọi response có X-Request-ID.
- `ApiEmptyResponse()` mô tả 204 không body; controller vẫn phải đặt `@HttpCode(204)`. `ApiImageResponse()` mô tả byte JPEG/PNG/WebP, không bọc JSON; runtime trả StreamableFile. Thêm các lỗi phù hợp bằng ApiProblemResponses.
- `ApiIdempotencyKey()` chỉ dùng cho mutation được yêu cầu tại API mục 1.4, không gắn đại trà cho mọi POST.

## Xác thực và quyền

Cookie scheme `session` dùng `vcraft-session` ở development, `__Host-vcraft-session` ở môi trường khác. Đây là cookie HttpOnly server cấp, không phải Bearer token hoặc ô nhập secret thủ công. Tài liệu tự lấy quyền từ Public/Roles/SessionLevels, ưu tiên metadata method như guard. Route thiếu policy hiển thị `x-access-policy: denied`; Admin không mặc nhiên vượt role. Giữ operationId do bộ sinh cấp theo `Controller_method`, không đặt operationId riêng trong ApiOperation.

Các phương thức ghi tự có header X-CSRF-Token trong mô tả, kể cả login/register public. Đây là yêu cầu hợp đồng, không có nghĩa CSRF guard hay provider Identity thật đã triển khai. Public không có yêu cầu cookie trong OpenAPI. Quyền theo bản ghi, trạng thái hộ, phiên tạm và quan hệ sở hữu vẫn cần mô tả theo từng operation và kiểm tra trong module.

## Phiên bản và kiểm tra

Manifest hiện dùng Nest 10/Swagger 8, sinh OpenAPI **3.0.0**. Không đổi nhãn thành phiên bản mục tiêu 3.2.1 của tài liệu công nghệ. Nâng Nest/Swagger theo mục tiêu công nghệ là task riêng; lần này không đổi dependency/lockfile. Frontend phải dùng phiên bản và paths trong JSON thực tế.

Kiểm thử `tests/unit/swagger.spec.ts` sinh document bằng Nest thật nhưng không mở cổng: kiểm tra cookie theo môi trường, quyền public/private, CSRF, Zod input, pagination, lỗi, file/204 và bật/tắt UI theo môi trường.
