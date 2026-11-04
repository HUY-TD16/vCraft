# Bản phác thảo Wireframe & Trạng thái giao diện — vCraft

Căn cứ: [đề bài vCraft](../01-project-brief/vCraft.md), [danh mục màn hình](screen-inventory.md), [luồng điều hướng](navigation-flows.md), [quy tắc nghiệp vụ](../02-specifications/business-rules.md) và [bảo mật & phân quyền](../02-specifications/security-and-access-control.md).

Tài liệu này thể hiện bản phác thảo bố cục (ASCII Wireframes), các màn hình hạt nhân, quy chuẩn xử lý các trạng thái giao diện (Loading, Empty, Error, Idempotent Processing) và thiết kế thích ứng di động (Mobile-First) cho vCraft (Làng gốm Bát Tràng), đồng bộ 100% với hợp đồng dữ liệu thực tế.

---

## 1. Khung bố cục chuẩn (Standard Layouts)

### 1.1. Bố cục Công khai (Public Layout — Desktop)
```text
+--------------------------------------------------------------------------------------------------+
| [LOGO vCraft]  Bản đồ làng nghề   Khám phá xưởng   Sản phẩm gốm   Tin tức      [Đăng ký Buyer] [Đăng nhập] |
+--------------------------------------------------------------------------------------------------+
|                                                                                                  |
|                                       NỘI DUNG CHÍNH (MAIN CONTENT)                              |
|                                                                                                  |
+--------------------------------------------------------------------------------------------------+
| [vCraft - Làng gốm Bát Tràng]                  Liên kết: Bản đồ | Xưởng gốm | Sản phẩm | Tin tức |
+--------------------------------------------------------------------------------------------------+
```

### 1.2. Bố cục Quản trị & Tác nghiệp (Portal Layout — Buyer / Artisan / Admin)
*(Lưu ý: MVP không có chuông thông báo riêng, trạng thái được cập nhật trực tiếp trên danh sách và chi tiết)*
```text
+--------------------------------------------------------------------------------------------------+
| [LOGO vCraft - Portal]          [Tìm kiếm...]                              [👤 Tên người dùng ▼] |
+------------------+-------------------------------------------------------------------------------+
| [SIDEBAR]        | BREADCRUMB: Trang chủ > Lô sản xuất > Nhật ký mẻ gốm                         |
| • Tổng quan      +-------------------------------------------------------------------------------+
| • Hồ sơ xưởng    | TIÊU ĐỀ TRANG                                        [Hành động chính: + Tạo] |
| • Sản phẩm       +-------------------------------------------------------------------------------+
| • Lô & Nhật ký   |                                                                               |
| • Yêu cầu sỉ     |                         KHU VỰC TÁC NGHIỆP DỮ LIỆU                            |
| • Phần việc      |                                                                               |
| • Đổi mật khẩu   |                                                                               |
| • Đăng xuất      |                                                                               |
+------------------+-------------------------------------------------------------------------------+
```

---

## 2. Wireframe chi tiết các màn hình hạt nhân của vCraft

---

### Màn hình 1: SCR-PUB-02 — Bản đồ số làng gốm Bát Tràng (Interactive Map)

Hiển thị các xưởng gốm theo tọa độ GPS, lọc xưởng đang mở cửa đón khách (Yêu cầu 4.3 đề bài & BR-10). Popup chỉ hiển thị dữ liệu thực tế (tên xưởng, địa chỉ, trạng thái mở cửa):

