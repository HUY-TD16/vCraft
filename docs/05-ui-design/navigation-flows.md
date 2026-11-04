# Sơ đồ điều hướng & Luồng người dùng — vCraft

Căn cứ: [danh mục màn hình](screen-inventory.md), [đặc tả use case](../02-specifications/use-cases.md), [quy tắc nghiệp vụ](../02-specifications/business-rules.md) và [bảo mật & phân quyền](../02-specifications/security-and-access-control.md).

Tài liệu này trực quan hóa cấu trúc điều hướng giữa các màn hình, các luồng hành trình người dùng (User Journeys) chính xác theo quy chuẩn nghiệp vụ của vCraft (Làng gốm Bát Tràng) bằng các biểu đồ Mermaid tiêu chuẩn.

---

## 1. Sơ đồ cấu trúc điều hướng tổng thể (Site Map)

```mermaid
graph TD
    classDef public fill:#f5f0eb,stroke:#8c6239,stroke-width:1.5px,color:#2c1810;
    classDef buyer fill:#e6f0fa,stroke:#2b5c8f,stroke-width:1.5px,color:#102a45;
    classDef artisan fill:#eaf5ea,stroke:#3b7a3b,stroke-width:1.5px,color:#133813;
    classDef admin fill:#fbeee6,stroke:#a04000,stroke-width:1.5px,color:#4a1e00;

    %% Public Portal
    Home["SCR-PUB-01: Trang chủ vCraft"]:::public
    Map["SCR-PUB-02: Bản đồ số Làng gốm"]:::public
    Catalog["SCR-PUB-05: Danh mục sản phẩm"]:::public
    ProdDetail["SCR-PUB-06: Chi tiết sản phẩm"]:::public
    Workshops["SCR-PUB-03: Khám phá xưởng"]:::public
    WorkshopDetail["SCR-PUB-04: Hồ sơ xưởng gốm"]:::public
    TraceQR["SCR-PUB-07: Truy xuất nguồn gốc QR"]:::public
    News["SCR-PUB-08: Tin tức cộng đồng"]:::public
    NewsDetail["SCR-PUB-09: Chi tiết bài viết"]:::public
    Login["SCR-AUTH-01: Đăng nhập (Username)"]:::public
    Register["SCR-AUTH-02: Đăng ký Buyer"]:::public
    ChangePass["SCR-AUTH-03: Đổi mật khẩu"]:::public

    Home --> Map
    Home --> Catalog
    Home --> Workshops
    Home --> News
    Home --> Login
    Home --> Register
    Catalog --> ProdDetail
    ProdDetail -.-> TraceQR
    Workshops --> WorkshopDetail
    WorkshopDetail -.-> Map
    News --> NewsDetail

    Login -->|Mật khẩu tạm / Lần đầu| ChangePass
    ChangePass -->|Đổi thành công: Hủy session| Login

    %% Buyer Portal
    BuyerReqs["SCR-BUY-01: Danh sách yêu cầu sỉ"]:::buyer
    NewReq["SCR-BUY-02: Soạn/Sửa yêu cầu báo giá"]:::buyer
    BiddingRoom["SCR-BUY-03: Chi tiết & Phòng Bidding"]:::buyer
    ProposalReview["SCR-BUY-04: Duyệt chia đơn BQL"]:::buyer
    Tracking["SCR-BUY-05: Tiến độ & Nhận hàng"]:::buyer

    Login -->|Vai trò: Buyer| BuyerReqs
    BuyerReqs --> NewReq
    BuyerReqs --> BiddingRoom
    BiddingRoom --> ProposalReview
    BiddingRoom --> Tracking
    Tracking -.-> TraceQR

    %% Artisan Portal
    ArtDashboard["SCR-ART-01: Tổng quan xưởng"]:::artisan
    ArtProfile["SCR-ART-02: Quản lý hồ sơ xưởng"]:::artisan
    ArtProducts["SCR-ART-03: Quản lý sản phẩm"]:::artisan
    ArtBatches["SCR-ART-04: Quản lý lô gốm"]:::artisan
    ArtStages["SCR-ART-05: Nhật ký công đoạn"]:::artisan
    ArtQR["SCR-ART-06: Thẻ QR Code lô"]:::artisan
    ArtInbox["SCR-ART-07: Yêu cầu chào giá đến"]:::artisan
    ArtQuote["SCR-ART-08: Soạn/Sửa/Rút báo giá"]:::artisan
    ArtAllocations["SCR-ART-09: Quản lý phần việc"]:::artisan

    Login -->|Vai trò: Artisan| ArtDashboard
    ArtDashboard --> ArtProfile
    ArtDashboard --> ArtProducts
    ArtDashboard --> ArtBatches
    ArtBatches --> ArtStages
    ArtStages --> ArtQR
    ArtDashboard --> ArtInbox
    ArtInbox --> ArtQuote
    ArtDashboard --> ArtAllocations
    ArtAllocations -.-> ArtBatches

    %% Admin Portal
    AdminDash["SCR-ADM-01: Bảng điều hành BQL"]:::admin
    AdminArtisans["SCR-ADM-02: Quản lý hộ gốm"]:::admin
    AdminCoord["SCR-ADM-03: Hàng chờ chia đơn"]:::admin
    AdminPlan["SCR-ADM-04: Lập phương án chia"]:::admin
    AdminDetail["SCR-ADM-05: Chi tiết & Xử lý ngoại lệ"]:::admin
    AdminCats["SCR-ADM-06: Quản lý phân loại"]:::admin
    AdminNews["SCR-ADM-07: Quản lý tin tức"]:::admin
    AdminAudit["SCR-ADM-08: Nhật ký kiểm toán"]:::admin

    Login -->|Vai trò: Admin| AdminDash
    AdminDash --> AdminArtisans
    AdminDash --> AdminCoord
    AdminCoord --> AdminPlan
    AdminCoord --> AdminDetail
    AdminDash --> AdminCats
    AdminDash --> AdminNews
    AdminDash --> AdminAudit
```

