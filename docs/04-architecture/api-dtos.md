# Hợp đồng DTO — vCraft Bát Tràng

Đi kèm [thiết kế API](api-design.md). Các quy tắc lọc dữ liệu theo vai trò áp dụng trước khi tạo response.

## 1. Kiểu dữ liệu và sự hiện diện của trường

Các bảng bên dưới là schema: trường được liệt kê luôn có mặt, trừ biến thể theo vai trò ghi rõ phải bỏ trường. `nullable` nghĩa là có mặt nhưng được null; không dùng chuỗi rỗng thay null. Mảng luôn có mặt, không có phần tử thì trả `[]`. Không tự trả trường ngoài danh sách.

| Nhóm trường | Kiểu JSON và ràng buộc |
|---|---|
| id, các trường kết thúc _id, ID trong object liên quan | string số thập phân dương, regex `^[1-9][0-9]*$`; tối đa 9223372036854775807. Ngoại lệ: tracking_id, initial_workshop_key dùng UUID |
| version, các trường kết thúc _version | integer 1–2147483647; request chỉ cho null ở các vị trí được ghi rõ |
| price, unit_price | integer VND 1–999999999999999; nằm trong miền số nguyên an toàn của JavaScript |
| total_amount, line_total | string số nguyên VND không âm, regex `^(0\|[1-9][0-9]*)$`; tính bằng decimal/integer, không qua số thực |
| quantity, max_quantity, allocated_quantity, linked_quantity, required_quantity | integer 1–2147483647; quantity trong nháp được null |
| eligible_capacity | string số nguyên không âm; tổng khả năng có thể vượt int32, không ép về quantity |
| page, limit, total_pages | integer; page ≥1, limit 1–100; total_pages bằng 0 nếu danh sách rỗng |
| total_records, eligible_quote_count, waiting_seconds | integer không âm, trong miền số nguyên an toàn |
| latitude, longitude | number hoặc null; hai tọa độ cùng null hoặc cùng hợp lệ |
| Trường kết thúc _at, _deadline; expires_at | string ISO 8601 UTC; null chỉ khi schema ghi nullable |
| is_*, accepting_visitors, no_valid_quotes, admin_handed_over, replayed | boolean; không trả 0/1 hoặc chuỗi |
| *_url | string URL tương đối bắt đầu `/api/v1/` cho API ảnh/trace, hoặc đường dẫn trang cùng origin cho profile; nullable theo schema. Không trả storage key |
| Actor | object `{id: Id, display_name: string \| null}`; trường actor nullable chỉ khi ghi rõ; không nhúng username/role |
| Các trường còn lại chứa tên, nội dung, lý do, mã | string, trừ object/mảng/enum được định nghĩa rõ bên dưới; không suy ra object từ entity |

`started_by`, `handed_over_by`, `rejected_by`, `edited_by`, `performed_by`, `actor` là Actor, không phải ID trần. `rejected_by` nullable; `admin_handover_reason`, `admin_delivery_evidence`, `admin_handover_actual_at` đều nullable khi không bàn giao thay. `reason` và `evidence` trong delivery_confirmation nullable khi Buyer xác nhận trực tiếp, bắt buộc có nội dung khi Admin xác nhận thay.

| Trường/DTO | Giá trị enum |
|---|---|
| Account.role | buyer / artisan / admin |
| Workshop.status | active / suspended |
| Product.status | draft / published / hidden |
| Batch.status, News.status | draft / published |
| News.post_type | material / power_schedule / support_policy / announcement |
| Request.status | Draft Request / Sent to Artisans / Artisans Bidding / Buyer Accepted / In Production / Delivered |
| Request.unit | piece / set; nullable với nháp |
| Request.delivery_mode | at_workshop / at_buyer_address; nullable với nháp |
| Recipient.response_status | pending / declined / quoted / withdrawn |
| Quote.status | active / withdrawn / accepted |
| SplitProposal.status | proposed / accepted / expired |
| SplitProposal.expire_reason | quote_changed / quote_withdrawn / quote_expired / workshop_suspended / replaced / buyer_rejected / request_accepted / request_cancelled; nullable khi chưa expired |
| Allocation.status | not_started / in_production / handed_over |
| Image context_type | workshop_profile / certificate / product / journal_entry |

