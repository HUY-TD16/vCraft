# Thiết kế API và Hợp đồng DTO — vCraft

Căn cứ: [phạm vi dự án](../01-project-brief/project-scope.md), [quy tắc nghiệp vụ](../02-specifications/business-rules.md), [use cases](../02-specifications/use-cases.md), [bảo mật & phân quyền](../02-specifications/security-and-access-control.md), [thiết kế dữ liệu](../02-specifications/data-design.md) và [kiến trúc tổng thể](architecture-overview.md).

Tài liệu này là **đặc tả hợp đồng API chính thức (API Contract Specification)** cho nền tảng vCraft (Làng gốm Bát Tràng), xác định toàn bộ endpoint RESTful, phương thức HTTP, DTO yêu cầu/phản hồi, quy tắc xác thực (validation), xử lý lỗi, phân trang và ma trận kiểm soát quyền truy cập theo từng bản ghi.

---

## 1. Quy ước thiết kế API toàn hệ thống

### 1.1. Giao thức, Định dạng và Phiên bản

- **Base URL:** `/api/v1`
- **Định dạng dữ liệu:** API dữ liệu dùng `application/json`; upload dùng `multipart/form-data` có boundary. API đọc ảnh trả byte ảnh đã xử lý với MIME image/jpeg, image/png hoặc image/webp và `X-Content-Type-Options: nosniff`; lỗi ảnh trả application/problem+json theo mục 2. Response 204 không có body. Không bọc byte ảnh trong JSON.
- **Mã hóa ký tự:** `UTF-8`.
- **Định dạng thời gian:** Chuỗi ISO 8601 theo giờ chuẩn UTC (`YYYY-MM-DDTHH:mm:ss.sssZ`). Tầng Frontend hiển thị theo múi giờ Việt Nam (`UTC+07:00`).
- **Đơn vị tiền tệ:** `VND` (số nguyên dương, không có phần thập phân).

### 1.2. Xác thực phiên, CSRF và Chống gửi lặp (Idempotency)

- **Xác thực phiên (SEC-05):** Thông qua cookie `__Host-vcraft-session; Secure; HttpOnly; SameSite=Lax; Path=/`. Không gửi token qua URL, query params hay Authorization header ở client.
- **Bảo vệ chống CSRF (SEC-09):** Các phương thức thay đổi dữ liệu (`POST`, `PUT`, `PATCH`, `DELETE`) bắt buộc đính kèm header:
  ```http
  X-CSRF-Token: <token_lay_tu_response_auth_csrf>
  ```
- **Chống gửi lặp (BR-27, SEC-06):** Các thao tác chốt giao dịch trọng yếu (`accept-quote`, `split-proposals/accept`, `handover`, `confirm-delivery`, `cancel`) bắt buộc header idempotency; danh sách đầy đủ và thứ tự kiểm tra ở mục 1.4:
  ```http
  X-Idempotency-Key: <uuid_v4_do_client_tao>
  ```
  Nếu gửi lại cùng key và payload: Trả kết quả cũ kèm trạng thái hiện tại. Nếu cùng key nhưng khác payload: Trả lỗi `409 Conflict`.

### 1.3. Cấu trúc phản hồi chuẩn (Response Envelopes)

#### Phản hồi thành công đơn lẻ (Single Resource)

```json
{
  "success": true,
  "data": { "id": "1001" }
}
```

#### Phản hồi danh sách có phân trang (Paginated List)

Áp dụng cho mọi API đọc danh sách có số lượng bản ghi biến động (SEC-14: tối đa 100 bản ghi/trang):
```json
{
  "success": true,
  "data": [{ "id": "1001" }],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total_records": 154,
    "total_pages": 8
  }
}
```
*Query Params chuẩn:* `?page=1&limit=20&sort_by=created_at&order=desc`

#### Phản hồi lỗi chuẩn của vCraft

Lỗi dùng `application/problem+json` theo Problem Details (RFC 9457, thay thế RFC 7807), không bọc trong `success/error`. `status` trùng HTTP status; `code` ổn định để frontend xử lý, `detail` dành cho người dùng. `type` là URI định danh lỗi, không phải endpoint cần gọi. Tham chiếu: [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html).

```json
{
  "type": "urn:vcraft:problem:INVALID_INPUT",
  "title": "Dữ liệu không hợp lệ",
  "status": 400,
  "detail": "Kiểm tra lại các trường được đánh dấu.",
  "code": "INVALID_INPUT",
  "tracking_id": "c7a8b9e0-1234-4567-89ab-cdef01234567",
  "errors": [
      {
        "field": "/quantity",
        "message": "Số lượng yêu cầu phải là số nguyên dương lớn hơn 0."
      }
  ]
}
```

---

### 1.4. Kiểu dữ liệu, phiên bản và giao dịch

- ID bigint qua JSON là chuỗi số dương; version integer > 0. Tiền VND nguyên dương trong giới hạn numeric(15,0); tổng tiền server tính và trả chuỗi số nguyên để không mất chính xác. Số lượng integer 1–2147483647; kiểm tra tích/tổng không tràn kiểu DB. Timestamp UTC hậu tố Z. Trường server quản lý bị gửi lên trả 400, không âm thầm bỏ qua.
- PUT thay toàn bộ biểu mẫu được chỉ định; PATCH chỉ đổi trường cho phép. Không sửa role, buyer_id, workshop_id sở hữu, status chính, giá chốt, actor hoặc thời điểm hệ thống qua DTO nội dung. Bảng endpoint liệt kê allowlist trường đầu vào; không nhận trường khác.
- Trim chuỗi trừ mật khẩu; trường bắt buộc không rỗng. Giới hạn: username 32; tên người/hộ 200 (display_name 100); tên sản phẩm/tiêu đề tin 300; địa chỉ xưởng/khu vực 500/200; địa chỉ giao chi tiết 10.000; điện thoại 20; mô tả/lý do/căn cứ 10.000; nội dung tin 50.000; tên phân loại 100; tên lô/công đoạn 200 ký tự. Mảng ghi tối đa 100 phần tử/request trừ ảnh theo mục 8. Đây là giới hạn request MVP, không tự cắt dữ liệu.
- Phân trang page ≥1, limit 1–100 mặc định 20; sort_by trong allowlist (created_at mặc định, name cho danh mục/xưởng/sản phẩm, performed_at cho nhật ký, split_requested_at cho hàng chờ), order asc/desc, thêm id để ổn định thứ tự. search ≤100 ký tự. Lọc quyền trước phân trang/đếm.
- Các ví dụ mục 9 và bảng mục 10 là một hợp đồng: payload ghi trading bắt buộc expected_*_version theo bảng dưới. Response trả version mới. Không dùng updated_at thay version trading; đối tượng không có version trong data-design dùng khóa giao dịch kiểm tra bất biến, không tự trả version giả.

| Thao tác | Phiên bản bắt buộc trong body |
|---|---|
| Sửa/xóa nháp, gửi, đóng nhận, nhờ chia, sửa liên hệ, hủy, nhận đủ | expected_request_version |
| Từ chối yêu cầu | expected_recipient_version |
| Gửi/sửa/gửi lại/rút báo giá | expected_recipient_version; expected_quote_version (null chỉ lần đầu) |
| Chấp nhận báo giá | expected_request_version, expected_quote_version |
| Lập phương án | expected_request_version, expected_proposal_id và expected_proposal_version (cả hai null khi không có proposed), expected_quote_version trên mỗi item |
| Chấp nhận/từ chối phương án | expected_request_version, expected_proposal_version |
| Bắt đầu, liên kết lô, bàn giao thường/Admin thay | expected_allocation_version; không yêu cầu version yêu cầu chung |

X-Idempotency-Key UUID bắt buộc cho mọi POST/PUT/PATCH/DELETE trading thay đổi bản ghi hiện có, gồm gửi, phản hồi, báo giá, lập/từ chối phương án, tiến độ, liên hệ và Admin thay. Thiếu/sai định dạng trả 400 INVALID_INPUT. POST tạo nháp/sao chép tạo tài nguyên mới không dùng kho key theo đối tượng trong MVP; không tự retry sau timeout, đọc danh sách đối chiếu trước khi tạo lại. Auth/cấp tài khoản/reset không lưu hoặc phát lại response chứa bí mật trong IdempotencyRecord.

Thứ tự: xác thực/CSRF → kiểm tra quyền → tìm key theo (account_id, action, object_type, object_id, key) → so fingerprint payload chuẩn hóa gồm version kỳ vọng → đã thành công thì trả kết quả cũ đã lọc quyền và trạng thái hiện tại, không bắt version cũ còn hiện hành → thao tác mới kiểm tra version/trạng thái/hạn trong transaction. Cùng key khác payload trả 409 IDEMPOTENCY_CONFLICT. Version cũ trả 409 CONCURRENCY_CONFLICT; không expire phương án chỉ vì version client cũ. TTL key 24 giờ; sau TTL trạng thái/unique vẫn ngăn thực hiện lại bước đã hoàn tất.

Mutation trading trả 200 (tạo Quote/Proposal mới trả 201), data là DTO trong bảng; thêm `operation: { id, replayed, committed_at, current_state }`. current_state chỉ chứa ID/status/version/cancelled_at được phép xem. Replay trả data đã lưu đã lọc quyền, current_state hiện tại. Xóa nháp trả 204 không body, replay thành công vẫn 204; bản ghi idempotency giữ tài khoản sở hữu/định danh đối tượng để kiểm tra quyền sau xóa.

Chốt đơn kiểm tra lại hộ, quan hệ yêu cầu, báo giá, số lượng, hạn và version theo thứ tự khóa data-design. Tạo đủ Allocation, chuyển trạng thái, log và kết quả idempotency cùng transaction; lỗi rollback toàn bộ. Bàn giao/hủy/nhận đủ kiểm tra trạng thái yêu cầu nguyên tử. Sau hủy/Delivered chỉ đọc hoặc sao chép nháp mới; replay hợp lệ không tạo thay đổi mới.

### 1.5. Bootstrap CSRF, phiên và giới hạn truy cập

