# Hợp đồng frontend

API cùng origin, prefix `/api/v1`. Mỗi dòng bên dưới có provider, vai trò, request và mẫu response đầy đủ trong `fixtures.json`. Mẫu GET danh sách có page/limit, pagination luôn tính sau lọc quyền. Các filter bổ sung, sort_by và order chỉ dùng allowlist theo [API mục 1.4 và từng endpoint](../../docsAI/04-architecture/api-design.md).

## Bắt đầu dựng giao diện

```ts
import { mockRequest } from '../../mocks/mock-api';

const response = await mockRequest('buyer-request');
const payload = await response.json();
```

Đường import tùy vị trí component. Chọn tên mẫu để chuyển tình huống thành công/rỗng/lỗi; `mockRequest` trả Web Response giống fetch, HTTP lỗi vẫn trả Response để UI kiểm tra `response.ok`. Lỗi tên mẫu là lỗi lập trình. Mỗi lần gọi trả bản sao mới.

Thời gian mẫu cố định ngày 10/11/2026 UTC. Mỗi tên mẫu là một snapshot độc lập với điều kiện tiền đề riêng, không chạy thành chuỗi thay đổi trạng thái. Cặp `quotes-direct-acceptance`/`accept-quote` dùng báo giá 403 đủ toàn bộ 5000 chiếc. `quotes`/`proposal`/`accept-proposal` minh họa chia 3000 + 2000. Bộ mock không gửi request, xác thực cookie, lọc query hay ghi dữ liệu.

Mẫu ảnh trả PNG 1 pixel để kiểm tra luồng Blob. URL ảnh trong JSON là URL API theo quyền ngữ cảnh; màn hình dùng mock ảnh phải gọi mẫu ảnh tương ứng và tạo object URL khi cần. Backend ảnh thật sẽ kiểm tra quyền ở mỗi lần đọc.

## Quy tắc frontend dùng chung

- API thật gửi `credentials: 'same-origin'`. Khởi động bằng GET auth/csrf, giữ token CSRF trong bộ nhớ và gửi X-CSRF-Token cho mutation. Cookie HttpOnly do trình duyệt quản lý. Login trả session_level để dẫn phiên tạm sang đổi mật khẩu; đổi mật khẩu thu hồi phiên và yêu cầu đăng nhập lại.
- JSON dùng Content-Type application/json. Upload dùng FormData để trình duyệt đặt boundary. Response ảnh dùng Blob; DELETE 204 không gọi json().
- ID là chuỗi; quantity/version là số nguyên; unit_price là số VND, total_amount/line_total là chuỗi. Timestamp UTC hiển thị theo Asia/Saigon. Null và trường bị lược theo quyền là hai trường hợp khác nhau.
- Mọi mutation trading trên đối tượng hiện có gửi X-Idempotency-Key UUID và expected_*_version theo mẫu. Retry cùng thao tác dùng đúng key + payload. 409 CONCURRENCY_CONFLICT cần tải lại trước khi tạo thao tác mới. POST tạo/sao chép nháp và auth/cấp/reset không tự retry.
- Replay dùng data để nhận kết quả lần commit và operation.current_state để cập nhật trạng thái hiện tại. DELETE 204 có body rỗng.
- Problem Details có type/title/status/detail/code/tracking_id; lỗi trường có errors với JSON Pointer. Hiển thị lỗi theo code, không suy luận từ câu detail. 429 tuân Retry-After.
- Artisan được mời nhận `invited-request`, chỉ sau chốt mới nhận `allocated-request` chứa liên hệ/địa chỉ. Tránh dùng BuyerRequestDto cho màn hình Artisan. QR khi hộ suspended dùng `trace-suspended`, profile_url null.
- Giá báo chỉ là tiền hàng. UI phương án phải ghi rõ vận chuyển thỏa thuận ngoài hệ thống. Cảnh báo NO_BATCH_LINK/INCOMPLETE_TRACEABILITY không chặn bàn giao.
- Quyền phản hồi đầy đủ theo [api-dtos](../../docsAI/04-architecture/api-dtos.md). Dữ liệu DTO không được lấy trực tiếp từ Prisma model.

Quy ước bàn giao cho hai trường News chưa được định kiểu riêng trong bảng DTO: Admin nhận created_by là ID chuỗi và updated_by là ID chuỗi hoặc null, theo quan hệ Account trong data-design. Các trường actor được api-dtos chỉ định rõ như performed_by/edited_by vẫn dùng object Actor.

