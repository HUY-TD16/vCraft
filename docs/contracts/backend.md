# Hợp đồng giữa các module

Tên operation dưới đây là chữ ký public contract đã chốt cho bước triển khai. Provider đặt interface và DTO thuần TypeScript trong `modules/<provider>/public/`, export DI token rõ ràng. Adapter triển khai thuộc provider. Consumer chỉ import public contract.

Source có sáu interface IIdentityContract, IWorkshopContract, ICatalogContract, ITraceabilityContract, IMediaContract và ITradingContract. Community có hợp đồng HTTP trong catalogue, hiện chưa có consumer backend cần public service. DatabaseModule cung cấp TRANSACTION_RUNNER qua PrismaTransactionRunner để triển khai workflow và integration test.

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

Mỗi provider duy trì mock public contract dùng chung tại backend/tests/support/mocks/. Consumer tạo instance mới cho mỗi test. Các method là Vitest mock có kiểu theo interface, hỗ trợ mockResolvedValue, mockRejectedValue và mockImplementation. Method chưa được cấu hình ném lỗi rõ ràng. mock.calls và mock.invocationCallOrder phục vụ kiểm tra input, thứ tự gọi và tx identity. Tính đúng của khóa và rollback được kiểm chứng riêng bằng PostgreSQL.

MockWorkshopContract có givenActiveWorkshops(...ids) và givenSuspended(...ids) cho lockAndAssertActive. Sau khi cấu hình, ID chưa được khai báo trả RESOURCE_NOT_FOUND. Các method khác vẫn cần cấu hình riêng. MockCatalogContract có givenEligibleWorkshops(categoryId, ...ids), loại trùng và sắp ID theo giá trị bigint; category chưa cấu hình báo lỗi thiết lập test. Dùng mockRejectedValue với BusinessRuleException để mô tả phân loại không hợp lệ. MockTransactionRunner tạo context mới cho mỗi run; các kiểm thử PostgreSQL dùng PrismaTransactionRunner để xác nhận commit/rollback.

workshopContractSuite tại tests/contracts/workshop.contract-suite.ts dùng chung cho mock và provider thật. Khi provider Workshops sẵn sàng, đăng ký suite với fixture PostgreSQL chứa hộ active, suspended và ID thiếu. Bổ sung suite cho các operation mới cùng lúc triển khai provider.

Tình huống ghép bắt buộc gồm cấp hộ thất bại sau chuyển quota, chốt đua với rút/tạm ngừng, hai phương án cùng version nhưng khác ID, cùng idempotency key khác payload, lịch sử ảnh có quyền khác ảnh current, và hủy đua với xác nhận nhận đủ.

## Quy ước exception

Domain/application ném BusinessRuleException từ common/domain/errors với code trong BusinessRuleCode, theo ma trận lỗi của operation. Ví dụ lockAndAssertActive ném new BusinessRuleException('WORKSHOP_SUSPENDED'). Promise bị reject làm lỗi thoát khỏi transaction. Consumer chỉ bắt lỗi khi thực sự xử lý được; lỗi cần rollback phải tiếp tục được ném.

ProblemDetailsFilter ánh xạ code sang HTTP qua statusByCode và trả thông báo công khai cố định. ApiProblem dùng ở tầng HTTP. Lỗi DB/hạ tầng giữ nguyên để runner nhận diện lỗi có thể retry và filter trả INTERNAL_SERVER_ERROR. Adapter chỉ chuyển lỗi DB thành BusinessRuleException khi xác định đúng vi phạm nghiệp vụ, chẳng hạn ràng buộc unique username; không chuyển mọi lỗi DB thành một lỗi nghiệp vụ chung.

Với operation quy định rõ dịch vụ không khả dụng, dùng ServiceUnavailableException thuần TypeScript tại common/application/errors. Ba mã được hỗ trợ là SECURITY_SERVICE_UNAVAILABLE, STORAGE_CAPACITY_LOW và IMAGE_PROCESSING_UNAVAILABLE, đều ánh xạ HTTP 503. Ví dụ resolveSession gặp kho phiên không khả dụng phải ném SECURITY_SERVICE_UNAVAILABLE; không trả null như trường hợp không có phiên.

## Sử dụng transaction

Workflow inject TRANSACTION_RUNNER với kiểu TransactionRunner từ common/application/ports. Adapter database inject PrismaTransactionRunner và gọi getClient(tx) trước thao tác Prisma. Prisma client chỉ xuất hiện trong infrastructure/adapters. Context hợp lệ phải thuộc runner đang dùng, còn trong callback và đúng luồng bất đồng bộ hiện tại. Context hết hạn, giả hoặc dùng từ transaction khác bị từ chối. Mọi công việc trong callback phải được await.

Runner dùng interactive transaction, tối đa ba lần thử. Chỉ retry P2034 hoặc lỗi raw-query P2010 có SQLSTATE 40001/40P01. Mỗi lần thử tạo context mới và chạy lại toàn bộ callback. Lỗi nghiệp vụ, unique conflict và lỗi khác được ném ngay. Transaction lồng bị từ chối; operation con nhận tx hiện tại.

Giới hạn hiện tại là chờ lấy transaction tối đa 2 giây và chạy mỗi lần tối đa 5 giây; retry chờ 25 rồi 50 ms. Đây là giới hạn mỗi lần thử. HTTP timeout không tự hủy callback hoặc transaction đang chạy, nên workflow cần idempotency theo đặc tả. Các lời gọi mạng, băm mật khẩu, xử lý ảnh và tác dụng phụ ngoài DB phải nằm ngoài callback có thể retry.

## Đăng ký module và DI

IdentityModule, WorkshopsModule, CatalogModule, TraceabilityModule, MediaModule và TradingModule có register(implementation, dependencies). implementation phải triển khai đúng public interface. dependencies nhận imports, providers và controllers nội bộ. Module tự import DatabaseModule, đăng ký implementation một lần và dùng useExisting để export contract token cùng instance.

Ví dụ khi WorkshopService đã triển khai IWorkshopContract:

```typescript
const workshopsModule = WorkshopsModule.register(WorkshopService, {
  providers: [WorkshopRepository],
  controllers: [WorkshopController],
});

@Module({
  imports: [DatabaseModule, workshopsModule],
  providers: [AcceptQuotationWorkflow],
})
export class TradingWorkflowsModule {}
```

Consumer inject WORKSHOP_CONTRACT với kiểu IWorkshopContract. Module workflow import module provider đã đăng ký; AppModule import module workflow. Tái sử dụng cùng cấu hình đăng ký provider trong composition root. Service cần provider từ module khác thì truyền module đó qua dependencies.imports. Dùng workflow để điều phối các thao tác ghi liên module và hạn chế phụ thuộc vòng.

AppModule hiện chỉ nối DatabaseModule vì các service nghiệp vụ chưa triển khai. Khi ghép, truyền class thật vào register. Mock chỉ được đăng ký trong test.