- GET /api/v1/auth/csrf: không body. Có phiên hợp lệ trả 200 `{ csrf_token, session_level }` của phiên; chưa có thì tạo/tái sử dụng preauth với cookie `__Host-vcraft-preauth; Secure; HttpOnly; SameSite=Lax; Path=/`, không Domain, TTL tuyệt đối 15 phút. session_level = preauth không cấp quyền nghiệp vụ. Chịu rate-limit public, kho có giới hạn/dọn TTL.
- Token CSRF chỉ qua body/header và bộ nhớ frontend; không đặt vào cookie JS đọc được, URL hoặc localStorage. Mọi request ghi kể cả login/register/upload/logout cần token đúng phiên và Origin/Referer hợp lệ. Sai/thiếu trả 403 CSRF_INVALID. Auth dùng Cache-Control no-store. Cùng origin, không CORS wildcard.
- Login thành công hủy preauth/cookie/token cũ, tạo mã phiên ngẫu nhiên ≥256 bit và token CSRF mới. Cookie giữ mã phiên, DB chỉ lưu hash. Khóa Account, kiểm tra lại auth_version/trạng thái khóa/hạn mật khẩu tạm trước tạo phiên; request riêng tư kiểm tra phiên bản khớp. Normal hết hạn sau 30 phút không hoạt động hoặc 12 giờ tuyệt đối; temp_password tối đa 15 phút.
- GET /api/v1/auth/me: phiên normal trả 200 `{ id, username, display_name, role, workshop_id, session_level }`; workshop_id null cho Buyer/Admin. Không trả hash/auth_version/token. Temp_password chỉ bootstrap CSRF, đổi mật khẩu tạm/logout; không gọi me/API nghiệp vụ. Frontend dùng response login để dẫn tới đổi mật khẩu.
- Register thành công hướng dẫn login, không tự cấp phiên normal. Login sai trả 401 INVALID_CREDENTIALS chung, không phân biệt tên không tồn tại/khóa/mật khẩu sai. BR-01 áp dụng cả xác nhận mật khẩu đổi/reset: 5 lần sai/15 phút/cặp IP-username, 30 lần sai/15 phút/IP; chặn 15 phút không gia hạn vì request bị chặn. Không khóa toàn tài khoản chỉ do bị thử tên từ xa. IP chỉ từ kết nối/proxy tin cậy.
- Đọc nghiệp vụ 120/phút/tài khoản, ghi 60/phút/tài khoản (upload riêng), public 300/phút/IP, ảnh public 600/phút/IP. 429 có Retry-After. Kho phiên/rate-limit lỗi trả 503 SECURITY_SERVICE_UNAVAILABLE, không bỏ kiểm soát. JSON ≤1 MiB, timeout thường 15 giây. Không log mật khẩu/token/body reset.

---

## 2. Mã trạng thái HTTP và Danh mục mã lỗi nghiệp vụ