---

## 2. Các luồng hành trình người dùng cốt lõi (User Journey Flows)

### 2.1. Luồng 1: Khách tham quan & Truy xuất nguồn gốc QR (Tourist Flow)

```mermaid
flowchart TD
    Scan["Khách quét mã QR trên sản phẩm gốm Bát Tràng"] --> PublicQR["SCR-PUB-07: Landing Page Truy xuất nguồn gốc QR"]
    PublicQR --> ViewStory["Xem tên lô gốm, ngày công bố & mô tả quy trình"]
    PublicQR --> ViewTimeline["Xem dòng thời gian công đoạn: Chuẩn bị đất -> Tạo hình -> Phơi sấy -> Tráng men -> Nung lò"]
    PublicQR --> ViewImages["Xem ảnh hiện trường mộc tại từng mốc công đoạn"]
    PublicQR --> Disclaimer["Đọc ghi chú: 'Nội dung nhật ký do hộ sản xuất tự công bố và chịu trách nhiệm'"]
    
    PublicQR --> CheckWorkshop{"Hộ sản xuất có công khai<br>và đang hoạt động không?"}
    CheckWorkshop -- Có: Đang hoạt động --> ClickWorkshop["Có liên kết: Nhấn xem SCR-PUB-04: Hồ sơ xưởng gốm"]
    ClickWorkshop --> CheckOpen{"Xưởng có mở cửa<br>đón khách không?"}
    CheckOpen -- Có --> OpenMap["Xem vị trí trên SCR-PUB-02: Bản đồ làng nghề và đến trải nghiệm"]
    CheckOpen -- Không --> BrowseProducts["Duyệt bộ sưu tập sản phẩm khác của xưởng"]
    
    CheckWorkshop -- Không: Tạm ngừng / Ẩn --> WorkshopHidden["Chỉ hiển thị tên xưởng dạng văn bản thuần.<br>KHÔNG có liên kết dẫn sang hồ sơ xưởng bị ẩn (BR-04, BR-05)"]
```