## Các nhóm màn hình và mẫu trọng tâm

| Người dùng | Màn hình | Mẫu bắt đầu |
|---|---|---|
| Khách | Danh mục, sản phẩm, bản đồ xưởng, tin tức, QR | categories, products, workshop, news-list, trace, trace-suspended |
| Mọi vai trò | Đăng nhập, phiên tạm, đổi mật khẩu | csrf, login, login-temp, change-temp-password, session-expired |
| Buyer | Nháp, yêu cầu, báo giá, chọn phương án, nhận đủ | create-request, save-request, buyer-request, quotes, proposal, accept-proposal, confirm-delivery-buyer |
| Artisan | Hồ sơ, sản phẩm, lô, nhật ký, lời mời, phần việc | own-workshop, own-product, artisan-batch, artisan-journal, invited-request, submit-quote, allocation, handover |
| Admin | Cấp tài khoản, trạng thái hộ, phân loại, tin, hàng chờ chia | create-artisan, admin-workshops, suspend-workshop, admin-categories, admin-news, split-queue, create-proposal |
| Admin | Ngoại lệ bàn giao và nhận đủ | handover-admin, confirm-delivery-admin, invalid-state |
| Tình huống bổ sung | Rỗng, version cũ, replay, ảnh, upload | empty-requests, version-conflict, accept-proposal-replay, image-current, upload-image |

## Catalogue endpoint

Đầu ra đầy đủ, HTTP status, header, request body/form và dữ liệu lỗi nằm trong mỗi mẫu. Các payload ví dụ đầy đủ theo hợp đồng; tính bắt buộc/tùy chọn và nullable của request vẫn theo đặc tả endpoint được dẫn. Chỉ người phụ trách provider triển khai handler cho module đó.