Request DTO tuân theo từng endpoint trong [thiết kế API](api-design.md). Trường không đánh dấu tùy chọn phải có mặt; tùy chọn không đồng nghĩa nullable. Từ chối trường không khai báo bằng 400 INVALID_INPUT để tránh mass assignment. POST dùng mặc định được ghi rõ, PUT thay toàn bộ tập trường cho phép, PATCH chỉ sửa các trường được khai báo; không có PATCH tùy ý entity.

```typescript
type Id = string; // Theo miền ID ở bảng trên.
type Instant = string; // ISO 8601 UTC.
type Version = number; // Số nguyên dương.
type ProposalExpectation =
  | { expected_proposal_id: null; expected_proposal_version: null }
  | { expected_proposal_id: Id; expected_proposal_version: Version };
type CreateSplitProposalRequestDto = ProposalExpectation & {
  expected_request_version: Version;
  items: Array<{
    workshop_id: Id;
    quote_id: Id;
    expected_quote_version: Version;
    allocated_quantity: number;
  }>;
};
type InitialWorkshopUploadScopeDto = {
  initial_workshop_key: string; // UUID v4, server cấp.
  expires_at: Instant;
};
type ProblemDto = {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string; // Danh mục mã lỗi tại API mục 2.
  tracking_id: string; // UUID.
  errors?: Array<{ field: string; message: string }>; // Chỉ lỗi validation; field là JSON Pointer.
};
type PaginationDto = {
  page: number; limit: number; total_records: number; total_pages: number;
};
type SuccessDto<T> = { success: true; data: T };
type PageDto<T> = SuccessDto<T[]> & { pagination: PaginationDto };
```

## 2. DTO phản hồi và bộ lọc trường

### 2.1. DTO chung

Các ví dụ JSON trong tài liệu endpoint chỉ minh họa; trường đầy đủ theo DTO dưới đây. Giới hạn đầu vào chung theo mục 1.4 của thiết kế API. Metadata suy ra như is_profile_public/eligibility/coordination_state không phải cột DB bắt buộc. Object liên quan chỉ chứa trường nêu rõ, không tự nhúng tài khoản/dữ liệu riêng tư.

| DTO | Trường trả về |
|---|---|
| AccountSummaryDto | id, username, display_name nullable, role, workshop_id nullable; không mật khẩu/hash/token |
| ImageDto | id, thumbnail_url, display_url đúng ngữ cảnh |
| CategoryDto | id, name, is_active |
| PublicWorkshopSummaryDto | id, name, address, avatar_url nullable, latitude/longitude nullable, accepting_visitors; dùng cho GET /workshops |
| PublicWorkshopDto | id, name, story, address, latitude/longitude nullable, accepting_visitors, avatar_url nullable, images: ImageDto[], certificates: {id,name,image: ImageDto}[] |
| OwnWorkshopDto | Các trường PublicWorkshopDto, nhưng story/address được null khi chưa hoàn thiện; thêm status, is_profile_public, missing_public_fields: string[], created_at, updated_at; ảnh riêng tư theo ngữ cảnh |
| AdminWorkshopDto | OwnWorkshopDto + account: AccountSummaryDto; không có quyền sửa nội dung tương ứng |
| WorkshopStatusEventDto | id, prev_status, new_status, actor: {id,display_name}, reason, created_at |
| PublicProductDto | id, name, price, description nullable, category: {id,name}, workshop: {id,name}, images: ImageDto[], batch: {id,name,trace_url}; list dùng thumbnail_url thay images và bỏ description/batch |
| OwnProductDto | PublicProductDto + status, published_at nullable, created_at, updated_at; batch.trace_url nullable nếu draft |
| BatchDto | id, name, status, qr_token, trace_url nullable, published_at nullable, created_at, updated_at; nhật ký lấy riêng có phân trang |
| AdminBatchDto | BatchDto + workshop: {id,name}; chỉ đọc |
| JournalEntryDto | id, batch_id, stage, performed_at, notes nullable, images: ImageDto[], created_at, updated_at |
| JournalHistoryDto | id, journal_entry_id, prev_stage, prev_performed_at, prev_notes nullable, images: ImageDto[] qua history URL, edited_by: {id,display_name}, edited_at |
| NewsDto | id, title, content, post_type, status, published_at nullable, created_at, updated_at; public list bỏ content; created_by/updated_by chỉ Admin |