```text
+--------------------------------------------------------------------------------------------------+
| [LOGO vCraft]  [Bản đồ làng nghề]  Khám phá xưởng   Sản phẩm gốm   Tin tức     [Đăng ký] [Đăng nhập] |
+--------------------------------------------------------------------------------------------------+
| TÌM KIẾM & BỘ LỌC BẢN ĐỒ:                                                                        |
| [🔍 Tìm xưởng gốm, tên nghệ nhân...]  [Phân loại gốm: Tất cả ▼]  [X] Chỉ hiện xưởng đang mở cửa đón khách |
+------------------------------------+-------------------------------------------------------------+
| DANH SÁCH XƯỞNG (32 xưởng Bát Tràng) | BẢN ĐỒ TƯƠNG TÁC LÀNG GỐM BÁT TRÀNG (LEAFLET / OPENSTREETMAP)|
|                                    |                                                             |
| +--------------------------------+ |   [+]                                                       |
| | XƯỞNG GỐM BÙI THU              | |   [-]   (Ghim xanh: Đang mở cửa; Ghim xám: Tạm đóng cửa)   |
| | [Ảnh xưởng]  🟢 ĐANG ĐÓN KHÁCH | |                                                             |
| | Địa chỉ: Xóm 2, Giang Cao      | |              [📍 Xưởng Gốm Bùi Thu]                         |
| | [Xem hồ sơ xưởng]              | |         +---------------------------------------+          |
| +--------------------------------+ |         | XƯỞNG GỐM BÙI THU                     |          |
| | GỐM SỨ MINH CHÂU               | |         | • Địa chỉ: Xóm 2, Giang Cao, Bát Tràng|          |
| | [Ảnh xưởng]  ⚪ TẠM ĐÓNG CỬA   | |         | • Trạng thái: 🟢 Đang mở cửa đón khách|          |
| | Địa chỉ: Thôn 1, Bát Tràng     | |         | [Xem chi tiết hồ sơ xưởng]            |          |
| | [Xem hồ sơ xưởng]              | |         +---------------------------------------+          |
| +--------------------------------+ |                                                             |
| | XƯỞNG GỐM VƯƠNG AN             | |                          📍                                |
| | [Ảnh xưởng]  🟢 ĐANG ĐÓN KHÁCH | |               📍                                           |
| | [Xem hồ sơ xưởng]              | |                                            📍              |
| +--------------------------------+ |                                                             |
+------------------------------------+-------------------------------------------------------------+
```

---

### Màn hình 2: SCR-PUB-07 — Landing Page Kể chuyện Lô gốm & Truy xuất nguồn gốc QR

Màn hình công khai khi quét QR trên sản phẩm (Yêu cầu 4.1): Chỉ sử dụng dữ liệu thực tế có trong schema `Batch` và `BatchStage`.