| Method và path | Provider | Quyền mẫu | Request mẫu | Tên mẫu thành công |
|---|---|---|---|---|
| `POST /api/v1/auth/register-buyer` | identity | public | username, password, password_confirmation, display_name, phone | `register-buyer` |
| `POST /api/v1/auth/login` | identity | public | username, password | `login`, `login-temp` |
| `POST /api/v1/auth/change-temp-password` | identity | temp_password | current_temp_password, new_password, new_password_confirmation | `change-temp-password` |
| `POST /api/v1/auth/change-password` | identity | buyer | current_password, new_password, new_password_confirmation | `change-password` |
| `POST /api/v1/auth/logout` | identity | buyer | {} | `logout` |
| `POST /api/v1/admin/accounts/artisan` | identity | admin | username, workshop_name, address | `create-artisan` |
| `POST /api/v1/admin/accounts/:id/reset-password` | identity | admin | admin_current_password, reason, verification_evidence | `reset-password` |
| `GET /api/v1/workshops` | workshops | public | page, limit | `workshops` |
| `GET /api/v1/workshops/:id` | workshops | public | — | `workshop` |
| `PUT /api/v1/artisan/workshop` | workshops | artisan | name, story, address, latitude, longitude, avatar_image_id, image_ids, certificates | `save-workshop` |
| `PATCH /api/v1/artisan/workshop/visitors` | workshops | artisan | accepting_visitors | `visitors` |
| `PATCH /api/v1/admin/workshops/:id/status` | workshops | admin | status, reason | `suspend-workshop` |
| `GET /api/v1/categories` | catalog | public | page, limit | `categories` |
| `GET /api/v1/products` | catalog | public | page, limit | `products` |
| `POST /api/v1/artisan/products` | catalog | artisan | batch_id, category_id, name, price, description, image_ids | `create-product` |
| `PUT /api/v1/artisan/products/:id` | catalog | artisan | batch_id, category_id, name, price, description, image_ids | `save-product` |
| `PATCH /api/v1/artisan/products/:id/status` | catalog | artisan | status | `publish-product` |
| `DELETE /api/v1/artisan/products/:id` | catalog | artisan | — | `delete-product` |
| `POST /api/v1/artisan/batches` | traceability | artisan | name | `create-batch` |
| `POST /api/v1/artisan/batches/:id/journal` | traceability | artisan | stage, performed_at, notes, image_ids | `create-journal` |
| `PUT /api/v1/artisan/batches/:id/journal/:entryId` | traceability | artisan | stage, performed_at, notes, image_ids | `save-journal` |
| `POST /api/v1/artisan/batches/:id/publish` | traceability | artisan | {} | `publish-batch` |
| `GET /api/v1/trace/:qrToken` | traceability | public | — | `trace`, `trace-suspended` |
| `GET /api/v1/news` | community | public | page, limit | `news-list` |
| `GET /api/v1/news/:id` | community | public | — | `news-detail` |
| `POST /api/v1/admin/news` | community | admin | title, content, post_type | `create-news` |
| `PUT /api/v1/admin/news/:id` | community | admin | title, content, post_type | `save-news` |
| `PATCH /api/v1/admin/news/:id/status` | community | admin | status | `publish-news` |
| `DELETE /api/v1/admin/news/:id` | community | admin | — | `delete-news` |
| `POST /api/v1/media/upload` | media | artisan | file, context_type, target_workshop_id | `upload-image` |
| `POST /api/v1/admin/workshop-upload-scopes` | media | admin | {} | `create-upload-scope` |
| `POST /api/v1/buyer/quote-requests` | trading | buyer | {} | `create-request` |
| `PUT /api/v1/buyer/quote-requests/:id` | trading | buyer | expected_request_version, category_id, spec, quantity, unit, unit_set_description, delivery_mode, delivery_region, delivery_address, recipient_name, recipient_phone, bidding_deadline, delivery_deadline | `save-request` |
| `POST /api/v1/buyer/quote-requests/:id/send` | trading | buyer | expected_request_version | `send-request` |
| `GET /api/v1/quote-requests/:id` | trading | buyer, admin, artisan | — | `buyer-request`, `admin-request`, `invited-request`, `allocated-request` |
| `POST /api/v1/artisan/quote-requests/:id/decline` | trading | artisan | expected_recipient_version, decline_reason | `decline-request` |
| `POST /api/v1/artisan/quote-requests/:id/quote` | trading | artisan | expected_recipient_version, expected_quote_version, unit_price, max_quantity, bid_accept_deadline, committed_delivery_at | `submit-quote` |
| `POST /api/v1/artisan/quote-requests/:id/quote/withdraw` | trading | artisan | expected_recipient_version, expected_quote_version, withdraw_reason | `withdraw-quote` |
| `POST /api/v1/buyer/quote-requests/:id/close-bidding` | trading | buyer | expected_request_version | `close-bidding` |
| `POST /api/v1/buyer/quote-requests/:id/request-split` | trading | buyer | expected_request_version | `request-split` |
| `POST /api/v1/admin/quote-requests/:id/split-proposals` | trading | admin | expected_request_version, expected_proposal_id, expected_proposal_version, items | `create-proposal` |
| `POST /api/v1/buyer/quote-requests/:id/accept-quote` | trading | buyer | quote_id, expected_request_version, expected_quote_version | `accept-quote` |
| `POST /api/v1/buyer/quote-requests/:id/split-proposals/:proposalId/accept` | trading | buyer | expected_request_version, expected_proposal_version | `accept-proposal`, `accept-proposal-replay` |
| `POST /api/v1/artisan/allocations/:id/start` | trading | artisan | expected_allocation_version | `start-allocation` |
| `PUT /api/v1/artisan/allocations/:id/batches` | trading | artisan | expected_allocation_version, links | `link-batches` |
| `POST /api/v1/artisan/allocations/:id/handover` | trading | artisan | expected_allocation_version, delivery_note | `handover` |
| `POST /api/v1/admin/allocations/:id/handover-by-admin` | trading | admin | expected_allocation_version, reason, evidence, actual_handover_at | `handover-admin` |
| `POST /api/v1/buyer/quote-requests/:id/confirm-delivery` | trading | buyer | expected_request_version | `confirm-delivery-buyer` |
| `POST /api/v1/admin/quote-requests/:id/confirm-delivery-by-admin` | trading | admin | expected_request_version, reason, evidence | `confirm-delivery-admin` |
| `POST /api/v1/buyer/quote-requests/:id/cancel` | trading | buyer | expected_request_version, cancel_reason | `cancel-buyer` |
| `POST /api/v1/admin/quote-requests/:id/cancel-by-admin` | trading | admin | expected_request_version, cancel_reason, goods_handling_note | `cancel-admin` |
| `GET /api/v1/admin/accounts` | identity | admin | page, limit | `accounts` |
| `GET /api/v1/admin/workshops` | workshops | admin | page, limit | `admin-workshops` |
| `GET /api/v1/admin/workshops/:id` | workshops | admin | — | `admin-workshop` |
| `GET /api/v1/artisan/workshop` | workshops | artisan | — | `own-workshop` |
| `GET /api/v1/admin/workshops/:id/status-history` | workshops | admin | page, limit | `workshop-history` |
| `GET /api/v1/admin/categories` | catalog | admin | page, limit | `admin-categories` |
| `POST /api/v1/admin/categories` | catalog | admin | name | `create-category` |
| `PUT /api/v1/admin/categories/:id` | catalog | admin | name, is_active | `save-category` |
| `DELETE /api/v1/admin/categories/:id` | catalog | admin | — | `delete-category` |
| `GET /api/v1/products/:id` | catalog | public | — | `product` |
| `GET /api/v1/artisan/products` | catalog | artisan | page, limit | `own-products` |
| `GET /api/v1/artisan/products/:id` | catalog | artisan | — | `own-product` |
| `GET /api/v1/admin/news` | community | admin | page, limit | `admin-news-list` |
| `GET /api/v1/admin/news/:id` | community | admin | — | `admin-news` |
| `GET /api/v1/admin/batches` | traceability | admin | page, limit | `admin-batches` |
| `GET /api/v1/admin/batches/:id` | traceability | admin | — | `admin-batch` |
| `GET /api/v1/admin/batches/:id/journal` | traceability | admin | page, limit | `admin-journal` |
| `GET /api/v1/artisan/batches` | traceability | artisan | page, limit | `artisan-batches` |
| `GET /api/v1/artisan/batches/:id` | traceability | artisan | — | `artisan-batch` |
| `GET /api/v1/artisan/batches/:id/journal` | traceability | artisan | page, limit | `artisan-journal` |
| `PUT /api/v1/artisan/batches/:id` | traceability | artisan | name | `save-batch` |
| `DELETE /api/v1/artisan/batches/:id/journal/:entryId` | traceability | artisan | — | `delete-journal` |
| `GET /api/v1/batches/:id/journal/:entryId/history` | traceability | artisan | page, limit | `journal-histories` |
| `GET /api/v1/batches/:id/journal/:entryId/history/:historyId` | traceability | artisan | — | `journal-history` |
| `GET /api/v1/buyer/quote-requests` | trading | buyer | page, limit | `buyer-requests`, `empty-requests` |
| `GET /api/v1/artisan/quote-requests` | trading | artisan | page, limit | `invited-requests` |
| `GET /api/v1/admin/quote-requests` | trading | admin | page, limit | `admin-requests` |
| `DELETE /api/v1/buyer/quote-requests/:id` | trading | buyer | expected_request_version | `delete-request` |
| `POST /api/v1/buyer/quote-requests/:id/copy` | trading | buyer | {} | `copy-request` |
| `PATCH /api/v1/buyer/quote-requests/:id/contact` | trading | buyer | expected_request_version, recipient_name, recipient_phone | `change-contact` |
| `GET /api/v1/quote-requests/:id/recipients` | trading | buyer | page, limit | `recipients` |
| `GET /api/v1/quote-requests/:id/recipients/:recipientId/history` | trading | artisan | page, limit | `recipient-history` |
| `GET /api/v1/quote-requests/:id/quotes` | trading | buyer, artisan | page, limit | `quotes`, `own-quotes`, `quotes-direct-acceptance` |
| `GET /api/v1/quote-requests/:id/contact-history` | trading | buyer | page, limit | `contact-history` |
| `GET /api/v1/quote-requests/:id/history` | trading | buyer | page, limit | `request-history` |
| `GET /api/v1/quote-requests/:id/allocations` | trading | artisan | page, limit | `request-allocations` |
| `GET /api/v1/artisan/allocations` | trading | artisan | page, limit | `own-allocations` |
| `GET /api/v1/allocations/:id` | trading | artisan | — | `allocation` |
| `GET /api/v1/allocations/:id/history` | trading | buyer | page, limit | `allocation-history` |
| `GET /api/v1/allocations/:id/batches` | trading | buyer | page, limit | `allocation-batches` |
| `GET /api/v1/admin/split-queue` | trading | admin | page, limit | `split-queue` |
| `GET /api/v1/quote-requests/:id/split-proposals` | trading | buyer | page, limit | `proposals` |
| `GET /api/v1/quote-requests/:id/split-proposals/:proposalId` | trading | buyer | — | `proposal`, `proposal-expired` |
| `POST /api/v1/buyer/quote-requests/:id/split-proposals/:proposalId/reject` | trading | buyer | expected_request_version, expected_proposal_version, reason | `reject-proposal` |
| `GET /api/v1/auth/csrf` | identity | public | — | `csrf` |
| `GET /api/v1/auth/me` | identity | buyer, artisan, admin | — | `me-buyer`, `me-artisan`, `me-admin` |
| `GET /api/v1/media/pending/:imageId/:variant` | media | artisan | — | `image-pending` |
| `GET /api/v1/media/current/:contextType/:contextId/images/:imageId/:variant` | media | public | — | `image-current` |
| `GET /api/v1/media/history/:historyId/images/:imageId/:variant` | media | artisan | — | `image-history` |