Public trace: batch_name, published_at, updated_at (cập nhật hiện hành gần nhất), workshop `{ name, is_profile_available, profile_url }`, journal_entries theo JournalEntryDto công khai, journal_pagination, disclaimer. profile_url null khi hồ sơ không công khai; suspended không trả ID/tọa độ/địa chỉ hồ sơ bị ẩn. Không Buyer/giá báo/lịch sử sửa/đơn mua sỉ. Ảnh lấy theo journal_entry hiện hành.

### 2.2. Request theo vai trò

- **RequestBaseDto:** id, status (sáu giá trị data-design), version, category `{id,name}` nullable với nháp, spec, quantity, unit, unit_set_description, delivery_mode, delivery_region, bidding_deadline, delivery_deadline (nghiệp vụ nullable với nháp), bidding_closed_at nullable, is_bidding_open, cancelled_at nullable, created_at, updated_at. is_bidding_open tính theo thời gian server/trạng thái, không chỉ bidding_closed_at.
- **BuyerRequestDto/AdminRequestDto:** RequestBaseDto + recipient_name/phone/delivery_address nullable với nháp, cancel_reason nullable, split_requested_at nullable, coordination_state, no_valid_quotes, nearest_accept_deadline nullable, delivery_confirmation nullable `{ performed_by: {id,display_name}, performed_at, is_admin_action, reason, evidence }`. no_valid_quotes true khi Artisans Bidding chưa chốt/hủy và không còn báo giá đủ điều kiện; UI hiển thị “Không còn báo giá hợp lệ”.
- **BuyerRequestSummaryDto:** id, status, version, category, quantity, unit, bidding_deadline, delivery_deadline, is_bidding_open, cancelled_at, split_requested_at, coordination_state, no_valid_quotes, nearest_accept_deadline, created_at; không nhúng địa chỉ/liên hệ trên danh sách.
- **InvitedRequestDto:** RequestBaseDto + own_recipient: RecipientDto của mình, own_quote: QuoteDto hoặc null. Không buyer_id/tên Buyer/liên hệ/địa chỉ chi tiết/phản hồi hoặc báo giá hộ khác/thông tin hàng chờ tổng hợp. Có Allocation thì thêm recipient_name/phone/delivery_address và own_allocation_id; giữ quyền liên hệ sau hoàn tất/hủy. Không mở báo giá đối thủ sau chốt.

ineligible_reasons/eligibility_labels dùng mã `QUOTE_WITHDRAWN`, `QUOTE_EXPIRED`, `WORKSHOP_SUSPENDED`, `REQUEST_CANCELLED`, `REQUEST_ACCEPTED` theo tình huống; traceability_warning là null hoặc `NO_BATCH_LINK`, `INCOMPLETE_TRACEABILITY`. decision_deadline của phương án là hạn chấp nhận sớm nhất của các báo giá trong bản đề xuất.

coordination_state null khi chưa nhờ chia hoặc đã chốt/hủy; còn lại awaiting_admin, needs_revision, awaiting_buyer, insufficient_capacity. Là nhãn suy ra, không thêm trạng thái chính. Không trả lý do điều phối/phản hồi của hộ khác qua DTO lời mời.

### 2.3. Báo giá, phương án, tiến độ và lịch sử