---

### 2.2. Luồng 2: Quy trình mua sỉ B2B & Chấp nhận đơn (Buyer Procurement Flow)

Tuân thủ chính xác 6 trạng thái bắt buộc: `Draft Request` $\rightarrow$ `Sent to Artisans` $\rightarrow$ `Artisans Bidding` $\rightarrow$ `Buyer Accepted` $\rightarrow$ `In Production` $\rightarrow$ `Delivered`.

```mermaid
flowchart TD
    CreateReq["SCR-BUY-02: Soạn yêu cầu báo giá sỉ<br>(5.000 chiếc cốc, men trắng, in logo)"] --> SubmitReq["Bấm 'Gửi yêu cầu đến các hộ' (UC-15)"]
    SubmitReq --> BiddingRoom["SCR-BUY-03: Phòng Bidding & So sánh báo giá<br>(Trạng thái: Artisans Bidding)"]
    
    BiddingRoom --> WaitQuotes["Các hộ gửi báo giá<br>(Hiển thị: Đơn giá, SL, Ngày giao, Hạn chấp nhận)"]
    
    WaitQuotes --> Decision{"Lựa chọn của Buyer"}
    
    %% Nhánh 1: Chấp nhận trực tiếp
    Decision -- "1 hộ đáp ứng đủ 100% SL" --> DirectAccept["Buyer bấm 'Chấp nhận trực tiếp' hộ này (UC-19)"]
    DirectAccept --> SetAccepted1["Hệ thống chuyển trạng thái yêu cầu sang: Buyer Accepted<br>Tạo 01 phần việc ở trạng thái: Assigned"]
    
    %% Nhánh 2: Nhờ Ban quản lý chia đơn
    Decision -- "Muốn chia đơn cho nhiều hộ" --> CloseAndAsk["Buyer bấm: 'Đóng nhận sớm và nhờ BQL chia đơn' (UC-20)<br>(Gọi API Đóng nhận -> Gọi API Nhờ BQL chia đơn)"]
    CloseAndAsk --> BiddingClosed["Yêu cầu chuyển sang nhãn phụ: 'Bidding Closed'<br>Trạng thái chính vẫn là: Artisans Bidding"]
    BiddingClosed --> WaitForPlan["Chờ Ban quản lý Bát Tràng lập phương án chia đơn..."]
    WaitForPlan --> ReviewPlan["SCR-BUY-04: Màn hình Phê duyệt phương án BQL<br>(Nhãn phụ: 'Chờ Buyer quyết định phương án')"]
    ReviewPlan --> PlanDecision{"Buyer phê duyệt?"}
    
    PlanDecision -- "Từ chối (nhập lý do)" --> RejectPlan["Bấm 'Từ chối phương án' (UC-22)<br>Yêu cầu quay lại Bidding chờ giải pháp khác"]
    PlanDecision -- "Đồng ý" --> AcceptPlan["Bấm 'Chấp nhận phương án' (UC-22)"]
    AcceptPlan --> SetAccepted2["Hệ thống chuyển trạng thái yêu cầu sang: Buyer Accepted<br>Tạo các phần việc tương ứng ở trạng thái: Assigned"]
    
    %% Chuyển từ Buyer Accepted sang In Production
    SetAccepted1 --> WaitArtisanStart["Yêu cầu ở trạng thái: Buyer Accepted<br>(Chờ các hộ vào nhận việc và bắt đầu sản xuất)"]
    SetAccepted2 --> WaitArtisanStart
    
    WaitArtisanStart --> ArtisanStarts["Hộ đầu tiên bấm: 'Bắt đầu sản xuất' (UC-23)<br>(Phần việc của hộ chuyển sang In Production)"]
    ArtisanStarts --> SetInProd["Hệ thống chuyển trạng thái yêu cầu sang: In Production"]
    
    %% Giai đoạn hoàn tất
    SetInProd --> TrackFlow["SCR-BUY-05: Theo dõi tiến độ từng phần việc"]
    TrackFlow --> ArtisansDelivering["Từng hộ hoàn thành và bấm: 'Bàn giao phần việc' (UC-24)<br>(Từng phần việc chuyển sang Delivered)"]
    ArtisansDelivering --> AllDelivered{"Tất cả phần việc<br>đã bàn giao đủ?"}
    AllDelivered -- Chưa đủ --> TrackFlow
    AllDelivered -- Đã đủ 100% --> ConfirmReceipt["Buyer kiểm tra thực tế và bấm:<br>'Xác nhận nhận đủ hàng' (UC-25)"]
    ConfirmReceipt --> Completed["Yêu cầu chuyển sang: Delivered (Hoàn tất toàn bộ đơn hàng)"]
```

