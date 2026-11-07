# Hợp đồng giữa các module

Tên operation dưới đây là chữ ký public contract đã chốt cho bước triển khai. Provider đặt interface và DTO thuần TypeScript trong `modules/<provider>/public/`, export DI token rõ ràng. Adapter triển khai thuộc provider. Consumer chỉ import public contract.

Source đã có sáu interface IIdentityContract, IWorkshopContract, ICatalogContract, ITraceabilityContract, IMediaContract và ITradingContract. Community có hợp đồng HTTP trong catalogue, hiện chưa có consumer backend cần public service. TransactionRunner ở bước này là port để người C viết workflow và mock; adapter transaction được nối khi triển khai workflow đầu tiên.

`Id` là chuỗi số dương trong miền bigint. `Instant` là ISO UTC, `Version` là số nguyên dương. `Actor` lấy từ phiên đã xác thực, gồm accountId, role, workshopId nullable, authVersion, sessionId. Trường actor, owner và thời gian hệ thống do server cung cấp.

`tx` bắt buộc với operation ghi hoặc kiểm tra phục vụ ghi. Đây là `TransactionContext` opaque ở `common/application/ports`. Provider không giải context thành Prisma ở tầng public/application. `TransactionRunner.run(work)` bao toàn bộ workflow. Adapter từ chối context hết hạn hoặc không thuộc transaction, báo lỗi hạ tầng để rollback.

## Ma trận provider và consumer

Các cấu trúc trong cột vào/ra mô tả đầy đủ dữ liệu trao đổi cần thiết cho operation. Lỗi nghiệp vụ dùng mã ở API mục 2; lỗi hạ tầng ánh xạ INTERNAL_SERVER_ERROR và không để lộ SQL.