| DTO | Trường trả về |
|---|---|
| RecipientDto | id, request_id, workshop: {id,name}, response_status, version, sent_at, responded_at nullable, decline_reason nullable, eligibility_labels: string[]; hết hạn/hộ suspended là nhãn riêng |
| QuoteDto | id, request_id, workshop: {id,name}, unit_price, max_quantity, bid_accept_deadline, committed_delivery_at, status, version, withdraw_reason nullable, withdrawn_at nullable, is_eligible, ineligible_reasons: string[], created_at, updated_at |
| QuoteMutationDto | quote: QuoteDto, recipient: RecipientDto; không báo giá hộ khác |
| SplitProposalDto | id, request_id, status, version, created_at, decision_deadline, expired_at nullable, expire_reason nullable, rejected_by nullable, rejected_at nullable, reject_reason nullable, items: {workshop_id,workshop_name,quote_id,quote_version,quantity,unit_price,committed_delivery_at,line_total}[], total_amount; ghi rõ vận chuyển thỏa thuận ngoài hệ thống |
| SplitQueueItemDto | request_id, request_version, split_requested_at, waiting_seconds, coordination_state, revision_reason nullable, nearest_accept_deadline nullable, eligible_quote_count, eligible_capacity, required_quantity |
| AllocationDto | id, request_id, workshop: {id,name}, quote_id, quantity, unit_price, committed_delivery_at, status (not_started/in_production/handed_over), version, started_at/by nullable, handed_over_at/by nullable, delivery_note nullable, admin_handed_over, admin_handover_reason, admin_delivery_evidence, admin_handover_actual_at (nullable), traceability_warning nullable; actor là {id,display_name} |
| AllocationBatchDto | batch_id, batch_name, linked_quantity, is_trace_public, trace_url nullable, linked_at; không nội dung nhật ký nháp cho Buyer |
| RequestEventDto/AllocationEventDto | id, event_type, prev_status nullable, new_status, performed_by nullable {id,display_name}, created_at, is_admin_action, note nullable, evidence nullable; Admin thay luôn có actor/reason/evidence |
| ContactEventDto | id, prev_recipient_name/phone, new_recipient_name/phone, edited_by: {id,display_name}, edited_at, version |
| RecipientEventDto | id, event_type, prev_status, new_status, reason nullable, quote_snapshot nullable, performed_by: {id,display_name}, created_at; theo quyền phản hồi/báo giá tương ứng |

SplitProposalDto lấy giá/ngày giao đã đề xuất qua quote_version và lịch sử báo giá; không lấy Quote mới sửa để thể hiện như phương án cũ thay đổi. Giá/lượng/ngày giao Allocation bất biến. Admin bàn giao thay và nhận đủ thay là hai sự kiện riêng.

`quote_snapshot` là null trước khi có báo giá; còn lại gồm `unit_price`, `max_quantity`, `bid_accept_deadline`, `committed_delivery_at`, `status`, `version`, theo kiểu của QuoteDto. Không trả JSONB nguyên bản ngoài allowlist này. `prev_status`/`new_status` của từng lịch sử dùng enum tương ứng của đối tượng, không dùng chung một enum cho yêu cầu và phần việc.

`AcceptanceDto` gồm `request_id`, `request_status`, `request_version`, `accepted_proposal_id` nullable và `allocations: AllocationDto[]`. `accepted_proposal_id` null khi chốt một báo giá trực tiếp.

Mutation trading có thêm object `operation` ngang cấp `success`/`data`: `id` là ID IdempotencyRecord, `replayed` boolean, `committed_at` Instant và `current_state` object. current_state gồm `request: {id,status,version,cancelled_at}` và các trường `recipient`, `quote`, `proposal`, `allocation` chỉ khi thao tác liên quan đến đối tượng đó; mỗi trường này là `{id,status,version}` hoặc null nếu không còn tồn tại. Recipient dùng response_status làm status tại đây. Chỉ trả dữ liệu người gọi còn được đọc. Bản replay giữ data của lần commit và cập nhật current_state; không dùng data cũ làm trạng thái hiện hành. DELETE 204 không có operation/body.
