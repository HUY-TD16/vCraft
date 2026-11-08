# Kiểu và hợp đồng dùng chung

Căn cứ: kiến trúc mục 4–5 và API mục 1.3–1.4, `api-dtos.md` mục 1. `common/application` và `common/domain` là TypeScript thuần, không import NestJS, Zod, Prisma hoặc module nghiệp vụ. HTTP/Swagger/adapter phụ thuộc vào kiểu chung, không đảo chiều.

## Các định nghĩa đã chốt

| Thành phần | Trách nhiệm | Nơi dùng thực tế |
| --- | --- | --- |
| `Id`, `Instant` trong contract-types | Biểu diễn ID chuỗi và thời gian UTC trên contract, không phải validator runtime | Public contract của sáu module |
| `Role`, `TrustedActor` | Ngữ cảnh người thực hiện đã xác thực, readonly; không phải DTO người dùng công khai | Identity, Workshops, Catalog, Traceability, Media, Trading và guards |
| `SessionLevel`, `AuthenticatedActor` | Phiên normal/temp_password trên actor; không gồm phiên preauth | Identity.resolveSession, guards, CurrentActor, metadata quyền/Swagger |
| `PaginationParams`, `Pagination`, `PageResult<T>` | Tham số page/limit đã chuyển kiểu; kết quả gồm data và metadata phân trang, chưa bọc success | Global validation, HttpResult/interceptor |
| `PAGINATION` | Mặc định page=1, limit=20, tối đa limit=100 | Validation và Swagger dùng cùng nguồn |
| `OperationMetadata<TState>` | id/replayed/committed_at/current_state cho kết quả idempotency | AcceptanceOperationDto của Trading và HttpResult |
| `TransactionContext`, `TransactionRunner`, `TRANSACTION_RUNNER` | Context opaque và chạy callback trong transaction, không lộ Prisma | Sáu public contract, PrismaTransactionRunner, DatabaseModule và mock runner |

Import mới lấy các kiểu actor từ `common/application/types/contract-types`, phân trang từ `pagination`, operation từ `operation-metadata`. Đường import AuthenticatedActor/SessionLevel/Pagination cũ ở tầng security/HTTP được giữ bằng re-export để không phá consumer hiện có; không định nghĩa bản sao.

Actor có sessionId/authVersion là dữ liệu nội bộ, không serialize nguyên actor ra response. Actor trong DTO hiển thị `{id,display_name}` là khái niệm khác. Guard xác thực nguồn actor; readonly chỉ bảo vệ ở TypeScript. `Id`/`Instant` vẫn là alias chuỗi, không bảo đảm giá trị hợp lệ nếu bỏ qua validation theo từng DTO.

## Phân trang

Service có thể trả `createPageResult(rows, totalRecords, params)` dưới kiểu `PageResult<T>`. Controller chuyển kết quả thành `new HttpResult(result.data, {pagination: result.pagination})`, hoặc dùng `HttpResult.paginated(rows, totalRecords, params)`. Response vẫn đúng `{success:true,data,pagination}`. Helper tính total_pages, danh sách rỗng có total_pages=0; không ép page về trang cuối.

`totalRecords` phải là tổng sau lọc quyền; helper không query hoặc lọc quyền thay module. Dữ liệu không bị tự cắt. Giá trị nội bộ sai (không nguyên an toàn, giới hạn không hợp lệ, số hàng vượt limit/total) ném RangeError để phát hiện lỗi lập trình; đầu vào HTTP sai được Zod chặn trước và trả INVALID_INPUT. Sort/filter/search thuộc allowlist mỗi endpoint, không đưa vào một kiểu query chung cho mọi module.

## Kết luận rà soát ports và value objects

Giữ TransactionRunner là port chung hiện có; không thêm Clock khi chưa có use case cần truyền thời gian qua port. Contract Identity, Workshop, Catalog, Traceability, Media và Trading tiếp tục thuộc `modules/<owner>/public`, không chuyển vào common: chúng chứa quy tắc và kiểu riêng của provider. Quyền ảnh có cùng kết quả canRead nhưng điều kiện kiểm tra khác nhau, không gom thành một port bỏ mất ngữ cảnh.

Chưa bổ sung `domain/value-objects`: hiện phần lớn module mới có public contract, chưa có domain implementation dùng cùng một value object. Money/Quantity/Version/EntityId chỉ thêm khi có consumer runtime và bất biến chung rõ ràng. Tiền đơn giá là integer, tổng tiền là chuỗi decimal, không gộp cả hai thành number; trạng thái hộ, lô, ảnh và giao dịch giữ tại module sở hữu. Không tạo thư mục hoặc class rỗng chỉ để đủ cấu trúc.

Các phần này không đổi schema, trạng thái, endpoint hay mã lỗi của đặc tả. Khi thêm module thật, dùng các kiểu trên; chỉ nâng khái niệm vào common nếu cùng ý nghĩa, cùng quy tắc và có nơi sử dụng cụ thể.