---

### 2.3. Luồng 3: Nghệ nhân tác nghiệp xưởng & Chào giá (Artisan Production & Bidding Flow)

```mermaid
flowchart TD
    ArtLogin["Artisan đăng nhập vào hệ thống"] --> CheckFirstLogin{"Đăng nhập bằng<br>mật khẩu tạm ban đầu?"}
    CheckFirstLogin -- Đúng --> ForceChangePass["Bắt buộc chuyển sang SCR-AUTH-03: Đổi mật khẩu lần đầu<br>(Đổi xong -> Hủy session -> Đăng nhập lại)"]
    ForceChangePass --> ArtLogin
    CheckFirstLogin -- Không --> ArtDash["SCR-ART-01: Tổng quan xưởng"]
    
    %% Đón khách
    ArtDash --> ToggleOpen["Bật/Tắt công tắc: 'Đón khách tham quan' (Cập nhật tức thì lên Bản đồ)"]
    
    %% Quản lý Lô (Kể cả hộ tạm ngừng vẫn được làm)
    ArtDash --> CreateBatch["SCR-ART-04: Tạo Lô sản xuất mới (BR-05)"]
    CreateBatch --> RecordStage["SCR-ART-05: Ghi nhật ký từng mốc (Thời điểm, mô tả mộc, ảnh hiện trường)"]
    RecordStage --> PublishBatch["Kiểm tra đủ mốc có ảnh -> Bấm 'Công bố Lô gốm' (UC-11)"]
    PublishBatch --> GetQR["SCR-ART-06: Hệ thống cấp mã QR ổn định -> Tải ảnh in dán lên đáy gốm"]
    
    %% Chào giá & Rút báo giá
    ArtDash --> CheckInbox["SCR-ART-07: Xem danh sách yêu cầu mua sỉ mới"]
    CheckInbox --> CheckSuspended{"Hộ có đang bị<br>tạm ngừng không?"}
    CheckSuspended -- Có: Tạm ngừng --> BlockQuote["Bị vô hiệu hóa nút gửi báo giá mới (BR-05)"]
    CheckSuspended -- Không: Hoạt động --> QuoteAction{"Hành động chào giá"}
    QuoteAction -- Từ chối --> RejectReq["Bấm 'Từ chối yêu cầu' (nhập lý do tùy chọn)"]
    QuoteAction -- Chào giá --> SendQuote["SCR-ART-08: Soạn báo giá (Đơn giá, SL, ngày giao, hạn chấp nhận) -> Gửi"]
    
    SendQuote --> ManageQuote["Quản lý báo giá đã gửi:"]
    ManageQuote --> EditQuote["Sửa báo giá (khi chưa đóng nhận và chưa chốt)"]
    ManageQuote --> WithdrawQuote["Rút báo giá (được rút kể cả khi đã đóng nhận hoặc hộ tạm ngừng)"]
    
    %% Phần việc trúng thầu
    SendQuote -.-> WinBid["Được Buyer chấp nhận giao việc (hoặc duyệt phương án chia đơn)"]
    WinBid --> ManageAlloc["SCR-ART-09: Quản lý phần việc (Trạng thái: Assigned)"]
    ManageAlloc --> StartProd["Bấm: 'BẮT ĐẦU SẢN XUẤT' (UC-23)<br>(Phần việc chuyển sang: In Production)"]
    StartProd --> LinkBatch["Liên kết một hoặc nhiều Lô sản xuất cùng số lượng"]
    LinkBatch --> DeliverJob["Sản xuất xong -> Bấm: 'BÀN GIAO PHẦN VIỆC' (UC-24)<br>(Cảnh báo nếu chưa gắn lô nhưng vẫn cho bàn giao)"]
    DeliverJob --> AllocDelivered["Phần việc chuyển sang: Delivered (Chờ Buyer nhận đủ)"]
```