```text
+--------------------------------------------------------------------------------------------------+
| [LOGO vCraft]                                     Làng nghề gốm Bát Tràng • Truy xuất nguồn gốc   |
+--------------------------------------------------------------------------------------------------+
| LÔ GỐM: MẺ BÌNH TỲ BÀ MEN LAM                                                                    |
| • Mã truy xuất lô: #BATCH-BT-2026-089               • Ngày bắt đầu: 20/09/2026                   |
| • Hộ sản xuất: Xưởng Gốm Bùi Thu                    • Ngày công bố: 28/10/2026                   |
+--------------------------------------------------------------------------------------------------+
| MÔ TẢ LÔ GỐM:                                                                                    |
| "Mẻ bình tỳ bà men lam cổ chế tác thủ công từ đất sét trắng mộc, nung nhiệt độ cao 1.280°C..."   |
| ℹ️ Lưu ý: Nội dung nhật ký quy trình sản xuất do hộ sản xuất tự công bố và chịu trách nhiệm.      |
+--------------------------------------------------------------------------------------------------+
| DÒNG THỜI GIAN CÔNG ĐOẠN SẢN XUẤT (TRACEABILITY TIMELINE):                                      |
|                                                                                                  |
| (●) CÔNG ĐOẠN 1: CHUẨN BỊ ĐẤT VÀ TẠO HÌNH                                    [20/09/2026 08:30]  |
|  |  Mô tả: Lọc đất sét trắng phù sa, vuốt mộc trên bàn xoay tạo phôi bình tỳ bà.                  |
|  |  ẢNH MINH CHỨNG: [Ảnh vuốt mộc 1]  [Ảnh vuốt mộc 2]                                           |
|  |                                                                                               |
| (●) CÔNG ĐOẠN 2: PHƠI SẤY VÀ SỬA MỘC                                        [25/09/2026 14:00]  |
|  |  Mô tả: Mộc phơi râm tự nhiên trong 5 ngày, gọt tiện đều xương gốm.                           |
|  |  ẢNH MINH CHỨNG: [Ảnh giàn phơi mộc]                                                          |
|  |                                                                                               |
| (●) CÔNG ĐOẠN 3: TRANG TRÍ HỌA TIẾT & TRÁNG MEN                              [02/10/2026 09:30]  |
|  |  Mô tả: Nghệ nhân vẽ họa tiết lam cô-ban bằng tay, nhúng lớp men tro bảo vệ.                  |
|  |  ẢNH MINH CHỨNG: [Ảnh vẽ hoa văn]  [Ảnh nhúng men]                                            |
|  |                                                                                               |
| (●) CÔNG ĐOẠN 4: NUNG LÒ Ở NHIỆT ĐỘ CAO                                     [10/10/2026 19:00]  |
|  |  Mô tả: Nung lò gas liên tục 36 giờ, duy trì nhiệt đỉnh 1.280°C và hạ nguội tự nhiên.         |
|  |  ẢNH MINH CHỨNG: [Ảnh đồng hồ đo nhiệt lò]  [Ảnh xếp bao nung]                                |
|  |                                                                                               |
| (✓) CÔNG ĐOẠN 5: KIỂM TRA THÀNH PHẨM                                         [28/10/2026 10:00]  |
|     Mô tả: Chọn lọc sản phẩm hoàn thiện đạt tiêu chuẩn, đóng gói lưu kho.                         |
|     ẢNH MINH CHỨNG: [Ảnh bình thành phẩm]                                                        |
+--------------------------------------------------------------------------------------------------+
| THÔNG TIN HỘ SẢN XUẤT:                                                                           |
| [Trường hợp 1: Hộ đang hoạt động & công khai]                                                    |
| Hộ sản xuất: Xưởng Gốm Bùi Thu  -->  [Xem hồ sơ xưởng] | [Xem xưởng trên bản đồ]                 |
|                                                                                                  |
| [Trường hợp 2: Hộ tạm ngừng hoặc hồ sơ không công khai (BR-04, BR-05)]                           |
| Hộ sản xuất: Xưởng Gốm Bùi Thu (Chỉ hiển thị tên dạng text thuần, KHÔNG CÓ LIÊN KẾT)             |
+--------------------------------------------------------------------------------------------------+
```

---

### Màn hình 3: SCR-BUY-03 — Chi tiết yêu cầu mua sỉ & Phòng chào giá (Bidding Room)

Phòng Bidding chứa đầy đủ thông tin ra quyết định: Hạn chấp nhận, trạng thái báo giá, danh sách hộ mời và cảnh báo giá hàng (Yêu cầu 4.2 đề bài & BR-11–BR-20):

