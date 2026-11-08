# Nền tảng HTTP và bảo mật backend

Đối chiếu `docsAI/04-architecture/api-design.md`, `api-dtos.md` và SEC-01–05, SEC-14–15. `bootstrap/configure-http.ts` đăng ký middleware, filter, pipes và interceptors; `SecurityModule` đăng ký guard toàn cục theo thứ tự xác thực rồi vai trò.

## DTO và response

DTO phải là class kế thừa `createZodDto(z.strictObject(...))`. Dùng `z.strictObject` cho cả object lồng nhau; chuỗi nội dung khai báo `.trim()`, mật khẩu không trim. JSON number/boolean không ép từ chuỗi. Query dùng `queryInteger`, `queryBoolean`; `paginationQuery` có page mặc định 1, limit mặc định 20 và tối đa 100. Mỗi endpoint khai báo schema đúng allowlist của đặc tả, kể cả query và params; schema phân trang chỉ là nền để thêm bộ lọc/sắp xếp của endpoint.

```typescript
class ListDto extends createZodDto(paginationQuery) {}

@Roles('artisan')
@Get()
list(@Query() query: ListDto, @CurrentActor() actor: AuthenticatedActor) {
  return this.service.list(actor, query);
}
```

Global pipe tự chạy với `@Body()`, `@Query()` và `@Param()` có DTO class. Không dùng interface, `object`, primitive hoặc chỉ pipe cục bộ thay DTO: thiếu schema là lỗi lập trình, trả 500 an toàn. `@CurrentActor()` là custom parameter, không qua validation đầu vào. Trường dư trả 400; đường dẫn lỗi theo JSON Pointer, không phản chiếu giá trị đã gửi.

Controller trả DTO thuần, interceptor thêm `{success:true,data}`. Danh sách trả `new HttpResult(items, {pagination})`; mutation có idempotency dùng `new HttpResult(dto, {operation})`. Không tự bọc success lần nữa. Module tính total_records/total_pages sau lọc quyền. `@HttpCode(204)` không có body. File trả `StreamableFile` với MIME ảnh đúng; không trả Buffer như JSON. Lỗi stream trước khi gửi header dùng Problem Details, lỗi sau khi đã gửi header đóng kết nối vì không thể thay response đã truyền.

## Xác thực và vai trò

- `@Public()` đánh dấu route không cần phiên; guard không đọc cookie/kho phiên trên route này. Endpoint CSRF công khai phải tự thực hiện bootstrap phiên/preauth theo hợp đồng Identity.
- `@Roles('buyer', 'artisan', 'admin')` khai báo các vai trò được phép. Khai báo trên method thay khai báo controller, kể cả chuyển một method của controller public thành private. Không khai báo quyền thì mặc định từ chối. Admin không tự vượt qua allowlist.
- `@CurrentActor()` trả actor chỉ do AuthenticationGuard tạo, có kiểu `AuthenticatedActor` và bất biến. Không lấy actor từ body/query hoặc `request.user`; không trả nguyên actor nội bộ ra response.
- Guard chỉ đọc `vcraft-session` khi NODE_ENV=development; môi trường khác đọc `__Host-vcraft-session`. Không dùng Authorization header, query token hay cookie preauth để xác thực nghiệp vụ.
- Thiếu cookie: 401 AUTHENTICATION_REQUIRED. Có cookie nhưng Identity trả null: 401 SESSION_EXPIRED. Identity báo SESSION_EXPIRED thì giữ nguyên. Sai vai trò: 403 PERMISSION_DENIED. Kho phiên không khả dụng: giữ lỗi SECURITY_SERVICE_UNAVAILABLE; lỗi bất ngờ đi qua filter 500 an toàn.
- Phiên temp_password mặc định bị từ chối bằng TEMP_PASSWORD_RESTRICTED, kể cả `/auth/me`. Chỉ route GET `/auth/csrf`, POST `/auth/logout`, POST `/auth/change-temp-password` mới có thể nhận phiên tạm và phải khai báo `@SessionLevels(...)`. Logout dùng `('normal','temp_password')`; đổi mật khẩu tạm dùng `('temp_password')`. Decorator này không mở quyền cho route nghiệp vụ.

Provider Identity chịu trách nhiệm xác thực hash token, hạn phiên, auth_version và trạng thái tài khoản trên mỗi lần resolveSession. Guard không tự đọc Prisma hoặc suy ra trạng thái phiên. Suspended workshop không đồng nghĩa mất phiên; kiểm tra sở hữu bản ghi/trạng thái nghiệp vụ thuộc module, trả 404 khi không được biết tài nguyên tồn tại.

Nối provider thật bằng `SecurityModule.register([IdentityModule.register(IdentityService, dependencies)])` tại AppModule, thay đăng ký rỗng hiện tại. Module được import phải export IDENTITY_CONTRACT. Đăng ký SecurityModule một lần; không thêm guard thủ công ở mỗi controller. Hiện chưa có IdentityService thật: route private không thể xác thực thành công, cookie có mặt nhận 503; không sử dụng mock làm provider production.

Các guard này chưa triển khai CSRF, rate limit, quản lý vòng đời phiên hay quyền từng bản ghi. Endpoint ghi cần các kiểm soát này trước khi đưa vào sử dụng; `@Public()` không miễn CSRF cho login/register.

## Request ID và log

Backend tạo UUID cho mỗi request, gắn `request.requestId`, `X-Request-ID` và `tracking_id` của lỗi cùng giá trị. Không nhận ID từ client khi chưa có quy tắc proxy tin cậy trong đặc tả. Đây là ID ở backend; lỗi do Nginx tự sinh vẫn theo cấu hình proxy hiện có.

AsyncLocalStorage giữ context giữa các lời gọi async. Middleware đo từ lúc nhận request đến finish/close; interceptor bổ sung tên controller và route template. Guard cũng bổ sung context để lỗi trước interceptor có vị trí. Mỗi request ghi đúng một sự kiện `http_request`, kể cả lỗi parser, 404 và kết nối đóng sớm. Filter gắn mã lỗi, không ghi trùng sự kiện request.

`appLogger.event(level, event, module, fields)` ghi JSON một dòng, mặc định từ info; AppLogger nhận mức debug/info/warn/error khi khởi tạo. Dùng tên event/module cố định từ mã nguồn. Fields chỉ cho method, route template, status, duration_ms, code, outcome; các trường khác bị bỏ, không stringify request hoặc exception. Không đưa thông tin người dùng vào trường được phép. Không log body, cookie, token, mật khẩu, URL/query thực, điện thoại, địa chỉ, SQL hoặc message/stack nội bộ. Lỗi kỹ thuật được tìm bằng request_id, controller, route và code.

Logger có hàng đợi tối đa 100 bản ghi, `getHealth()` trả tín hiệu lỗi sink/số bản ghi mất và `flush()` thử ghi lại. Tầng vận hành cần thu stdout, theo dõi sức khỏe logger, cấu hình cảnh báo và lưu trữ 90 ngày theo SEC-15; chưa có hệ thống thu log/cảnh báo bên ngoài trong repo. Log kỹ thuật không thay audit nghiệp vụ bắt buộc trong transaction.