---

### 2.4. Luồng 4: Ban quản lý điều phối chia đơn & Xử lý ngoại lệ (Admin Governance Flow)

```mermaid
flowchart TD
    AdminNotice["Nhận yêu cầu chia đơn từ Buyer"] --> CoordQueue["SCR-ADM-03: Hàng chờ điều phối chia đơn"]
    CoordQueue --> OpenPlan["SCR-ADM-04: Mở màn hình Lập phương án chia đơn"]
    OpenPlan --> ViewBids["Xem bảng tổng hợp tất cả báo giá hợp lệ của các hộ"]
    ViewBids --> InputAlloc["Nhập số lượng phân bổ cho từng hộ: Hộ A (2.000 chiếc), Hộ B (3.000 chiếc)"]
    InputAlloc --> ValidateTotal{"Kiểm tra số lượng:<br>Tổng hộ = 5.000?"}
    ValidateTotal -- Chưa khớp 100% --> FixNumbers["Điều chỉnh lại số lượng phân bổ"]
    FixNumbers --> ValidateTotal
    ValidateTotal -- Khớp đủ 100% --> SetPlanDeadline["Hệ thống tự tính tổng tiền, ngày giao muộn nhất & nhập hạn quyết định"]
    SetPlanDeadline --> SubmitPlan["Bấm 'Gửi phương án cho Buyer duyệt' (UC-21)<br>(Admin KHÔNG tự chốt việc, Buyer mới là người quyết định)"]
    SubmitPlan --> SetNotice["Yêu cầu giữ nguyên trạng thái Artisans Bidding<br>Gắn nhãn phụ: 'Chờ Buyer quyết định phương án'"]
    
    %% Luồng xử lý ngoại lệ
    AdminNotice -.-> ExceptionFlow["Phát sinh sự cố / Ngoại lệ điều phối (UC-24, UC-26, UC-27)"]
    ExceptionFlow --> OpenDetail["SCR-ADM-05: Chi tiết yêu cầu & phần việc"]
    OpenDetail --> ExceptionAction{"Hành động ngoại lệ"}
    ExceptionAction -- "Hộ không vào mạng được" --> AdminDeliver["Bấm 'Ghi nhận bàn giao thay hộ' (UC-24)"]
    ExceptionAction -- "Buyer không xác nhận" --> AdminConfirm["Bấm 'Xác nhận nhận đủ thay Buyer' (UC-26)"]
    ExceptionAction -- "Sự cố bất khả kháng sau chốt" --> AdminCancel["Bấm 'Hủy yêu cầu sau chốt' (UC-27)"]
    AdminDeliver --> AuthModal["Mở hộp thoại bắt buộc: Nhập mật khẩu xác nhận Admin + Lý do/căn cứ giải trình"]
    AdminConfirm --> AuthModal
    AdminCancel --> AuthModal
    AuthModal --> LogStatus["Hệ thống thực hiện thao tác, ghi nhận người làm thay & căn cứ vào StatusLog"]
```

