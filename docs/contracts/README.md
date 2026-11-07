# Hợp đồng làm việc song song

Bản chốt ngày 07/11/2026, dựa trên docsAI. Dùng bộ này để phân công adapter, viết use case với mock và dựng màn hình từ dữ liệu mẫu.

| Thành phần | Tài liệu bàn giao |
|---|---|
| Giao tiếp giữa module, đầu vào/đầu ra và lỗi | [Hợp đồng backend](backend.md) |
| Interface TypeScript và DI token | `backend/src/modules/{identity,workshops,catalog,traceability,media,trading}/public/contracts/` |
| Context transaction opaque và port | [transaction-runner.ts](../../backend/src/common/application/ports/transaction-runner.ts) |
| API theo màn hình, request và response | [Hợp đồng frontend](frontend.md) |
| Mẫu có thể import trực tiếp trong frontend | [fixtures.json](../../frontend/src/mocks/fixtures.json) |
| Bộ gọi mock bằng tên tình huống | [mock-api.ts](../../frontend/src/mocks/mock-api.ts) |

## Căn cứ và cách xử lý thay đổi

- Tập endpoint, method, header và hành động theo [api-design](../../docsAI/04-architecture/api-design.md). Trường và nullability của response theo [api-dtos](../../docsAI/04-architecture/api-dtos.md). Ví dụ ngắn ở endpoint được bổ sung đủ trường từ DTO.
- Phạm vi, thứ tự khóa và bất biến theo [kiến trúc](../../docsAI/04-architecture/architecture-overview.md), [thiết kế dữ liệu](../../docsAI/02-specifications/data-design.md), [nghiệp vụ](../../docsAI/02-specifications/business-rules.md) và [bảo mật](../../docsAI/02-specifications/security-and-access-control.md).
- Người A phụ trách Identity, Workshops, Community. Người B phụ trách Catalog, Traceability, Media. Người C phụ trách Trading và workflow liên module. Đây là nhãn phân công trong đặc tả, nhóm tự gắn tên thành viên.
- Mỗi thay đổi hợp đồng phải ghi rõ provider và consumer bị ảnh hưởng, mẫu request/response trước và sau, lỗi và kiểm thử cần sửa. Thay đổi phạm vi hoặc trường ngoài docsAI cần chốt đặc tả trước.
- Mẫu là dữ liệu giả và các ảnh chụp trạng thái độc lập để dựng UI. Interface public contract đã có trong source; từng provider triển khai adapter và handler nghiệp vụ theo interface. Việc có mẫu thành công không xác nhận endpoint đã chạy được.

## Điều kiện ghép phần việc

1. Provider trả đủ trường theo hợp đồng, lọc quyền trước phân trang và đếm. Consumer không truy cập model/repository nội bộ của provider.
2. Test contract kiểm tra thành công, thiếu quyền, tài nguyên bị ẩn, dữ liệu sai và xung đột phiên bản. Dùng mẫu vai trò tương ứng để đối chiếu giao diện.
3. Test tích hợp PostgreSQL kiểm tra rollback và cạnh tranh theo thứ tự khóa. Transaction bắt đầu ở workflow/use case cao nhất và dùng cùng context qua mọi module.
4. Frontend gọi API cùng origin qua Nginx, gửi cookie và CSRF, hiển thị Problem Details, giữ đúng key/payload khi phát lại một mutation trading.