| Provider → consumer | Operation và đầu vào | Đầu ra | Lỗi và điều kiện |
|---|---|---|---|
| Identity → cửa ngõ HTTP | resolveSession(sessionToken) | Actor + sessionLevel normal/temp_password hoặc null | SESSION_EXPIRED; SECURITY_SERVICE_UNAVAILABLE khi kho xác thực lỗi. Token chỉ tồn tại tại biên xác thực, không log |
| Identity → workflow cấp hộ | createArtisan({username, passwordHash, tempPasswordExpiresAt, actor}, tx) | {accountId, username} | USERNAME_TAKEN, PERMISSION_DENIED. Băm mật khẩu trước transaction; ghi audit trong transaction |
| Identity → workflow khởi tạo/cấp hộ, reset | lockAndAssertAdmin(actor, tx) | void | AUTHENTICATION_REQUIRED, SESSION_EXPIRED, PERMISSION_DENIED. Khóa Account và kiểm tra lại authVersion/phiên |
| Workshops → Catalog, Trading, workflow | lockAndAssertActive(workshopIds, tx) | void | RESOURCE_NOT_FOUND, WORKSHOP_SUSPENDED. Khóa ID tăng dần và kiểm tra trạng thái hiện tại |
| Workshops → trang tổng hợp/QR | getWorkshopSummary(workshopId) | {id, name, status, isProfilePublic} hoặc null | RESOURCE_NOT_FOUND tại consumer khi cần. Dữ liệu đọc không thay kiểm tra dưới khóa |
| Workshops → workflow cấp hộ | createWorkshop({accountId, name, address, story, latitude, longitude, actor}, tx) | {workshopId} | INVALID_INPUT, PERMISSION_DENIED. Nullable theo hồ sơ ban đầu; account phải Artisan |
| Workshops → workflow đổi trạng thái | changeStatus({workshopId, status, reason, actor}, tx) | {workshopId, status, changed} | RESOURCE_NOT_FOUND, PERMISSION_DENIED, INVALID_INPUT. Log cùng giao dịch khi thực sự đổi |
| Catalog → Trading gửi yêu cầu | findEligibleWorkshopIds({categoryId}, tx) | Id[] duy nhất, tăng dần | RESOURCE_NOT_FOUND/INVALID_STATE nếu phân loại không dùng được. Trả [] nếu không có hộ active có sản phẩm published đúng phân loại; Trading trả NO_ELIGIBLE_WORKSHOP |
| Catalog → Trading gửi yêu cầu | assertEligibleWorkshops({categoryId, workshopIds}, tx) | void | NO_ELIGIBLE_WORKSHOP, INVALID_STATE. Kiểm tra lại sau khóa; kết quả đọc trước khóa chỉ để biết tập hộ |
| Catalog → Media đọc ảnh | getProductImageAccess({productId, imageId, actorOrNull}, tx) | {canRead: boolean} | Không tồn tại/không đúng quan hệ trả false. Admin không tự có quyền xem sản phẩm riêng tư |
| Traceability → Catalog lưu/công bố sản phẩm | assertBatch({batchId, workshopId, requirePublished}, tx) | {id, workshopId, status} | RESOURCE_NOT_FOUND nếu sai hộ/không tồn tại; INVALID_STATE nếu cần published mà còn draft |
| Traceability → Trading liên kết lô | assertOwnedBatches({batchIds, workshopId}, tx) | {id, name, status, traceUrl: string hoặc null}[] | RESOURCE_NOT_FOUND nếu thiếu/sai hộ. Cho phép draft; không suy luận tồn kho |
| Traceability → Media đọc ảnh | getJournalImageAccess({entryId, imageId, historyId: Id hoặc null, actorOrNull}, tx) | {canRead: boolean} | Lịch sử cần đúng quan hệ history-entry-image và Artisan chủ/Admin; ảnh hiện hành published công khai dù hộ suspended |
| Workshops → Media đọc ảnh | getProfileImageAccess({workshopId, imageId, certificateId: Id hoặc null, actorOrNull}, tx) | {canRead: boolean} | Phải đúng quan hệ ảnh/hồ sơ/chứng nhận; hồ sơ chưa công khai chỉ theo quyền riêng tư |
| Media → Workshops, Catalog, Traceability | replaceImages({contextType, contextId, workshopId, imageIds, actor}, tx) | void | IMAGE_CONTEXT_MISMATCH, RESOURCE_NOT_FOUND, INVALID_INPUT. Ảnh phải ready, đúng chủ; kiểm tra giới hạn theo đối tượng, gỡ tham chiếu giữ chủ cố định |
| Media → Traceability sửa nhật ký | retainHistoryImages({historyId, entryId, imageIds}, tx) | void | IMAGE_CONTEXT_MISMATCH, RESOURCE_NOT_FOUND. Ghi JournalHistoryImage trước đổi nội dung/ảnh hiện hành |
| Media → workflow cấp hộ | attachInitialWorkshopScope({initialWorkshopKey, workshopId, imageIds, actor}, tx) | void | RESOURCE_NOT_FOUND nếu khác Admin; UPLOAD_SCOPE_UNAVAILABLE nếu hết hạn/đã dùng; UPLOAD_SCOPE_BUSY nếu đang có reservation. Chuyển cùng dòng quota và gắn ảnh nguyên tử |
| Media → mọi màn hình ảnh | getImageDto({imageId, contextType, contextId, historyId: Id hoặc null, actorOrNull}, tx) | ImageDto hoặc null | Sai quyền/quan hệ trả null để HTTP trả RESOURCE_NOT_FOUND. URL đi qua cổng media, không trả storage key |
| Trading → workflow tạm ngừng hộ | expireProposalsForWorkshop({workshopId, actor}, tx) | void | Khóa yêu cầu theo ID rồi phương án; expired với workshop_suspended. Giữ phần việc đã chốt |
| Trading → workflow chốt | findAcceptanceReplay({requestId, lựa chọn và version, actor, idempotencyKey}, tx) | {data: AcceptanceDto, operation} hoặc null | Kiểm tra quyền hiện hành rồi tra key/fingerprint; IDEMPOTENCY_CONFLICT nếu khác payload. Replay có current_state đã lọc quyền; trả trước kiểm tra version hiện tại |
| Trading → workflow chốt | prepareAcceptance({requestId, quoteId hoặc proposalId, expectedRequestVersion, expectedQuoteVersion hoặc expectedProposalVersion, actor}, tx) | {workshopIds: Id[]} | RESOURCE_NOT_FOUND, CONCURRENCY_CONFLICT, INVALID_STATE. Đọc xác định tập hộ; chưa ghi/khóa theo thứ tự ngược |
| Trading → workflow chốt | accept({requestId, lựa chọn và version như trên, actor, idempotencyKey}, tx) | AcceptanceDto + operation | QUOTE_EXPIRED, WORKSHOP_SUSPENDED, CONCURRENCY_CONFLICT, IDEMPOTENCY_CONFLICT, INVALID_STATE, INSUFFICIENT_CAPACITY. Đọc lại tập hộ/version sau khóa, ghi toàn bộ phần việc/log/key cùng transaction |
| Community → frontend | HTTP news theo catalogue frontend | NewsDto, PageDto hoặc 204 | RESOURCE_NOT_FOUND, INVALID_INPUT, PERMISSION_DENIED, INVALID_STATE. Module sở hữu nội dung tin, không có dependency ghi liên module |