```text
+--------------------------------------------------------------------------------------------------+
| BREADCRUMB: Yêu cầu mua sỉ > #REQ-2026-0042                               [Sửa liên hệ nhận hàng]|
+--------------------------------------------------------------------------------------------------+
| YÊU CẦU ĐẶT HÀNG SỈ #REQ-2026-0042        [TRẠNG THÁI CHÍNH: 🟡 ARTISANS BIDDING (ĐANG CHÀO GIÁ)]|
| • Phân loại: Bát, đĩa và khay             • Hạn nhận báo giá: 17:00 ngày 15/11/2026              |
| • Số lượng đặt mua: 5.000 chiếc           • Đếm ngược: ⏳ Còn 2 ngày 04 giờ 12 phút              |
| • Hạn cần nhận hàng: 20/12/2026           • Nhãn phụ: [Đang nhận giá] (hoặc: [Đã đóng nhận giá]) |
| • Quy cách: Cốc gốm 300ml, men trắng, in logo ĐHQG, đóng hộp đơn                                  |
| ℹ️ LƯU Ý: Giá báo chỉ bao gồm tiền hàng tại xưởng; chi phí vận chuyển thỏa thuận ngoài hệ thống.   |
+--------------------------------------------------------------------------------------------------+
| DANH SÁCH BÁO GIÁ ĐÃ NHẬN:                                                                       |
|                                                                                                  |
| HỘ SẢN XUẤT        ĐƠN GIÁ    SL ĐÁP ỨNG  TỔNG TIỀN     NGÀY BÀN GIAO  HẠN CHẤP NHẬN  HÀNH ĐỘNG  |
| ------------------------------------------------------------------------------------------------ |
| 1. Gốm Bùi Thu     35.000 đ   5.000 (100%) 175.000.000 đ 15/12/2026    14/11 17:00    [CHẤP NHẬN]|
|                                                                                                  |
| 2. Gốm Minh Châu    32.000 đ   3.000 (60%)   96.000.000 đ 18/12/2026    15/11 12:00    (Không đủ) |
|                                                                                                  |
| 3. Gốm Vương An    33.500 đ   2.000 (40%)   67.000.000 đ 12/12/2026    10/11 10:00    [ĐÃ HẾT HẠN]|
|                                                                                                  |
| 4. Gốm Hồng Hà     34.000 đ   2.500 (50%)   85.000.000 đ 16/12/2026    15/11 17:00    [ĐÃ RÚT GIÁ]|
+--------------------------------------------------------------------------------------------------+
| DANH SÁCH CÁC HỘ ĐÃ GỬI YÊU CẦU ĐẾN:                                                             |
| • Gốm Bùi Thu: Đã gửi báo giá        • Gốm Minh Châu: Đã gửi báo giá                             |
| • Gốm Vương An: Đã gửi báo giá       • Gốm Hồng Hà: Đã rút báo giá                               |
| • Gốm Thanh Tâm: Đã từ chối (Lý do: Lò đang kín lịch)   • Gốm Vạn Lộc: Chưa phản hồi             |
+--------------------------------------------------------------------------------------------------+
| TÙY CHỌN QUYẾT ĐỊNH CỦA BUYER:                                                                   |
|                                                                                                  |
| [Nút 1: Chấp nhận trực tiếp]                                                                     |
| Chọn [CHẤP NHẬN] tại hàng Gốm Bùi Thu -> Nút chuyển sang "Đang xử lý...", kiểm tra tính hợp lệ  |
| của báo giá -> Thành công: Yêu cầu chuyển sang trạng thái "Buyer Accepted".                      |
|                                                                                                  |
| [Nút 2: Thao tác tiện lợi - Đóng nhận sớm & Nhờ BQL chia đơn]                                    |
| [🛑 ĐÓNG NHẬN SỚM VÀ NHỜ BAN QUẢN LÝ CHIA ĐƠN]                                                    |
| (Quy trình: Gọi API đóng nhận sớm -> Gọi tiếp API gửi yêu cầu chia đơn đến BQL.                   |
| Nếu bước 2 gặp lỗi: Giữ nguyên trạng thái đã đóng nhận kèm nút 'Thử lại gửi yêu cầu BQL')       |
|                                                                                                  |
| [Nút 3: Hủy yêu cầu khi chưa chốt]                                                               |
| [❌ HỦY YÊU CẦU NÀY (UC-27)]                                                                     |
+--------------------------------------------------------------------------------------------------+
```

---

### Màn hình 4: SCR-ADM-04 — Ban quản lý Lập phương án chia đơn

Admin lập phương án đề xuất; **Buyer mới là người quyết định chấp nhận** (Yêu cầu 2 & 4.2):