---

## 3. Cơ chế bảo vệ điều hướng (Navigation Guards & Action-level Permissions)

Hệ thống triển khai kiểm soát quyền truy cập chi tiết theo từng hành động (*Action-level Authorization*) thay vì chặn cứng toàn bộ màn hình:

| Ngữ cảnh hệ thống | Thao tác được phép thực hiện | Thao tác bị chặn / Vô hiệu hóa | Chuyển hướng & Phản hồi giao diện |
|---|---|---|---|
| **Chưa đăng nhập** | Xem trang công khai (Bản đồ, Sản phẩm, Xưởng, QR, Tin tức), Đăng ký Buyer, Đăng nhập. | Truy cập `/buyer/*`, `/artisan/*`, `/admin/*`. | Chuyển hướng về `/login?redirect={current_url}`. |
| **Đăng nhập mật khẩu tạm** | Đổi mật khẩu lần đầu tại `SCR-AUTH-03`. | Truy cập bất kỳ màn hình nghiệp vụ nào khác trong Portal. | Bắt buộc chuyển hướng về `SCR-AUTH-03` kèm thông báo: *"Bạn cần đổi mật khẩu trước khi tiếp tục"*. |
| **Hộ tạm ngừng (`Suspended` - BR-05)** | • Quản lý hồ sơ xưởng hiện tại.<br>• **Tạo Lô gốm mới và ghi nhật ký mộc**.<br>• Tiếp tục sản xuất và bàn giao các phần việc đã chốt trước đó.<br>• **Rút báo giá đã gửi** (chưa chốt). | • **Gửi báo giá mới** cho bất kỳ yêu cầu nào.<br>• Nhận thêm phần việc mới. | Hiển thị Banner vàng cố định trên đầu trang: *"Xưởng đang tạm ngừng nhận việc mới. Bạn vẫn có thể tạo lô, ghi nhật ký và hoàn thành các đơn hàng đã chốt trước đó"*. Nút "Gửi báo giá" bị mờ (Disabled). |
| **Yêu cầu đã Đóng nhận báo giá (`Bidding Closed`)** | • Buyer xem so sánh các báo giá đã nhận, nhờ BQL chia đơn, hủy yêu cầu.<br>• Artisan **được phép Rút báo giá** đã gửi (BR-14, BR-15). | • Artisan gửi thêm báo giá mới hoặc sửa tăng/giảm giá. | Trạng thái hiển thị nhãn phụ *"Đã đóng nhận báo giá"*. Form gửi báo giá bị khóa; nút **"Rút báo giá"** vẫn hoạt động bình thường. |
| **Yêu cầu đã Chốt (`Buyer Accepted` / `In Production`)** | • Buyer theo dõi tiến độ, sửa thông tin liên hệ nhận hàng.<br>• Artisan bắt đầu sản xuất, gắn lô gốm, bàn giao phần việc. | • Buyer tự ý hủy yêu cầu (sau chốt chỉ Admin mới có quyền hủy có căn cứ - BR-22).<br>• Artisan rút báo giá (báo giá đã trở thành phần việc trúng thầu). | Nút Hủy của Buyer chuyển thành: *"Yêu cầu đã chốt. Nếu có sự cố bất khả kháng, vui lòng liên hệ Ban quản lý"*. |
| **Yêu cầu đã Hủy (`Cancelled`)** | Xem lại dữ liệu lịch sử dạng chỉ đọc (Read-only). | Toàn bộ thao tác chào giá, chấp nhận, bắt đầu làm, bàn giao. | Hiển thị Banner đỏ: *"Yêu cầu này đã bị hủy vào lúc {thời_gian}. Lý do: {ly_do}"*. Toàn bộ form và nút hành động bị ẩn. |