Các operation đọc quyền ảnh chỉ trả quyết định theo đúng đối tượng đang tham chiếu. Media tự quản lý trạng thái tệp, quota và byte ảnh. Các public contract trả quyết định quyền phải dùng cùng snapshot/transaction với bước xác nhận ảnh được phục vụ.

## Workflow và thứ tự giao dịch

| Workflow, người điều phối | Trình tự và kết quả nguyên tử |
|---|---|
| Cấp Artisan, C điều phối A+B | Xác thực Admin và băm mật khẩu ngoài khóa → mở tx → khóa Account Admin → kiểm tra scope/quota theo thứ tự kho, Account, scope, quota → Identity tạo Account → Workshops tạo Workshop → Media chuyển quota/gắn ảnh → audit → commit. Mật khẩu tạm chỉ phản hồi một lần sau commit |
| Tạm ngừng hộ, C điều phối A | Khóa Workshop → Workshops đổi status/log → Trading khóa các yêu cầu liên quan theo ID và expire proposed → commit. Hoạt động lại không hồi sinh phương án hoặc thêm lời mời cũ |
| Gửi yêu cầu, C+B+A | Đọc tập hộ qua Catalog → khóa Workshop tăng dần → khóa QuoteRequest → kiểm tra version, dữ liệu, hạn và Catalog eligibility lại → tạo toàn bộ RequestRecipient và chuyển trạng thái/log. Tập hộ thay đổi thì đọc lại trong lần thử mới |
| Chốt trực tiếp/chia, C+A | Kiểm tra phiên/quyền → findAcceptanceReplay (có kết quả thì trả) → prepareAcceptance đọc tập hộ → Workshop khóa tăng dần → khóa QuoteRequest → khóa Quote/Proposal/Allocation theo thứ tự cố định → kiểm tra lại → accept → commit. Replay đúng payload trả kết quả cũ + current_state đã lọc quyền |
| Liên kết lô, C+B | Khóa QuoteRequest → Allocation → kiểm tra version và Traceability cùng tx → thay danh sách liên kết/log/version. Tổng không vượt quantity; draft gây cảnh báo, không cấm bàn giao |
| Sửa nhật ký published, B | Khóa JournalEntry và chủ/quota liên quan → ghi nội dung cũ + Media giữ ảnh lịch sử → đổi nội dung + ảnh hiện hành → commit. Không dọn ảnh lịch sử |

Phần việc ghi chỉ gọi hợp đồng trong cùng tx, lỗi phải thoát transaction. Retry deadlock/serialization có giới hạn ở TransactionRunner; mỗi lần đọc lại điều kiện. Xung đột version trả cho người dùng. Hash, xử lý ảnh, mạng và gửi phản hồi thực hiện ngoài vùng khóa.

## Quy ước mock backend

Mỗi provider bàn giao mock public contract trong tests của consumer. Mock trả đúng các cấu trúc ở bảng, có trường hợp null, thiếu quyền và lỗi đã liệt kê. Mock có thể ghi nhận thứ tự gọi/tx identity để kiểm tra workflow truyền cùng context. Tính đúng của khóa và rollback được kiểm chứng riêng bằng PostgreSQL.

Tình huống ghép bắt buộc gồm cấp hộ thất bại sau chuyển quota, chốt đua với rút/tạm ngừng, hai phương án cùng version nhưng khác ID, cùng idempotency key khác payload, lịch sử ảnh có quyền khác ảnh current, và hủy đua với xác nhận nhận đủ.