```text
+--------------------------------------------------------------------------------------------------+
| BAN QUẢN LÝ LÀNG NGHỀ • LẬP PHƯƠNG ÁN ĐIỀU PHỐI CHIA ĐƠN                                         |
| Yêu cầu: #REQ-2026-0042 • Số lượng cần: 5.000 chiếc • Hạn cần hàng: 20/12/2026                   |
+--------------------------------------------------------------------------------------------------+
| BẢNG BÁO GIÁ CỦA CÁC HỘ TRONG LÀNG (Chỉ chọn các báo giá còn hiệu lực và hộ đang hoạt động):     |
|                                                                                                  |
| HỘ GỐM BÁT TRÀNG     BÁO GIÁ        HẠN GIAO    HẠN CHẤP NHẬN    SỐ LƯỢNG PHÂN BỔ ĐỀ XUẤT        |
| ------------------------------------------------------------------------------------------------ |
| [X] Gốm Sứ Minh Châu 32.000 đ       18/12/2026  15/11 12:00      [ 3.000 ] chiếc =  96.000.000 đ |
| [X] Gốm Sứ Vương An  33.500 đ       12/12/2026  16/11 17:00      [ 2.000 ] chiếc =  67.000.000 đ |
| [ ] Gốm Sứ Bùi Thu   35.000 đ       15/12/2026  14/11 17:00      [   0   ] chiếc =           0 đ |
+--------------------------------------------------------------------------------------------------+
| TỔNG HỢP & RÀNG BUỘC PHƯƠNG ÁN:                                                                  |
| • Số lượng yêu cầu: 5.000 chiếc | Số lượng phân bổ: 5.000 chiếc [🟢 ĐÃ KHỚP ĐỦ 100%]             |
| • Tiến độ: [==================================================] 100% (5.000 / 5.000)            |
| • Tổng kinh phí dự kiến: 163.000.000 đ | Hạn hoàn thành: 18/12/2026 (Theo hộ muộn nhất)          |
| • Thiết lập hạn Buyer quyết định phương án (*): [ 14/11/2026 12:00 📅 ] (Phải trước hạn báo giá) |
+--------------------------------------------------------------------------------------------------+
| [← Quay lại hàng chờ]                          [🚀 GỬI PHƯƠNG ÁN NÀY ĐỂ BUYER PHÊ DUYỆT (UC-21)] |
| (Lưu ý: Sau khi gửi, yêu cầu vẫn ở Artisans Bidding với nhãn phụ: 'Chờ Buyer quyết định phương án')|
+--------------------------------------------------------------------------------------------------+
```

---

### Màn hình 5: SCR-ART-09 — Nghệ nhân Quản lý phần việc sản xuất (Allocations)

Bổ sung hành động **"Bắt đầu sản xuất"** bắt buộc để kích hoạt yêu cầu chuyển sang `In Production` (BR-20, UC-23):

```text
+--------------------------------------------------------------------------------------------------+
| BREADCRUMB: Xưởng gốm > Quản lý phần việc sản xuất (Allocations)                                 |
+--------------------------------------------------------------------------------------------------+
| PHẦN VIỆC #ALLOC-2026-0018                   [TRẠNG THÁI PHẦN VIỆC: 🟣 ASSIGNED (ĐÃ GIAO VIỆC)]   |
| • Thuộc yêu cầu: #REQ-2026-0042 (5.000 cốc gốm in logo)                                          |
| • Số lượng xưởng cần sản xuất: 3.000 chiếc cốc                                                   |
| • Hạn cam kết bàn giao: 18/12/2026                                                               |
+--------------------------------------------------------------------------------------------------+
| BƯỚC 1: XÁC NHẬN BẮT ĐẦU SẢN XUẤT (BẮT BUỘC TRƯỚC KHI BÀN GIAO):                                 |
| Hiện tại phần việc đang ở trạng thái 'Assigned'. Khi xưởng bắt đầu chuẩn bị đất và nặn gốm:       |
|                                                                                                  |
| [▶️ BẮT ĐẦU SẢN XUẤT (UC-23)]                                                                     |
| (Nhấn nút này để chuyển phần việc sang 'In Production', đồng thời kích hoạt trạng thái yêu cầu    |
| chuyển từ 'Buyer Accepted' sang 'In Production' nếu là hộ đầu tiên bắt đầu)                      |
+--------------------------------------------------------------------------------------------------+
| BƯỚC 2: LIÊN KẾT LÔ GỐM TRUY XUẤT NGUỒN GỐC (TÙY CHỌN / KHUYẾN NGHỊ):                            |
| Chọn Lô sản xuất của xưởng để khách hàng quét mã QR xem nhật ký:                                 |
| [ Lô #BATCH-BT-2026-089: Mẻ cốc trắng in logo ĐHQG (Đã công bố) ▼ ]   [+ Gắn lô này]             |
| Các lô đã gắn: #BATCH-BT-2026-089 (3.000 chiếc)                                                  |
+--------------------------------------------------------------------------------------------------+
| BƯỚC 3: BÀN GIAO PHẦN VIỆC KHI HOÀN THÀNH:                                                       |
| Sau khi xưởng đã nung xong, đóng thùng và giao hàng cho Buyer:                                   |
|                                                                                                  |
| [📦 XÁC NHẬN BÀN GIAO PHẦN VIỆC (UC-24)]                                                         |
| (Nếu chưa gắn Lô gốm, hệ thống hiển thị cảnh báo: 'Phần việc chưa gắn lô truy xuất nguồn gốc.    |
| Bạn có chắc chắn muốn bàn giao không?' -> Nếu nghệ nhân đồng ý, vẫn cho phép bàn giao - BR-24)   |
+--------------------------------------------------------------------------------------------------+
```