## Các mẫu lỗi

| Tên mẫu | HTTP | Code | API minh họa |
|---|---|---|---|
| `invalid-input` | 400 | INVALID_INPUT | PUT /api/v1/buyer/quote-requests/10001 |
| `session-expired` | 401 | SESSION_EXPIRED | GET /api/v1/quote-requests/10001 |
| `permission-denied` | 403 | PERMISSION_DENIED | POST /api/v1/admin/accounts/artisan |
| `temp-password-restricted` | 403 | TEMP_PASSWORD_RESTRICTED | GET /api/v1/artisan/workshop |
| `csrf-invalid` | 403 | CSRF_INVALID | POST /api/v1/buyer/quote-requests/10001/send |
| `resource-not-found` | 404 | RESOURCE_NOT_FOUND | GET /api/v1/media/history/1101/images/801/thumbnail |
| `version-conflict` | 409 | CONCURRENCY_CONFLICT | POST /api/v1/buyer/quote-requests/10001/split-proposals/501/accept |
| `idempotency-conflict` | 409 | IDEMPOTENCY_CONFLICT | POST /api/v1/buyer/quote-requests/10001/split-proposals/501/accept |
| `username-taken` | 409 | USERNAME_TAKEN | POST /api/v1/auth/register-buyer |
| `name-taken` | 409 | NAME_TAKEN | POST /api/v1/admin/categories |
| `upload-scope-busy` | 409 | UPLOAD_SCOPE_BUSY | POST /api/v1/admin/accounts/artisan |
| `upload-scope-unavailable` | 422 | UPLOAD_SCOPE_UNAVAILABLE | POST /api/v1/admin/accounts/artisan |
| `quota-exceeded` | 409 | STORAGE_QUOTA_EXCEEDED | POST /api/v1/media/upload |
| `payload-too-large` | 413 | PAYLOAD_TOO_LARGE | POST /api/v1/media/upload |
| `unsupported-media-type` | 415 | UNSUPPORTED_MEDIA_TYPE | POST /api/v1/media/upload |
| `quote-expired` | 422 | QUOTE_EXPIRED | POST /api/v1/buyer/quote-requests/10001/accept-quote |
| `workshop-suspended` | 422 | WORKSHOP_SUSPENDED | POST /api/v1/artisan/quote-requests/10001/quote |
| `invalid-state` | 422 | INVALID_STATE | POST /api/v1/admin/allocations/12001/handover-by-admin |
| `no-eligible-workshop` | 422 | NO_ELIGIBLE_WORKSHOP | POST /api/v1/buyer/quote-requests/10001/send |
| `insufficient-capacity` | 422 | INSUFFICIENT_CAPACITY | POST /api/v1/admin/quote-requests/10001/split-proposals |
| `image-context-mismatch` | 422 | IMAGE_CONTEXT_MISMATCH | PUT /api/v1/artisan/products/701 |
| `rate-limit` | 429 | RATE_LIMIT_EXCEEDED | POST /api/v1/auth/login |
| `internal-error` | 500 | INTERNAL_SERVER_ERROR | GET /api/v1/quote-requests/10001 |
| `security-unavailable` | 503 | SECURITY_SERVICE_UNAVAILABLE | POST /api/v1/auth/login |
| `image-processing-unavailable` | 503 | IMAGE_PROCESSING_UNAVAILABLE | POST /api/v1/media/upload |

Mã lỗi chung và toàn bộ mã theo nghiệp vụ lấy từ [API mục 2](../../docsAI/04-architecture/api-design.md#2-mã-trạng-thái-http-và-danh-mục-mã-lỗi-nghiệp-vụ). Mọi API riêng tư có thể trả lỗi phiên/quyền; 404 che tài nguyên ngoài quan hệ. API ghi thêm INVALID_INPUT, CSRF_INVALID và lỗi điều kiện của từng hành động. HTTP 500/503 cần giữ tracking_id để tra cứu; backend không trả stack hay SQL.