| HTTP Status | Trường hợp sử dụng | Error Code |
| :---: | :--- | :--- |
| **`200 OK`** | Thao tác đọc/sửa thành công và có trả về dữ liệu. | — |
| **`201 Created`** | Tạo mới bản ghi thành công (kèm dữ liệu bản ghi vừa tạo). | — |
| **`204 No Content`** | Thao tác thành công và không cần trả về nội dung (ví dụ: xóa nháp). | — |
| **`400 Bad Request`** | Dữ liệu đầu vào sai cú pháp, vượt ngưỡng hoặc vi phạm schema. | `INVALID_INPUT`, `INVALID_IMAGE_FORMAT` |
| **`401 Unauthorized`** | Chưa đăng nhập, xác thực sai, phiên hết hạn hoặc đã thu hồi. | `AUTHENTICATION_REQUIRED`, `SESSION_EXPIRED`, `INVALID_CREDENTIALS` |
| **`403 Forbidden`** | Đã đăng nhập nhưng không có quyền thao tác trên tài nguyên. | `PERMISSION_DENIED`, `TEMP_PASSWORD_RESTRICTED`, `CSRF_INVALID` |
| **`404 Not Found`** | Bản ghi không tồn tại hoặc người dùng không được quyền biết nó tồn tại (SEC-06). | `RESOURCE_NOT_FOUND` |
| **`409 Conflict`** | Xung đột phiên bản dữ liệu (Optimistic Lock) hoặc trùng Idempotency key. | `CONCURRENCY_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `USERNAME_TAKEN`, `NAME_TAKEN`, `STORAGE_QUOTA_EXCEEDED`, `UPLOAD_SCOPE_LIMIT_EXCEEDED`, `UPLOAD_SCOPE_BUSY` |
| **`413 Payload Too Large`**| Kích thước body vượt quá giới hạn (Upload > 6 MiB, JSON > 1 MiB theo SEC-14). | `PAYLOAD_TOO_LARGE` |
| **`415 Unsupported Media Type`** | JSON API nhận sai Content-Type hoặc upload không phải multipart hợp lệ. | `UNSUPPORTED_MEDIA_TYPE` |
| **`422 Unprocessable`** | Cú pháp đúng nhưng vi phạm quy tắc nghiệp vụ/bất biến trạng thái. | `QUOTE_EXPIRED`, `WORKSHOP_SUSPENDED`, `DEADLINE_VIOLATION`, `INVALID_STATE`, `BIDDING_CLOSED`, `NO_ELIGIBLE_WORKSHOP`, `INSUFFICIENT_CAPACITY`, `RESOURCE_IN_USE`, `IMAGE_CONTEXT_MISMATCH`, `UPLOAD_SCOPE_UNAVAILABLE` |
| **`429 Too Many Requests`**| Vượt quá giới hạn tần suất yêu cầu (Rate Limit). Trả header `Retry-After`. | `RATE_LIMIT_EXCEEDED` |
| **`503 Service Unavailable`** | Kho bảo mật/kho ảnh/worker không đáp ứng. | `SECURITY_SERVICE_UNAVAILABLE`, `STORAGE_CAPACITY_LOW`, `IMAGE_PROCESSING_UNAVAILABLE` |
| **`500 Internal Error`** | Lỗi nội bộ hệ thống hoặc cơ sở dữ liệu. Giấu thông tin nhạy cảm. | `INTERNAL_SERVER_ERROR` |

---

## 3. Module 1: Xác thực & Tài khoản (`identity`)

### 3.1. Đăng ký tài khoản Buyer (UC-01, BR-01)

- **Endpoint:** `POST /api/v1/auth/register-buyer`
- **Quyền truy cập:** Khách chưa đăng nhập, có preauth/CSRF theo mục 1.5
- **Giới hạn tần suất:** 5 requests/phút/IP (SEC-14)
- **Request DTO (`RegisterBuyerRequestDto`):**
  ```json
  {
    "username": "buyer_an_nam",
    "password": "Password123@#$",
    "password_confirmation": "Password123@#$",
    "display_name": "Công ty Gốm Sứ An Nam",
    "phone": "0912345678"
  }
  ```
   *Ràng buộc Validation:*
  - `username`: 4–32 ký tự, regex `^[a-zA-Z0-9._]+$`. Server tự động lowercase và trim khoảng trắng.
  - `password`: 12–128 ký tự. Khớp `password_confirmation`.
  - `display_name`: 2–100 ký tự.
  - `phone`: Chuỗi liên hệ tối đa 20 ký tự; chấp nhận dạng trong nước 10 chữ số hoặc +84 tương đương, chuẩn hóa nhất quán; không coi là đã xác minh OTP.
- **Phản hồi (`201 Created`):**
  ```json
  {
    "success": true,
    "data": {
      "id": "1001",
      "username": "buyer_an_nam",
      "display_name": "Công ty Gốm Sứ An Nam",
      "role": "buyer",
      "created_at": "2026-11-04T10:00:00.000Z"
    }
  }
  ```

---

### 3.2. Đăng nhập hệ thống (UC-02, BR-01, SEC-05)

- **Endpoint:** `POST /api/v1/auth/login`
- **Quyền truy cập:** Khách chưa đăng nhập, có preauth/CSRF theo mục 1.5
- **Giới hạn tần suất:** 5 lần sai/15 phút/cặp IP-username; 30 lần sai/15 phút/IP.
- **Request DTO (`LoginRequestDto`):**
  ```json
  {
    "username": "artisan_minh_long",
    "password": "TempPassword16Chars#"
  }
  ```
- **Phản hồi (`200 OK`):**
  - Set-Cookie: `__Host-vcraft-session=<random_session_token>; Secure; HttpOnly; SameSite=Lax; Path=/`
  ```json
  {
    "success": true,
    "data": {
      "user": {
        "id": "2001",
        "username": "artisan_minh_long",
        "role": "artisan",
        "workshop_id": "301",
        "session_level": "temp_password"
      },
      "csrf_token": "a1b2c3d4e5f6..."
    }
  }
  ```
  *Lưu ý:* Nếu `session_level = "temp_password"`, mọi API nghiệp vụ khác đều bị từ chối với lỗi `403 TEMP_PASSWORD_RESTRICTED` cho đến khi hoàn tất đổi mật khẩu.

---

### 3.3. Đổi mật khẩu lần đầu từ phiên tạm (UC-02, BR-01, SEC-05)

- **Endpoint:** `POST /api/v1/auth/change-temp-password`
- **Quyền truy cập:** Người dùng có phiên `temp_password` (hết hạn trong 15 phút)
- **Request DTO (`ChangeTempPasswordRequestDto`):**
  ```json
  {
    "current_temp_password": "TempPassword16Chars#",
    "new_password": "NewSecurePassword123!",
    "new_password_confirmation": "NewSecurePassword123!"
  }
  ```
  *Validation:* `new_password` phải khác `current_temp_password`, độ dài 12–128 ký tự.
- **Phản hồi (`200 OK`):** Tăng auth_version, thu hồi toàn bộ phiên, xóa cookie và token CSRF cũ; trả `{ "reauthentication_required": true }`. Mật khẩu tạm phải chưa hết hạn tại lúc đổi; yêu cầu đăng nhập lại bằng mật khẩu mới.

---

### 3.4. Đổi mật khẩu chủ động (UC-02, SEC-05)

- **Endpoint:** `POST /api/v1/auth/change-password`
- **Quyền truy cập:** Phiên normal của `buyer`, `artisan`, `admin`
- **Request DTO (`ChangePasswordRequestDto`):**
  ```json
  {
    "current_password": "CurrentPassword123!",
    "new_password": "NewPassword456!@#",
    "new_password_confirmation": "NewPassword456!@#"
  }
  ```
- **Phản hồi (`200 OK`):** Tăng `auth_version`, thu hồi toàn bộ phiên trên mọi thiết bị, xóa cookie/token CSRF; trả `{ "reauthentication_required": true }`. Mật khẩu mới 12–128 ký tự, khác mật khẩu cũ và trùng xác nhận; không trim/chuẩn hóa mật khẩu.

---

### 3.5. Đăng xuất (UC-02, SEC-05)

- **Endpoint:** `POST /api/v1/auth/logout`
- **Quyền truy cập:** Đã đăng nhập
- **Phản hồi (`200 OK`):** Thu hồi phiên hiện tại, xóa cookie `__Host-vcraft-session`; trả `{ "logged_out": true }`. Cho phép phiên normal hoặc temp_password, vẫn cần CSRF.

---

### 3.6. Admin cấp tài khoản Artisan ban đầu (UC-03, BR-01, BR-02)

- **Endpoint:** `POST /api/v1/admin/accounts/artisan`
- **Quyền truy cập:** `admin`
- **Request DTO (`CreateArtisanAccountRequestDto`):**
  ```json
  {
    "username": "artisan_quang_vinh",
    "workshop_name": "Xưởng Gốm Quang Vinh Bát Tràng",
    "address": "Số 12, Thôn 1 Làng Cổ Bát Tràng, Gia Lâm, Hà Nội"
  }
  ```
- **Phản hồi (`201 Created`):**
  ```json
  {
    "success": true,
    "data": {
      "account_id": "2005",
      "username": "artisan_quang_vinh",
      "workshop_id": "305",
      "workshop_name": "Xưởng Gốm Quang Vinh Bát Tràng",
      "temporary_password": "Random16CharsString!@",
      "expires_at": "2026-11-05T10:00:00.000Z",
      "note": "Mật khẩu tạm chỉ hiển thị MỘT LẦN DUY NHẤT. Hãy bàn giao an toàn ngoài hệ thống."
    }
  }
  ```

---

### 3.7. Admin đặt lại mật khẩu cho Buyer / Artisan (UC-02, SEC-05)

- **Endpoint:** `POST /api/v1/admin/accounts/:id/reset-password`
- **Quyền truy cập:** `admin` (Không được đặt lại tài khoản admin qua API này)
- **Request DTO (`AdminResetPasswordRequestDto`):**
  ```json
  {
    "admin_current_password": "AdminSecretPassword123!",
    "reason": "Chủ hộ mất quyền truy cập thiết bị cũ",
    "verification_evidence": "Biên bản xác minh giấy tờ hộ kinh doanh trực tiếp tại văn phòng Hội ngày 04/11/2026"
  }
  ```
- **Phản hồi (`200 OK`):** Trả về mật khẩu tạm 1 lần duy nhất, tăng `auth_version` của tài khoản đích để thu hồi phiên cũ, ghi `SecurityAuditLog`.

---

## 4. Module 2: Hồ sơ xưởng & Bản đồ (`workshops`)

### 4.1. Danh sách xưởng công khai & Tìm kiếm bản đồ (UC-08, BR-04, BR-28)

- **Endpoint:** `GET /api/v1/workshops`
- **Quyền truy cập:** Công khai
- **Query Params:** `?search=Quang+Vinh&accepting_visitors=true&page=1&limit=20`
- **Phản hồi (`200 OK`):**
  ```json
  {
    "success": true,
    "data": [
      {
        "id": "301",
        "name": "Xưởng Gốm Minh Long Bát Tràng",
        "address": "Xóm 3, Bát Tràng, Gia Lâm, Hà Nội",
        "avatar_url": "/api/v1/media/current/workshop_profile/301/images/501/thumbnail",
        "latitude": 21.002345,
        "longitude": 105.912345,
        "accepting_visitors": true
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total_records": 45, "total_pages": 3 }
  }
  ```
  *Bảo mật (BR-04):* Chỉ trả về xưởng có `status = active` và đủ điều kiện công khai (`is_profile_public = true`). Không lộ username hay thông tin tài khoản.

---

### 4.2. Chi tiết hồ sơ xưởng (UC-08, BR-28)

- **Endpoint:** `GET /api/v1/workshops/:id`
- **Quyền truy cập:** Công khai
- **Phản hồi (`200 OK`):**
  ```json
  {
    "success": true,
    "data": {
      "id": "301",
      "name": "Xưởng Gốm Minh Long Bát Tràng",
      "story": "Gia đình 4 đời làm gốm vuốt tay men rạn cổ truyền...",
      "address": "Xóm 3, Bát Tràng, Gia Lâm, Hà Nội",
      "latitude": 21.002345,
      "longitude": 105.912345,
      "accepting_visitors": true,
      "images": [
        { "id": "501", "thumbnail_url": "/api/v1/media/current/workshop_profile/301/images/501/thumbnail", "display_url": "/api/v1/media/current/workshop_profile/301/images/501/display" }
      ],
      "certificates": [
        {
          "id": "601",
          "name": "Nghệ nhân Dân gian Bát Tràng 2020",
          "image": { "id": "503", "thumbnail_url": "/api/v1/media/current/certificate/601/images/503/thumbnail", "display_url": "/api/v1/media/current/certificate/601/images/503/display" }
        }
      ]
    }
  }
  ```

---

### 4.3. Artisan cập nhật hồ sơ xưởng của hộ mình (UC-05, BR-28)

- **Endpoint:** `PUT /api/v1/artisan/workshop`
- **Quyền truy cập:** `artisan` (Tự động gắn theo `current_user.workshop_id`)
- **Request DTO (`UpdateWorkshopProfileRequestDto`):**
  ```json
  {
    "name": "Xưởng Gốm Minh Long Bát Tràng",
    "story": "Cập nhật câu chuyện làm nghề năm 2026...",
    "address": "Số 45 Đường Gốm, Bát Tràng, Gia Lâm, Hà Nội",
    "latitude": 21.002345,
    "longitude": 105.912345,
    "avatar_image_id": "501",
    "image_ids": ["501", "502"],
    "certificates": [
      {
        "id": "601",
        "name": "Chứng nhận Nghệ nhân ưu tú",
        "image_id": "503"
      }
    ]
  }
  ```
  *Validation:* Vĩ độ trong khoảng `[-90, 90]`, kinh độ `[-180, 180]`. Chứng nhận phải có cả tên và `image_id` hợp lệ.

---

### 4.4. Artisan bật/tắt đón khách tham quan (UC-05, BR-10)

- **Endpoint:** `PATCH /api/v1/artisan/workshop/visitors`
- **Quyền truy cập:** `artisan`
- **Request DTO:**
  ```json
  { "accepting_visitors": true }
  ```

---

### 4.5. Admin tạm ngừng hoặc cho hộ hoạt động lại (UC-04, BR-05, SEC-15)

- **Endpoint:** `PATCH /api/v1/admin/workshops/:id/status`
- **Quyền truy cập:** `admin`
- **Request DTO (`ChangeWorkshopStatusRequestDto`):**
  ```json
  {
    "status": "suspended",
    "reason": "Xưởng vi phạm quy định môi trường nung gốm"
  }
  ```
  *Xử lý nghiệp vụ:*
  - Ghi `WORKSHOP_STATUS_LOG`.
  - Ẩn xưởng khỏi bản đồ và danh mục công khai.
  - Vô hiệu hóa (`expired`) các phương án chia đơn (`SplitProposal`) đang ở trạng thái `proposed` có chứa hộ này (BR-18).
  - Không thu hồi phiên đăng nhập của Artisan (Artisan vẫn đăng nhập để hoàn thành các phần việc đã chốt theo BR-05).

---

## 5. Module 3: Danh mục & Sản phẩm (`catalog`)

### 5.1. Danh sách phân loại công khai (BR-06)

- **Endpoint:** `GET /api/v1/categories`
- **Quyền truy cập:** Công khai
- **Phản hồi (`200 OK`):** Trả danh sách CategoryDto đang `is_active = true`; ban đầu có 5 phân loại, không cố định số lượng sau khi Admin quản lý.

---

### 5.2. Danh sách sản phẩm trưng bày công khai (UC-08, BR-07)

- **Endpoint:** `GET /api/v1/products`
- **Quyền truy cập:** Công khai
- **Query Params:** `?category_id=1&workshop_id=301&page=1&limit=20`
- **Phản hồi (`200 OK`):**
  ```json
  {
    "success": true,
    "data": [
      {
        "id": "701",
        "name": "Ấm chén Tử Sa Bát Tràng đắp nổi hoa mai",
        "price": 1250000,
        "category": { "id": "1", "name": "Ấm, chén và cốc" },
        "workshop": { "id": "301", "name": "Xưởng Gốm Minh Long Bát Tràng" },
        "thumbnail_url": "/api/v1/media/current/product/701/images/504/thumbnail"
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total_records": 12, "total_pages": 1 }
  }
  ```
  *Điều kiện hiển thị:* Chỉ trả về sản phẩm `status = published` thuộc xưởng đang `active` và lô đã `published`.

---

### 5.3. Artisan quản lý sản phẩm (UC-07, BR-07)

- **Tạo sản phẩm nháp:** `POST /api/v1/artisan/products`
- **Cập nhật sản phẩm:** `PUT /api/v1/artisan/products/:id`
- **Đổi trạng thái (Công bố / Ẩn):** `PATCH /api/v1/artisan/products/:id/status`
  - `status`: `"published"` hoặc `"hidden"`.
  - *Validation khi công bố:* Bắt buộc có tên, `category_id`, `price > 0`, ít nhất 1 ảnh, và `batch_id` phải trỏ tới một lô **đã công bố** của chính hộ mình.
- **Xóa sản phẩm nháp:** `DELETE /api/v1/artisan/products/:id` (Chỉ xóa được khi `status = draft`).

---

## 6. Module 4: Truy xuất nguồn gốc & Lô sản xuất (`traceability`)

### 6.1. Artisan tạo và quản lý Lô sản xuất (UC-10, BR-08, BR-09)

- **Tạo lô nháp:** `POST /api/v1/artisan/batches`
  - Request DTO: `{ "name": "Lô 500 ấm chén men rạn vuốt tay tháng 11/2026" }`
- **Thêm mốc nhật ký:** `POST /api/v1/artisan/batches/:id/journal`
  - Request DTO:
    ```json
    {
      "stage": "Nung gốm lần 2",
      "performed_at": "2026-11-03T14:30:00.000Z",
      "notes": "Nung củi ở nhiệt độ 1.280 độ C trong 24 giờ liên tục",
      "image_ids": ["801", "802"]
    }
    ```
    *Validation:* Ít nhất 1 ảnh minh chứng.
- **Sửa mốc nhật ký:** `PUT /api/v1/artisan/batches/:id/journal/:entryId`
  - Nếu lô đã `published`: Tự động lưu bản chụp mốc cũ vào `JOURNAL_EDIT_HISTORY` và giữ nguyên các ảnh cũ trong `JOURNAL_HISTORY_IMAGE` (BR-08). Không cho xóa mốc của lô đã công bố.
- **Công bố lô:** `POST /api/v1/artisan/batches/:id/publish`
  - *Điều kiện:* Có ít nhất một mốc nhật ký hợp lệ. Dùng mã `qr_token` duy nhất đã cấp khi tạo lô, không đổi mã khi công bố hoặc truy cập lại. Không thể chuyển ngược về nháp sau khi công bố.

---

### 6.2. Trang truy xuất nguồn gốc công khai qua mã QR (UC-12, BR-04, BR-09)

- **Endpoint:** `GET /api/v1/trace/:qrToken`
- **Quyền truy cập:** Công khai (Không cần đăng nhập)
- **Phản hồi (`200 OK`):**
  ```json
  {
    "success": true,
    "data": {
      "batch_name": "Lô 500 ấm chén men rạn vuốt tay tháng 11/2026",
      "published_at": "2026-11-04T08:00:00.000Z",
      "workshop": {
        "name": "Xưởng Gốm Minh Long Bát Tràng",
        "is_profile_available": true,
        "profile_url": "/api/v1/workshops/301"
      },
      "journal_entries": [
        {
          "id": "1001",
          "batch_id": "901",
          "created_at": "2026-10-25T09:00:00.000Z",
          "updated_at": "2026-10-25T09:00:00.000Z",
          "stage": "Chuẩn bị và tinh luyện đất cao lanh",
          "performed_at": "2026-10-25T09:00:00.000Z",
          "notes": "Lọc lắng đất 3 lần theo phương pháp cổ truyền",
          "images": [{ "id": "801", "thumbnail_url": "/api/v1/media/current/journal_entry/1001/images/801/thumbnail", "display_url": "/api/v1/media/current/journal_entry/1001/images/801/display" }]
        },
        {
          "id": "1002",
          "batch_id": "901",
          "created_at": "2026-11-03T14:30:00.000Z",
          "updated_at": "2026-11-03T14:30:00.000Z",
          "stage": "Nung gốm lần 2",
          "performed_at": "2026-11-03T14:30:00.000Z",
          "notes": "Nung củi ở nhiệt độ 1.280 độ C",
          "images": [{ "id": "802", "thumbnail_url": "/api/v1/media/current/journal_entry/1002/images/802/thumbnail", "display_url": "/api/v1/media/current/journal_entry/1002/images/802/display" }]
        }
      ],
      "updated_at": "2026-11-04T08:00:00.000Z",
      "journal_pagination": { "page": 1, "limit": 20, "total_records": 2, "total_pages": 1 },
      "disclaimer": "Nhật ký sản xuất do hộ gia đình tự chịu trách nhiệm cung cấp nội dung."
    }
  }
  ```
  *Bảo mật tuyệt đối (BR-04, BR-09):*
  - Nếu xưởng bị tạm ngừng: Trường `workshop.is_profile_available = false`, chỉ trả về tên dạng văn bản, **không trả link hay dữ liệu hồ sơ bị ẩn**.
  - **Tuyệt đối không lộ** thông tin Buyer, giá cả báo chào, địa chỉ bàn giao hay hợp đồng mua sỉ qua trang QR này.

---

## 7. Module 5: Tin tức cộng đồng (`community`)

- **Khách đọc tin đã công bố:** `GET /api/v1/news` và `GET /api/v1/news/:id` (Lọc `status = published`).
- **Admin quản lý tin tức (UC-09, BR-29):**
  - Tạo tin nháp: `POST /api/v1/admin/news`
  - Sửa tin: `PUT /api/v1/admin/news/:id` (Tự động cập nhật `updated_by`).
  - Đổi trạng thái (Công bố / Hạ về nháp): `PATCH /api/v1/admin/news/:id/status`.
  - Xóa tin nháp: `DELETE /api/v1/admin/news/:id`.

---

## 8. Module 6: Ảnh (`media`)

### 8.1. Upload và gắn ảnh

`POST /api/v1/media/upload` dùng multipart: `file`, `context_type` (`workshop_profile`, `certificate`, `product`, `journal_entry`), `context_id` (ID đối tượng hiện có, hoặc bỏ khi tạo đối tượng mới), `target_workshop_id` (hộ đích; server đối chiếu quyền). Artisan chỉ tải cho nội dung hộ mình. Buyer không được upload. Admin chỉ tải ảnh hồ sơ ban đầu trong luồng cấp hộ UC-03; không tải để sửa nội dung hộ đã tạo.

Đối tượng mới chưa có ID: reservation giữ chủ tải, context_type và hộ đích; lần lưu đầu kiểm tra rồi cố định context_id. Admin tạo hộ có ảnh phải tạo phạm vi upload trước bằng endpoint dưới đây; `initial_workshop_key` do server cấp, không nhận UUID tự tạo từ biểu mẫu. Upload khởi tạo chỉ nhận `context_type=workshop_profile`, `context_id` null và khóa thuộc Admin đang đăng nhập; không gửi đồng thời target_workshop_id. Không tính ảnh này vào quota cá nhân Admin.

**POST /api/v1/admin/workshop-upload-scopes** — Admin, phiên normal và CSRF; body `{}`. Trả 201 `InitialWorkshopUploadScopeDto`: `{ initial_workshop_key, expires_at }`; khóa UUID v4 ngẫu nhiên, hết hạn sau 24 giờ. Không trả ảnh/quota của Admin khác. Tối đa 3 phạm vi open chưa hết hạn/Admin; vượt trả 409 `UPLOAD_SCOPE_LIMIT_EXCEEDED`. Mỗi phạm vi có quota 2 GiB, tổng used + reserved của mọi quota khởi tạo chưa chuyển sang hộ của cùng Admin không vượt 2 GiB; ngân sách kho dùng chung vẫn áp dụng. Phạm vi hết hạn chưa dọn vẫn tính dung lượng. Kiểm tra tổng dưới khóa chủ Admin khi tạo/giữ chỗ để tránh vượt giới hạn đồng thời.

Khi cấp hộ, khóa phạm vi, quota và ảnh; kiểm tra chủ, hạn, trạng thái open, ảnh đã xử lý/chưa gắn và không có reservation reserved/cleanup_pending. Còn upload/dọn đang xử lý trả 409 `UPLOAD_SCOPE_BUSY`. Phạm vi hết hạn/đã dùng trả 422 `UPLOAD_SCOPE_UNAVAILABLE`; khóa không tồn tại hoặc thuộc Admin khác trả 404. Chuyển chính dòng StorageQuota từ initial_workshop_key sang workshop_id mới, giữ nguyên quota_id/used_bytes, gắn ảnh được chọn và đánh dấu phạm vi attached trong giao dịch tạo Account/Workshop. Rollback giữ nguyên phạm vi và quota cũ; không tăng/giảm dung lượng hai lần. Ảnh không được chọn vẫn nằm trong quota hộ mới, chỉ dọn khi hết hạn và không còn tham chiếu. Không tái sử dụng khóa cho hộ khác. Không có ảnh thì bỏ khóa và tạo quota hộ trực tiếp.

Upload và tác vụ dọn kiểm tra lại trạng thái phạm vi dưới cùng cơ chế khóa; phạm vi hết hạn không nhận upload hoặc gắn ảnh mới. Dọn ảnh bỏ dở sau 24 giờ, chỉ giải phóng byte sau khi xóa tệp thành công. Chi tiết lưu trữ tại mục 2.26–2.28 của thiết kế dữ liệu.

- Một ảnh/request, JPG/PNG/WebP, ≤5 MB, ≤25 triệu pixel, body ≤6 MiB; xử lý ≤10 giây, 20 ảnh/phút/tài khoản, tối đa 2 ảnh đồng thời. Kiểm tra/giải mã thực, loại EXIF/GPS, mã hóa lại; không phục vụ tệp đầu vào chưa xử lý.
- Giữ chỗ nguyên tử 16 MiB/ảnh cho quota/kho trước nhận tệp; quota 2 GiB/hộ, chỉ các ngữ cảnh ngoài hộ thực sự được cấp quyền mới dùng 1 GiB/tài khoản. Giữ trống max(2 GiB, 10% volume). Worker không vượt ngân sách, chỉ giải phóng sau xác nhận dọn.
- Thành công trả 201 ImageUploadDto sau khi xử lý và quyết toán thành công; không trả image_id sẵn sàng khi worker chưa xong. Worker lỗi trả 503 IMAGE_PROCESSING_UNAVAILABLE; ảnh không hợp lệ trả 400 INVALID_IMAGE_FORMAT; quá hạn mức xử lý đồng thời/tần suất trả 429.

```json
{
  "success": true,
  "data": {
    "image_id": "801",
    "context_type": "journal_entry",
    "context_id": null,
    "thumbnail_url": "/api/v1/media/pending/801/thumbnail",
    "display_url": "/api/v1/media/pending/801/display",
    "unattached_expires_at": "2026-11-05T10:00:00.000Z"
  }
}
```

Lưu biểu mẫu nghiệp vụ dùng image_ids; server kiểm tra ảnh ready, chủ/ngữ cảnh đúng, không dùng cùng image_id cho đối tượng khác. Tối đa 10 ảnh/sản phẩm hoặc mốc nhật ký; hồ sơ tối đa 10 ảnh xưởng và 20 chứng nhận là giới hạn request MVP. Ảnh đang dùng/lịch sử không hết hạn theo unattached_expires_at. Dọn ảnh không còn tham chiếu sau 24 giờ, không dọn ảnh lịch sử. Mỗi ảnh lỗi có thể thử lại độc lập; lưu biểu mẫu thất bại không thay ảnh hiện hành.

### 8.2. Đọc ảnh theo ngữ cảnh

| GET /api/v1 + đường dẫn | Quyền và điều kiện |
|---|---|
| `/media/pending/:imageId/:variant` | Người tải trong phạm vi upload hợp lệ; chỉ ảnh chưa gắn lần đầu, không có lịch sử. Hết phạm vi/đã gắn thì 404. |
| `/media/current/:contextType/:contextId/images/:imageId/:variant` | Kiểm tra ảnh hiện hành thực sự thuộc đối tượng. Public nếu đối tượng được công khai; nếu riêng tư, Artisan chủ hộ được đọc; Admin chỉ được đọc ảnh hồ sơ/chứng nhận và nhật ký theo SEC-10, không được đọc ảnh sản phẩm chưa công bố chỉ vì có vai trò Admin. Không lấy quyền public trong quá khứ. |
| `/media/history/:historyId/images/:imageId/:variant` | Chỉ Artisan chủ nhật ký/Admin; phải có JournalHistoryImage tương ứng. Buyer không đọc ngữ cảnh lịch sử dù có phần việc. |

variant chỉ `thumbnail` hoặc `display`; không có endpoint đọc bằng storageKey hay tải bản gốc. contextType chỉ bốn loại ở mục 8.1. Ảnh chứng nhận công khai theo hồ sơ xưởng, ảnh sản phẩm theo sản phẩm, ảnh nhật ký theo lô published kể cả hộ suspended. Cùng ảnh hiện hành và lịch sử có URL/quyền riêng. Tất cả response ảnh dùng `Cache-Control: no-store` cho MVP để lần truy cập sau kiểm tra lại quyền; API riêng tư cũng no-store. Không trả đường dẫn kho. Ảnh không có quyền biết tồn tại trả 404; endpoint riêng tư chưa xác thực trả 401.

---

## 9. Module 7: Đơn hàng, Báo giá & Điều phối (`trading`)

### 9.1. Buyer tạo và chỉnh sửa yêu cầu báo giá (UC-14, BR-11)

- **Tạo yêu cầu nháp:** `POST /api/v1/buyer/quote-requests`
- **Sửa yêu cầu nháp:** `PUT /api/v1/buyer/quote-requests/:id`
- **Request DTO (`SaveQuoteRequestDto`):**
  ```json
  {
    "category_id": "1",
    "spec": "5.000 cốc gốm dung tích 300ml, men trắng bóng, in logo Bát Tràng Heritage",
    "quantity": 5000,
    "unit": "piece",
    "unit_set_description": null,
    "delivery_mode": "at_buyer_address",
    "delivery_region": "Phường Cầu Giấy, TP. Hà Nội",
    "delivery_address": "Số 88 Phố Duy Tân, Phường Dịch Vọng Hậu, Cầu Giấy, Hà Nội",
    "recipient_name": "Nguyễn Văn An",
    "recipient_phone": "0987654321",
    "bidding_deadline": "2026-11-12T17:00:00.000Z",
    "delivery_deadline": "2026-12-01T17:00:00.000Z"
  }
  ```
  *Lưu nháp:* POST cho phép `{}`; các trường nghiệp vụ trong ví dụ đều tùy chọn/nullable. PUT nhận bản đầy đủ của nháp cùng `expected_request_version`; trường nullable bị bỏ sẽ được xóa. Giá trị đã nhập phải đúng kiểu, quantity nguyên dương, enum hợp lệ. Chưa bắt buộc đủ liên hệ, mô tả bộ, địa chỉ hoặc hạn tương lai.
  *Khi gửi:* Bắt buộc category_id, spec không rỗng, quantity, unit, delivery_mode, recipient_name/phone, hai thời hạn. `unit = set` cần unit_set_description; giao tới Buyer cần khu vực tỉnh/thành + xã/phường và địa chỉ chi tiết. Phải thỏa `now < bidding_deadline` và `delivery_deadline > bidding_deadline + 24h`. Không tự sửa hạn. Trả 201 khi tạo, 200 khi sửa, BuyerRequestDto có version.

---

### 9.2. Buyer gửi yêu cầu tới các hộ phù hợp (UC-15, BR-13)

- **Endpoint:** `POST /api/v1/buyer/quote-requests/:id/send`
- **Quyền truy cập:** `buyer` sở hữu yêu cầu
- **Điều kiện:** Yêu cầu đang ở trạng thái `Draft Request`, tìm thấy ít nhất 1 hộ đang `active` có ít nhất một sản phẩm đã công bố thuộc `category_id`. Không có hộ phù hợp trả 422 NO_ELIGIBLE_WORKSHOP và giữ nháp. Kiểm tra đủ dữ liệu/hạn tại lúc gửi; lưu danh sách toàn bộ hộ phù hợp cùng chuyển trạng thái trong một giao dịch.
- **Phản hồi (`200 OK`):** Chuyển trạng thái sang `Sent to Artisans`, lưu danh sách `RequestRecipient` cho từng hộ.

---

### 9.3. Phân quyền đọc chi tiết Yêu cầu báo giá (Data Masking - BR-04, SEC-04)

Khi gọi `GET /api/v1/quote-requests/:id`:
- **Buyer sở hữu & Admin:** Nhận BuyerRequestDto/AdminRequestDto theo mục 11; gồm liên hệ nhưng không serialize toàn bộ entity. Báo giá, hộ nhận và lịch sử lấy qua các API phân trang riêng.
- **Hộ Artisan được mời nhưng CHƯA có phần việc được chốt:**
  - **Được thấy:** `spec`, `category`, `quantity`, `unit`, `unit_set_description`, `delivery_mode`, `delivery_region` (khu vực khái quát), `bidding_deadline`, `delivery_deadline`, báo giá của chính hộ mình.
  - **Không có trong DTO:** `recipient_name`, `recipient_phone`, `delivery_address` (địa chỉ chi tiết), danh sách các hộ đối thủ khác và báo giá của họ.
- **Hộ Artisan ĐÃ CÓ PHẦN VIỆC ĐƯỢC CHỐT (`Allocation`):**
  - Mở quyền xem đầy đủ `recipient_name`, `recipient_phone`, `delivery_address` để chuẩn bị sản xuất và giao hàng.

---

### 9.4. Artisan phản hồi yêu cầu và gửi báo giá (UC-16, BR-14, BR-15)

#### Từ chối không tham gia

- **Endpoint:** `POST /api/v1/artisan/quote-requests/:id/decline`
- **Request DTO:** `{ "expected_recipient_version": 1, "decline_reason": "Xưởng đang đầy tải lò nung tháng 11" }`; lý do tùy chọn. Chỉ hộ được mời, yêu cầu còn mở/chưa chốt/hủy và chưa từng có Quote được từ chối; hộ đang tạm ngừng vẫn được từ chối. Không phản hồi không tạo dấu đã đọc. Trả 200 RecipientDto và ghi lịch sử.

#### Gửi hoặc sửa báo giá

- **Endpoint:** `POST /api/v1/artisan/quote-requests/:id/quote`
- **Request DTO (`SubmitQuoteRequestDto`):**
  ```json
  {
    "expected_recipient_version": 1,
    "expected_quote_version": null,
    "unit_price": 45000,
    "max_quantity": 3000,
    "bid_accept_deadline": "2026-11-14T17:00:00.000Z",
    "committed_delivery_at": "2026-11-28T17:00:00.000Z"
  }
  ```
  *Quyền/trạng thái:* Hộ được mời và đang hoạt động, yêu cầu còn mở nhận, chưa chốt/hủy. POST tạo lần đầu trả 201; sửa/gửi lại trên chính bản ghi cũ trả 200 QuoteMutationDto. expected_quote_version phải null khi chưa có Quote, là version hiện tại khi đã có, kể cả withdrawn. Ghi lịch sử và tăng version; không tạo báo giá thứ hai hoặc khôi phục phương án cũ.
  *Ràng buộc Validation (BR-14):*
  - `unit_price`: > 0 (VND, chỉ là tiền hàng, không gồm phí vận chuyển).
  - `max_quantity`: $0 < max\_quantity \le request.quantity$.
  - **Ràng buộc thời gian 24 giờ:** Bắt buộc:
    $$now < bid\_accept\_deadline < committed\_delivery\_at \le request.delivery\_deadline$$
    $$bid\_accept\_deadline \ge request.bidding\_deadline + 24h$$

#### Rút báo giá

- **Endpoint:** `POST /api/v1/artisan/quote-requests/:id/quote/withdraw`
- **Request DTO:** `{ "expected_recipient_version": 2, "expected_quote_version": 1, "withdraw_reason": "Hỏng lò nung không kịp phục vụ tiến độ" }` (Bắt buộc nhập lý do). Hộ sở hữu được rút Quote active khi yêu cầu chưa chốt/chưa hủy, kể cả đóng nhận hoặc hộ suspended. Trả 200 QuoteMutationDto; giữ nội dung và lưu lịch sử, expire phương án liên quan.

---

### 9.5. Điều phối và Chấp nhận báo giá (UC-17, 19, 20, 21, 22)

#### Buyer đóng nhận báo giá sớm (UC-17, BR-12)

- **Endpoint:** `POST /api/v1/buyer/quote-requests/:id/close-bidding`
- **Quy tắc:** Nhận `{ "expected_request_version": 2 }`; chỉ Buyer sở hữu yêu cầu đã gửi/chưa chốt/hủy. Nếu đóng trước hạn lưu `bidding_closed_at = now()`; nếu đã tới hạn lưu bidding_deadline, không ghi thời gian worker chạy. Đóng nhận tính theo thời gian máy chủ dù chưa có tác vụ nền. Đã đóng thì các hộ không được gửi/sửa báo giá nữa nhưng vẫn được rút báo giá chưa chốt.

#### Buyer nhờ Ban quản lý chia đơn (UC-20, BR-17)

- **Endpoint:** `POST /api/v1/buyer/quote-requests/:id/request-split`
- **Điều kiện:** Yêu cầu đã đóng nhận (`now >= bidding_deadline` hoặc đã đóng sớm), tổng các báo giá hợp lệ đủ đáp ứng yêu cầu cho $\ge 2$ hộ. Ghi nhận yêu cầu vào `split-queue` của Admin.

#### Admin tạo Phương án chia đơn (UC-21, BR-17, BR-18)

- **Endpoint:** `POST /api/v1/admin/quote-requests/:id/split-proposals`
- **Quyền truy cập:** `admin`
- **Request DTO (`CreateSplitProposalRequestDto`):**
  ```json
  {
    "expected_request_version": 3,
    "expected_proposal_id": null,
    "expected_proposal_version": null,
    "items": [
      { "workshop_id": "301", "quote_id": "401", "expected_quote_version": 2, "allocated_quantity": 3000 },
      { "workshop_id": "302", "quote_id": "402", "expected_quote_version": 1, "allocated_quantity": 2000 }
    ]
  }
  ```
  *Validation:* Đã đóng nhận, có split_requested_at, yêu cầu chưa chốt/hủy. expected_proposal_id và expected_proposal_version bắt buộc cùng null khi không có bản proposed; nếu thay thế phải gửi đúng ID và version của bản proposed hiện tại. Khóa yêu cầu, đọc lại và so sánh cả cặp trong cùng giao dịch; lệch bất kỳ giá trị nào trả 409 CONCURRENCY_CONFLICT, không expire hoặc tạo phương án. Hai bản khác ID dù cùng version 1 không tương đương. Lượng chia nguyên dương; hộ/báo giá cùng yêu cầu, đang đủ điều kiện; giá/ngày giao lấy từ server. Ít nhất 2 hộ khác nhau. Mỗi hộ xuất hiện 1 lần. $allocated\_quantity \le quote.max\_quantity$. $\sum allocated\_quantity == request.quantity$.

#### Buyer chấp nhận báo giá trực tiếp (UC-19, BR-16)

- **Endpoint:** `POST /api/v1/buyer/quote-requests/:id/accept-quote`
- **Headers:** `X-Idempotency-Key: <uuid>`
- **Request DTO:** `{ "quote_id": "401", "expected_request_version": 3, "expected_quote_version": 2 }`
- **Xử lý Transaction:** Kiểm tra báo giá còn hiệu lực, đủ 100% số lượng $\rightarrow$ chuyển `Buyer Accepted` $\rightarrow$ tạo đúng 1 `Allocation`.

#### Buyer chấp nhận phương án chia đơn (UC-22, BR-19)

- **Endpoint:** `POST /api/v1/buyer/quote-requests/:id/split-proposals/:proposalId/accept`
- **Headers:** `X-Idempotency-Key: <uuid>`
- **Request DTO:** `{ "expected_request_version": 4, "expected_proposal_version": 1 }`; các quote_version phải khớp bản chụp trong phương án.
- **Xử lý Transaction:** Chốt phương án $\rightarrow$ tạo các bản ghi `Allocation` tương ứng cho từng hộ trong cùng một giao dịch.

---

### 9.6. Tiến độ sản xuất, Bàn giao & Hoàn tất đơn hàng (UC-23, 24, 25, 26)

#### Artisan bắt đầu phần việc & Liên kết lô (UC-23, BR-24)

- **Bắt đầu phần việc:** `POST /api/v1/artisan/allocations/:id/start` (Chuyển trạng thái sang `in_production`).
- **Liên kết lô truy xuất:** `PUT /api/v1/artisan/allocations/:id/batches`
  - Request DTO:
    ```json
    {
      "expected_allocation_version": 2,
      "links": [
        { "batch_id": "901", "linked_quantity": 2000 },
        { "batch_id": "902", "linked_quantity": 1000 }
      ]
    }
    ```
    *Validation:* PUT thay toàn bộ danh sách liên kết; [] để bỏ các liên kết khi còn được sửa. Chỉ khi đang sản xuất, yêu cầu chưa hủy/hoàn tất; khóa sau handed_over. Batch ID không trùng, linked_quantity nguyên dương; lô nháp được liên kết nhưng Buyer chưa đọc được QR. Lô phải thuộc cùng hộ. $\sum linked\_quantity \le allocation.quantity$.

#### Ghi nhận bàn giao phần việc (UC-24, BR-24)

- **Artisan ghi nhận đã bàn giao:** `POST /api/v1/artisan/allocations/:id/handover`
  - Request DTO: `{ "expected_allocation_version": 3, "delivery_note": "Đã bàn giao đủ 3.000 cốc tại xưởng cho bên nhận" }`
  - Chuyển `Allocation.status` sang `handed_over`.
- **Ngoại lệ: Admin ghi nhận bàn giao thay hộ (BR-24):**
  - `POST /api/v1/admin/allocations/:id/handover-by-admin`
  - Request DTO:
    ```json
    {
      "expected_allocation_version": 3,
      "reason": "Hộ đã bàn giao đủ nhưng mất điện không truy cập được phần mềm",
      "evidence": "Biên bản ký nhận bàn giao hàng giấy số BB-012/2026 có chữ ký thủ kho Buyer",
      "actual_handover_at": "2026-11-20T10:00:00.000Z"
    }
    ```
    *Quy tắc:* Cả Artisan/Admin chỉ bàn giao phần việc in_production, yêu cầu In Production chưa hủy. Admin không được tự tạo bước bắt đầu sản xuất hoặc sửa liên kết lô. Thiếu liên kết/lô nháp chỉ cảnh báo, không chặn bàn giao. `actual_handover_at` không được ở tương lai. Bắt buộc có lý do và căn cứ xác minh.

#### Xác nhận nhận đủ đơn hàng (UC-25, UC-26, BR-25)

- **Buyer xác nhận nhận đủ toàn bộ đơn:**
  - `POST /api/v1/buyer/quote-requests/:id/confirm-delivery`
  - *Điều kiện:* Mọi `Allocation` của yêu cầu đều phải ở trạng thái `handed_over`. Chuyển `QuoteRequest.status` sang `Delivered`.
- **Ngoại lệ: Admin xác nhận nhận đủ thay Buyer (UC-26, BR-25):**
  - `POST /api/v1/admin/quote-requests/:id/confirm-delivery-by-admin`
  - *Request DTO:* `{ "expected_request_version": 6, "reason": "Buyer đã nhận đủ nhưng chưa cập nhật", "evidence": "Biên bản nghiệm thu hàng hóa đại diện Buyer ký ngày..." }`. Cùng điều kiện với Buyer: yêu cầu In Production chưa hủy, mọi phần việc handed_over. Ghi sự kiện riêng, không giả danh Buyer.

---

### 9.7. Hủy yêu cầu báo giá (UC-27, BR-21, BR-22)

- **Buyer hủy (Trước khi chấp nhận):**
  - `POST /api/v1/buyer/quote-requests/:id/cancel`
  - *Điều kiện:* Yêu cầu ở `Sent to Artisans` hoặc `Artisans Bidding`.
  - Request DTO: `{ "expected_request_version": 3, "cancel_reason": "Thay đổi kế hoạch kinh doanh cuối năm" }`; lý do Buyer tùy chọn
- **Admin hủy (Sau khi đã chấp nhận):**
  - `POST /api/v1/admin/quote-requests/:id/cancel-by-admin`
  - *Điều kiện:* Yêu cầu ở `Buyer Accepted` hoặc `In Production`. **Tuyệt đối không được hủy khi đã `Delivered`.**
  - Request DTO:
    ```json
    {
      "expected_request_version": 6,
      "cancel_reason": "Sự cố bất khả kháng thiên tai ngập xưởng sản xuất",
      "goods_handling_note": "1.000 sản phẩm đã bàn giao được đối soát thanh toán ngoài hệ thống theo giá báo chào"
    }
    ```
  - *Quy tắc (BR-22):* Giữ trạng thái chính, ghi cancelled_at/cancelled_by/cancel_reason và cách xử lý hàng trong log; không xóa phần đã bàn giao, không sinh trạng thái Cancelled thứ bảy. Hủy nháp bị từ chối, nháp dùng DELETE. Lý do Admin bắt buộc, goods_handling_note bắt buộc khi đang sản xuất. Expire phương án proposed, dừng các thay đổi nghiệp vụ tiếp theo.

---

## 10. Endpoint bổ sung và hợp đồng theo luồng

Đường dẫn trong bảng nối với `/api/v1`. GET trả 200, danh sách dùng pagination; POST tạo bản ghi trả 201; PUT/PATCH/action trả 200; DELETE trả 204 trừ quy định riêng. DTO ở mục 11. Dấu ? trong mô tả là tùy chọn; nullable cho phép null rõ ràng. Endpoint ghi trading áp dụng version/idempotency mục 1.4. Không cấp quyền bằng wildcard tiền tố URL.

### 10.1. Tài khoản và xưởng

| Method + path | Quyền | Request/query → response và điều kiện |
|---|---|---|
| GET /admin/accounts | Admin | search, role=buyer/artisan, page/limit → AccountSummaryDto; phục vụ chọn tài khoản khôi phục, không trả bí mật |
| GET /admin/workshops | Admin | search tên/mã/username, status=active/suspended → AdminWorkshopDto; gồm hộ chưa công khai |
| GET /admin/workshops/:id | Admin | → AdminWorkshopDto |
| GET /artisan/workshop | Artisan | → OwnWorkshopDto của hộ mình, kể cả suspended/chưa công khai |
| GET /admin/workshops/:id/status-history | Admin | page/limit → WorkshopStatusEventDto |

POST cấp Artisan nhận username/workshop_name bắt buộc; address/story/latitude/longitude tùy chọn nullable, image_ids tùy chọn mặc định [], initial_workshop_key bắt buộc nếu có ảnh khởi tạo. Chỉ ảnh workshop_profile của đúng phạm vi khởi tạo được gắn; không cấp chứng nhận mặc định. Tạo Account/Workshop/quota/quan hệ ảnh/SecurityAuditLog cùng giao dịch. Không có API Admin sửa hồ sơ sau tạo.

PUT hồ sơ nhận name bắt buộc; story/address/latitude/longitude nullable; image_ids đầy đủ; avatar_image_id nullable và nếu có phải thuộc image_ids; certificates là `{ id?, name, image_id }[]`. Có id cập nhật chứng nhận của hộ; thiếu id tạo mới; phần tử bỏ khỏi danh sách là gỡ chứng nhận. Không chuyển ảnh chứng nhận cũ sang đối tượng mới. Trả OwnWorkshopDto. Hồ sơ từng đủ điều kiện không được sửa thiếu tên/địa chỉ/giới thiệu/ảnh; hai tọa độ cùng null hoặc cùng hợp lệ. PATCH visitors trả `{ accepting_visitors }`.

PATCH trạng thái hộ nhận status và reason không rỗng, trả AdminWorkshopDto; log cùng giao dịch đổi trạng thái/expire phương án. Chốt đồng thời phải chỉ có kết quả hợp lệ theo thứ tự khóa. Suspended không khóa phiên hoặc cấm hoàn thành việc cũ. Gửi cùng trạng thái trả trạng thái hiện tại, không ghi log chuyển trạng thái giả.

Reset mật khẩu trả `{ account_id, temporary_password, expires_at }` một lần, TTL 24 giờ; tăng auth_version/thu hồi mọi phiên đích, không đổi role/trạng thái hộ hoặc tự mở khóa bảo mật. Kiểm tra lại phiên/auth_version Admin và căn cứ xác minh trong giao dịch. Không có reset Admin. Mất response cấp/reset phải xác minh trạng thái rồi đặt lại theo quy trình, không có GET lấy lại mật khẩu hoặc replay bí mật.

### 10.2. Phân loại, sản phẩm và tin tức

| Method + path | Quyền | Request/query → response và điều kiện |
|---|---|---|
| GET /admin/categories | Admin | is_active?, search → CategoryDto kể cả ngừng dùng |
| POST /admin/categories | Admin | `{ name }` → CategoryDto, active mặc định true; tên trùng 409 NAME_TAKEN |
| PUT /admin/categories/:id | Admin | `{ name, is_active }` → CategoryDto; không đổi nhóm của dữ liệu cũ |
| DELETE /admin/categories/:id | Admin | Không body; đang tham chiếu trả 422 RESOURCE_IN_USE |
| GET /products/:id | Public | → PublicProductDto; không công khai trả 404 |
| GET /artisan/products | Artisan | status?, category_id?, batch_id?, search → OwnProductDto của hộ mình |
| GET /artisan/products/:id | Artisan | → OwnProductDto, hộ khác trả 404 |
| GET /admin/news | Admin | status?, post_type?, search → NewsDto gồm nháp |
| GET /admin/news/:id | Admin | → NewsDto gồm nháp |

ProductWriteDto cho POST/PUT: `{ batch_id, category_id, name, price, description, image_ids }`; batch_id/category_id/name/price bắt buộc theo data-design, description nullable, image_ids mặc định [] khi tạo và bắt buộc khi PUT. Batch cùng hộ, category hoạt động khi chọn mới; ngừng phân loại không làm mất dữ liệu cũ. Tạo draft; PUT không đổi status. Tối đa 10 ảnh đúng product/ngữ cảnh tạo mới. Công bố cần ≥1 ảnh và lô published; không chuyển lô khi lô hiện tại đã công bố. Chỉnh sản phẩm published/hidden phải giữ đủ dữ liệu công bố. POST trả 201 OwnProductDto; PUT/PATCH status trả 200 OwnProductDto. DELETE chỉ nháp không vi phạm tham chiếu, 204.

NewsWriteDto: `{ title, content, post_type }` bắt buộc; post_type là material/power_schedule/support_policy/announcement. POST tạo draft, PUT giữ status, PATCH nhận status draft/published; trả NewsDto. DELETE chỉ draft; public GET chỉ published. Không thêm upload ảnh tin tức. Mã hóa output, không thực thi HTML/script nhập từ người dùng.

### 10.3. Lô, nhật ký và lịch sử

| Method + path | Quyền | Request/query → response và điều kiện |
|---|---|---|
| GET /admin/batches | Admin | workshop_id?, status?, search, page/limit → AdminBatchDto; gồm nháp, chỉ đọc |
| GET /admin/batches/:id | Admin | → AdminBatchDto; gồm nháp |
| GET /admin/batches/:id/journal | Admin | page/limit, sort_by=performed_at → JournalEntryDto; kiểm tra lô tồn tại |
| GET /artisan/batches | Artisan | status?, search → BatchDto của hộ mình |
| GET /artisan/batches/:id | Artisan | → BatchDto kể cả draft; biết token không làm QR draft công khai |
| GET /artisan/batches/:id/journal | Artisan | page/limit, sort_by=performed_at → JournalEntryDto cùng hộ |
| PUT /artisan/batches/:id | Artisan | `{ name }` → BatchDto; chỉ sửa tên lô nháp |
| DELETE /artisan/batches/:id/journal/:entryId | Artisan | Không body; chỉ mốc đúng lô nháp, kiểm tra tham chiếu; 204 |
| GET /batches/:id/journal/:entryId/history | Artisan chủ lô/Admin | page/limit → JournalHistoryDto; kiểm tra entry thuộc batch |
| GET /batches/:id/journal/:entryId/history/:historyId | Artisan chủ lô/Admin | → JournalHistoryDto; kiểm tra đủ batch-entry-history |

AdminBatchDto là BatchDto thêm workshop: {id,name}. Quyền đọc lô không cấp quyền sửa lô, nhật ký hoặc xem sản phẩm chưa công bố của hộ. Admin dùng endpoint lịch sử chung bên trên để đọc bản sửa cũ.

POST/PUT mốc nhận stage, performed_at, notes nullable, image_ids 1–10 ảnh. PUT thay nội dung, không đổi batch/chủ. Nếu published, lưu nội dung/ảnh cũ trước sửa cùng transaction; trả JournalEntryDto mới. POST lô trả BatchDto. POST publish nhận `{}` trả BatchDto, công bố lặp không đổi QR/published_at. Public trace chỉ dữ liệu hiện hành; mốc có id/updated_at và URL current. Trace nhận page/limit cho journal_entries, trả journal_pagination cùng metadata batch/workshop; sắp performed_at rồi id, không tải nhật ký không giới hạn.

### 10.4. Yêu cầu và quyền đọc trading

| Method + path | Quyền | Request/query → response và điều kiện |
|---|---|---|
| GET /buyer/quote-requests | Buyer | status?, cancelled?, page/limit → BuyerRequestSummaryDto của mình |
| GET /artisan/quote-requests | Artisan | response_status?, status?, page/limit → InvitedRequestDto theo lời mời hộ mình |
| GET /admin/quote-requests | Admin | status?, cancelled?, buyer_id? → BuyerRequestSummaryDto |
| GET /quote-requests/:id | Buyer chủ/Admin/Artisan được mời hoặc có phần việc | → DTO theo [hợp đồng DTO, mục 2.2](api-dtos.md), ngoài quan hệ trả 404 |
| DELETE /buyer/quote-requests/:id | Buyer chủ | `{ expected_request_version }` → 204; chỉ Draft Request; kiểm tra đua với gửi |
| POST /buyer/quote-requests/:id/copy | Buyer chủ | `{}` → 201 BuyerRequestDto; sao chép quy cách/số lượng/đơn vị/nhận hàng/liên hệ; bỏ thời hạn/lời mời/báo giá/phương án/phần việc/lịch sử; Draft Request version 1 |
| PATCH /buyer/quote-requests/:id/contact | Buyer chủ | `{ expected_request_version, recipient_name, recipient_phone }` → BuyerRequestDto; đã gửi, chưa hủy/Delivered; lưu trước/sau, actor/time |
| GET /quote-requests/:id/recipients | Buyer chủ/Admin | response_status?, page/limit → RecipientDto; không phải trạng thái đã đọc |
| GET /quote-requests/:id/recipients/:recipientId/history | Buyer chủ/Admin/Artisan của recipient | page/limit → RecipientEventDto; đúng request/hộ |
| GET /quote-requests/:id/quotes | Buyer chủ/Admin/Artisan được mời | page/limit → QuoteDto; Artisan chỉ Quote mình, total chỉ đếm dữ liệu được xem |
| GET /quote-requests/:id/contact-history | Buyer chủ/Admin/Artisan có Allocation | page/limit → ContactEventDto; giữ quyền sau hủy/hoàn tất |
| GET /quote-requests/:id/history | Buyer chủ/Admin | page/limit → RequestEventDto gồm hủy/Admin xác nhận thay |
| GET /quote-requests/:id/allocations | Buyer chủ/Admin/Artisan có Allocation | page/limit → AllocationDto; Artisan chỉ phần mình |
| GET /artisan/allocations | Artisan | status?, request_id?, page/limit → AllocationDto hộ mình |
| GET /allocations/:id | Buyer chủ yêu cầu/Admin/Artisan chủ phần việc | → AllocationDto |
| GET /allocations/:id/history | Cùng quyền đọc phần việc | page/limit → AllocationEventDto |
| GET /allocations/:id/batches | Cùng quyền đọc phần việc | page/limit → AllocationBatchDto; Buyer chỉ có trace_url khi published |

Gửi/đóng nhận/nhờ chia nhận `{ expected_request_version }`, trả BuyerRequestDto. Nhờ chia: yêu cầu chưa chốt/hủy, đã đóng, ít nhất hai báo giá hợp lệ phân bổ đủ. Một hộ đủ toàn bộ vẫn cho chia nếu phân bổ dương cho ≥2 hộ; không tạo phương án một hộ. Gọi lại nhờ chia không đặt lại split_requested_at ban đầu. Hoạt động lại hộ không tự thêm lời mời vào yêu cầu cũ.

### 10.5. Hàng chờ và quyết định phương án

| Method + path | Quyền | Request/query → response và điều kiện |
|---|---|---|
| GET /admin/split-queue | Admin | coordination_state?, page/limit; mặc định split_requested_at asc → SplitQueueItemDto; loại chốt/hủy, giữ mục thiếu khả năng |
| GET /quote-requests/:id/split-proposals | Buyer chủ/Admin | page/limit → SplitProposalDto; giữ expired/accepted |
| GET /quote-requests/:id/split-proposals/:proposalId | Buyer chủ/Admin | → SplitProposalDto thuộc đúng yêu cầu |
| POST /buyer/quote-requests/:id/split-proposals/:proposalId/reject | Buyer chủ | `{ expected_request_version, expected_proposal_version, reason }` → SplitProposalDto; reason bắt buộc; chỉ proposed, yêu cầu chưa chốt/hủy |

Lập phương án trả 201 SplitProposalDto: expire proposed cũ và insert mới nguyên tử. Từ chối lưu người/thời điểm/lý do, expired và nhãn cần lập lại, không đổi trạng thái chính. Đọc/chấp nhận kiểm tra hạn thực dù worker chưa chạy; hoạt động lại hộ không phục hồi expired. Không nhận một phần phương án.

Chấp nhận trực tiếp/phương án trả 200 AcceptanceDto `{ request_id, request_status, request_version, accepted_proposal_id, allocations }`; accepted_proposal_id null khi trực tiếp, allocations là AllocationDto mới. Giá/ngày giao từ server; đơn giá chỉ tiền hàng. Transaction tạo đủ phần việc, Quote accepted và Proposal accepted nếu có, expire proposed khác, log/idempotency cùng commit. Không có Order mới.

### 10.6. Tiến độ, nhận đủ và hủy

POST start nhận `{ expected_allocation_version }`; Artisan chủ phần việc not_started trên yêu cầu Buyer Accepted/In Production chưa hủy. Đổi phần việc in_production; hộ đầu tiên bắt đầu làm yêu cầu In Production, không bắt đầu các hộ khác. Trả AllocationDto.

PUT batches, POST handover/handover-by-admin trả AllocationDto có version mới. PUT batches khi đang sản xuất; bắt đầu có thể nối tiếp ngay bằng liên kết lô. Tổng ≤ quantity, không trùng lô, không giữ tồn kho giữa đơn. Thiếu liên kết/lô nháp trả traceability_warning, không chặn bàn giao.

Buyer confirm-delivery nhận `{ expected_request_version }`; Admin thêm reason/evidence bắt buộc. Chỉ yêu cầu In Production chưa hủy với mọi phần việc handed_over. Trả BuyerRequestDto Delivered. Không tự nhận đủ vì hộ báo bàn giao; thiếu truy xuất không chặn xác nhận.

Hủy thường/Admin trả BuyerRequestDto có dấu hủy và giữ status. Admin log cách xử lý hàng/phần đã giao; không thay hộ, giảm lượng hoặc quyết toán từng phần. Admin thay lưu người thật, thời gian hệ thống, lý do/căn cứ và thời gian bàn giao thực tế riêng. Map reason → admin_handover_reason, evidence → admin_delivery_evidence, actual_handover_at → admin_handover_actual_at trên Allocation; xác nhận nhận đủ lưu RequestEventDto riêng. UI có nhãn “Admin ghi nhận bàn giao thay hộ” và “Admin xác nhận nhận đủ thay Buyer”.

---

## 11. DTO phản hồi

Danh sách trường, kiểu dữ liệu, nullability và biến thể theo vai trò nằm trong [hợp đồng DTO](api-dtos.md). Endpoint chỉ trả các trường của DTO được chỉ định; không serialize trực tiếp entity.

---

## 12. Ma trận quyền theo method và hành động

Ma trận không cấp quyền endpoint chưa được định nghĩa. Đường dẫn đầy đủ mục 3–10 quyết định đối tượng; riêng tư cần phiên normal trừ ngoại lệ auth. Admin không gọi endpoint ghi Buyer/Artisan để thực hiện thay.

| Method + endpoint/hành động đã định nghĩa | Người được gọi | Giới hạn |
|---|---|---|
| POST /admin/workshop-upload-scopes | Admin | Phạm vi khởi tạo thuộc mình, hạn và quota theo mục 8 |
| GET /admin/batches; GET /admin/batches/:id; GET /admin/batches/:id/journal | Admin | Đọc cả nháp; không có quyền ghi thay |
| GET /auth/csrf | Khách/normal/temp_password | Chỉ bootstrap token |
| POST /auth/register-buyer; POST /auth/login | Khách có preauth | CSRF/rate-limit, không chọn role |
| GET /auth/me; POST /auth/change-password | Normal | Chính tài khoản phiên |
| POST /auth/change-temp-password | Temp_password | Mật khẩu tạm còn hạn |
| POST /auth/logout | Normal/temp_password | Phiên hiện tại, CSRF |
| POST /admin/accounts/artisan; POST /admin/accounts/:id/reset-password; GET /admin/accounts | Admin | Cấp hộ/reset Buyer/Artisan, không reset Admin |
| GET /workshops, /workshops/:id, /categories, /products, /products/:id, /news, /news/:id, /trace/:qrToken | Công khai | Chỉ dữ liệu công khai |
| GET/PUT /artisan/workshop; PATCH /artisan/workshop/visitors | Artisan | Hộ mình |
| GET /admin/workshops, /admin/workshops/:id, /admin/workshops/:id/status-history; PATCH /admin/workshops/:id/status | Admin | Xem/đổi trạng thái, không sửa nội dung |
| GET/POST /artisan/products; GET/PUT/DELETE /artisan/products/:id; PATCH /artisan/products/:id/status | Artisan | Hộ mình, đúng trạng thái |
| GET/POST /admin/categories; PUT/DELETE /admin/categories/:id | Admin | Không xóa phân loại đang dùng |
| GET/POST /admin/news; GET/PUT/DELETE /admin/news/:id; PATCH /admin/news/:id/status | Admin | Vòng đời tin |
| GET/POST /artisan/batches; GET/PUT /artisan/batches/:id; GET/POST journal; PUT/DELETE journal/:entryId; POST publish tại mục 6/10.3 | Artisan | Lô/nhật ký hộ mình, kiểm tra chuỗi ID |
| GET /batches/:id/journal/:entryId/history và /:historyId | Artisan chủ/Admin | Xem lịch sử không cấp quyền sửa |
| POST /media/upload | Artisan; Admin chỉ khởi tạo hộ | Ngữ cảnh mục 8, Buyer bị từ chối |
| GET ba tuyến media mục 8.2 | Theo ngữ cảnh | Admin vẫn kiểm tra quan hệ ảnh, không đọc blob tùy ý |
| GET trading mục 9.3/10.4/10.5 | Theo từng dòng tương ứng | Lọc trường, bản ghi và tổng |
| POST/PUT/DELETE nháp; POST copy/send/close-bidding/request-split/accept-quote/confirm-delivery/cancel; PATCH contact dưới /buyer/quote-requests | Buyer chủ | Điều kiện từng action; không cấp Admin qua tiền tố |
| POST /artisan/quote-requests/:id/decline; POST /artisan/quote-requests/:id/quote; POST /artisan/quote-requests/:id/quote/withdraw | Artisan được mời | Phản hồi/báo giá mình; từ chối và rút được khi suspended, gửi/sửa báo giá cần active |
| POST /admin/quote-requests/:id/split-proposals | Admin | Đề xuất, không chấp nhận thay |
| POST /buyer/quote-requests/:id/split-proposals/:proposalId/accept hoặc /reject | Buyer chủ | Đúng yêu cầu, proposed, đủ version |
| POST start/handover; PUT batches dưới /artisan/allocations/:id | Artisan chủ | Không sửa phần hộ khác/sau hủy/bàn giao |
| POST /admin/allocations/:id/handover-by-admin | Admin | Đang sản xuất, bàn giao đủ, có lý do/căn cứ/thời gian |
| POST /admin/quote-requests/:id/confirm-delivery-by-admin hoặc /cancel-by-admin | Admin | Nhận thay khi mọi phần handed_over; hủy sau chốt trước Delivered |

## 13. Tình huống đối chiếu trước triển khai

| Tình huống | Kết quả cần bảo đảm |
|---|---|
| Admin nhìn phương án A v1, người khác thay bằng B v1 | Gửi ID A/version 1 trả 409, B còn nguyên; không chỉ so version |
| Tạo phương án với cặp null khi đã có proposed | 409, không thay phương án hiện tại |
| Hộ suspended từ chối lời mời chưa từng báo giá | 200 nếu còn mở; gửi báo giá vẫn bị từ chối |
| Admin đọc lô nháp và nhật ký hiện hành | 200 qua endpoint Admin; gọi endpoint sửa Artisan bị từ chối |
| Khởi tạo hộ từ ảnh đang upload/hết hạn/khác Admin | Lần lượt 409/422/404; không tạo nửa Account/Workshop |
| Tạo hộ thất bại sau bước chuyển quota | Rollback toàn bộ; quota/ảnh vẫn thuộc phạm vi cũ |
| Tạo hộ thành công và retry dùng lại khóa | Quota chỉ chuyển một lần; khóa attached không cấp hộ thứ hai |
| Upload khởi tạo song song, phạm vi hết hạn chưa dọn | Tổng quota tính cả reserved và tệp chưa dọn, không vượt 2 GiB/Admin |
| Gửi sai Content-Type; lỗi validation; lỗi ảnh | 415/400/lỗi tương ứng cùng application/problem+json, status trùng HTTP |
| Khách mở ứng dụng rồi login | Preauth + CSRF, login hủy preauth và cấp phiên/token mới; không đọc cookie HttpOnly bằng JS |
| Buyer upload/hộ dùng ảnh hộ khác | Từ chối quyền/ngữ cảnh, không gắn sai chủ hoặc tiêu quota hộ khác |
| URL current của ảnh chỉ còn trong lịch sử | 404; history chỉ Artisan chủ/Admin, không Buyer có Allocation |
| Nháp thiếu địa chỉ/hạn rồi gửi | Lưu được, gửi từ chối đến khi đủ/hợp lệ, không mất nháp |
| Buyer xem giá v1, hộ sửa v2, Buyer chấp nhận v1 | 409 CONCURRENCY_CONFLICT, không tạo phần việc |
| Retry đã commit sau khi version đổi | Cùng key/payload trả kết quả cũ/current_state, không thêm log/phần việc; khác payload 409 |
| Chấp nhận đua với rút/tạm ngừng/hủy | Chỉ kết quả hợp lệ theo thứ tự commit, không chốt dữ liệu hết hiệu lực |
| Hai hộ cập nhật tiến độ | Version phần việc riêng, kiểm tra trạng thái yêu cầu nguyên tử |
| Admin bàn giao not_started | 422 INVALID_STATE, không tự bắt đầu sản xuất |
| Phương án expired/Buyer từ chối | Giữ lịch sử/lý do, hàng chờ cần lập lại/thiếu khả năng, không tự hồi sinh |
| Hộ suspended, QR published | QR vẫn đọc, chỉ tên xưởng, không hồ sơ bị ẩn |
| Xóa nháp đua với gửi | Gửi trước không xóa, xóa trước không gửi, không mồ côi dữ liệu |
| Upload sát quota đồng thời/worker lỗi | Giữ chỗ nguyên tử, lỗi đúng mã, dọn xong mới giải phóng, giữ ảnh lịch sử |

Tài liệu đặc tả API cho phạm vi đã chốt, không thay thế nghiệp vụ/bảo mật/thiết kế dữ liệu. Thay đổi hợp đồng phải đối chiếu các tài liệu liên quan. Các tình huống trên là yêu cầu kiểm chứng, chưa khẳng định backend/frontend đã được cài đặt hoặc kiểm thử.