---

### Màn hình 6: Hộp thoại quản trị đặc thù & Xử lý ngoại lệ (Modals)

#### Modal 1: Hộp thoại hiển thị mật khẩu tạm một lần (One-Time Password Modal — SCR-ADM-02)
```text
+-----------------------------------------------------------------------+
| 🔑 TÀI KHOẢN ĐÃ ĐƯỢC TẠO / RESET MẬT KHẨU THÀNH CÔNG                  |
|                                                                       |
| • Tên đăng nhập (Username):  artisan_buithu                           |
| • Mật khẩu tạm thời:         vCraft@2026#Temp                         |
|                                                                       |
| ⚠️ LƯU Ý QUAN TRỌNG:                                                  |
| Mật khẩu này CHỈ HIỂN THỊ MỘT LẦN DUY NHẤT. Ban quản lý hãy sao chép  |
| và bàn giao trực tiếp cho nghệ nhân. Nghệ nhân bắt buộc phải đổi mật  |
| khẩu mới ngay trong lần đăng nhập đầu tiên.                           |
|                                                                       |
| [📋 Sao chép mật khẩu]                                 [Đã lưu & Đóng]|
+-----------------------------------------------------------------------+
```

#### Modal 2: Hộp thoại Admin can thiệp ngoại lệ (Exception Override Modal — SCR-ADM-05)
*(Áp dụng khi Bàn giao thay UC-24, Nhận đủ thay UC-26, hoặc Hủy sau chốt UC-27)*
```text
+-----------------------------------------------------------------------+
| ⚠️ XÁC NHẬN THAO TÁC NGOẠI LỆ: XÁC NHẬN NHẬN ĐỦ THAY BUYER (UC-26)   |
|                                                                       |
| Thao tác này sẽ chuyển yêu cầu sang trạng thái 'Delivered' và ghi     |
| nhận trách nhiệm của Ban quản lý vào nhật ký kiểm toán (StatusLog).    |
|                                                                       |
| 1. Nhập mật khẩu xác thực của Quản trị viên (*):                      |
|    [ •••••••••••••••• ]                                               |
|                                                                       |
| 2. Lý do và căn cứ giải trình văn bản (*):                            |
|    +----------------------------------------------------------------+ |
|    | Buyer đã nhận đủ 5.000 cốc tại kho ngày 19/12 theo biên bản bàn| |
|    | giao số 12/BBBG, đã thanh toán đủ nhưng không thao tác trên web.| |
|    +----------------------------------------------------------------+ |
|                                                                       |
| [Hủy bỏ]                              [XÁC NHẬN THỰC HIỆN VÀ GHI LOG] |
+-----------------------------------------------------------------------+
```

---

## 3. Quy chuẩn các trạng thái giao diện (UI States)

### 3.1. Trạng thái Thao tác Giao dịch Quan trọng (Idempotent Submitting State)
* **Quy tắc tuyệt đối:** Thao tác **"Chấp nhận báo giá"**, **"Chấp nhận phương án"**, **"Bàn giao"**, **"Nhận đủ"** và **"Hủy đơn"** **KHÔNG DÙNG Optimistic UI giả định thành công**.
* **Quy trình UI:**
  1. Khi người dùng bấm nút: Nút lập tức chuyển sang trạng thái Disabled kèm nhãn: `[Đang xử lý giao dịch...]`.
  2. Frontend sinh `idempotencyKey` gửi kèm Header.
  3. Chỉ khi máy chủ trả về `200 OK` / `201 Created`, UI mới cập nhật huy hiệu trạng thái mới và hiển thị Toast thành công.
  4. Nếu máy chủ phản hồi lỗi (409 Conflict, 400 Bad Request): Hiển thị modal lỗi rõ ràng, giữ nguyên trạng thái cũ.
  5. Nếu mất mạng hoặc Timeout: Hiển thị cảnh báo: *"Chưa nhận được phản hồi từ máy chủ. Vui lòng bấm 'Kiểm tra trạng thái' trước khi thử lại để tránh trùng lặp"*.

### 3.2. Trạng thái Tải lên & Tối ưu hóa ảnh (Image Uploading States — SEC-10)
* Giai đoạn 1 (Client tải file lên máy chủ): Hiển thị % thực tế đo được từ `XMLHttpRequest` / `axios`: `hien_truong.jpg [====>     ] 45%`.
* Giai đoạn 2 (Máy chủ nén Sharp, xoay EXIF, tạo 2 phiên bản): Hiển thị trạng thái chờ dạng spinner: `hien_truong.jpg 🔄 Đang tối ưu trên máy chủ...`.
* Giai đoạn 3 (Hoàn tất): `hien_truong.jpg 🟢 Sẵn sàng (320px & 1600px)`.
* Nếu lỗi worker hoặc file hỏng: `hien_truong.jpg ❌ Lỗi xử lý [Thử lại] [Xóa]`. Không làm gián đoạn các ảnh khác trong danh sách tải.

### 3.3. Các trạng thái lỗi hệ thống thường gặp
* **401 Unauthorized / Phiên hết hạn:** Mở Modal *"Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại"* $\rightarrow$ Chuyển về `/login?redirect=...`.
* **409 Conflict / Xung đột phiên bản:** Báo rõ nguyên nhân: *"Báo giá này vừa được cập nhật hoặc yêu cầu đã thay đổi trạng thái"*, cung cấp nút `[Tải lại dữ liệu mới nhất]`.
* **429 Too Many Requests (Rate limit):** *"Bạn đã thao tác quá nhanh. Vui lòng thử lại sau {so_giay} giây"*.

---

## 4. Thiết kế thích ứng trên thiết bị di động (Mobile Responsive UI)

* **Bản đồ di động (SCR-PUB-02):** Chế độ chuyển đổi nút bấm `[Bản đồ 🗺️] | [Danh sách 📋]`. Popup xưởng hiển thị dạng **Bottom Sheet Drawer** trượt nhẹ từ dưới lên.
* **Trang QR di động (SCR-PUB-07):**
  * Dòng thời gian mộc hiển thị dạng Timeline dọc, ảnh mộc có thể chạm để xem phóng to.
  * **Xử lý nhánh hộ ẩn:** Nếu hộ tạm ngừng hoặc hồ sơ xưởng không công khai, **KHÔNG hiển thị nút cố định dẫn sang hồ sơ xưởng**, chỉ hiện tên xưởng dạng văn bản thuần.
* **Bảng báo giá & Bảng điều phối trên di động:** Toàn bộ bảng dữ liệu chuyển thành dạng **Card View** xếp chồng dọc, mỗi thẻ có đơn giá to rõ, hạn chấp nhận nổi bật, và nút hành động có chiều cao $\ge$ 44px dễ bấm bằng ngón tay cái.
