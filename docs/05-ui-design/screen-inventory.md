# Danh mục màn hình — vCraft

Căn cứ: [đặc tả use case](../02-specifications/use-cases.md), [quy tắc nghiệp vụ](../02-specifications/business-rules.md), [bảo mật & phân quyền](../02-specifications/security-and-access-control.md), [thiết kế dữ liệu](../02-specifications/data-design.md) và [đặc tả API & DTOs](../04-architecture/api-design.md).

Tài liệu này xác định toàn bộ hệ thống màn hình, định tuyến URL, vai trò truy cập, mục đích nghiệp vụ và các chế độ/hộp thoại thao tác cho nền tảng Triển lãm số & Điều phối đơn hàng Làng gốm Bát Tràng vCraft, đồng bộ 100% với hợp đồng dữ liệu và các quy tắc nghiệp vụ đã chốt.

---

## 1. Phân nhóm Layout & Không gian người dùng

Hệ thống được chia thành 4 không gian giao diện với Layout chuyên biệt:

1. **Public Layout (Khách vãng lai & Khách tham quan):**
   * Header công khai: Logo vCraft, Menu khám phá (Bản đồ làng nghề, Xưởng gốm, Sản phẩm, Tin tức), Nút Đăng ký Buyer, Nút Đăng nhập.
   * Không yêu cầu đăng nhập. Tối ưu hóa hiển thị ảnh gốm sứ, xưởng sản xuất và trang kể chuyện lô gốm qua QR.
2. **Buyer Layout (Người mua sỉ / Khách đặt hàng lớn):**
   * Thanh điều hướng trên hoặc Sidebar tinh gọn: Danh sách yêu cầu báo giá, Soạn yêu cầu mới, Hồ sơ & Đổi mật khẩu, Nút Đăng xuất.
   * Không có chuông thông báo riêng (MVP thông báo trạng thái trực tiếp trên danh sách và chi tiết yêu cầu).
   * Giao diện tập trung vào quy cách sản phẩm, phòng chào giá Bidding, duyệt phương án chia đơn và tiến độ giao hàng.
3. **Artisan Layout (Hộ gia đình / Nghệ nhân Bát Tràng):**
   * Sidebar quản trị xưởng: Tổng quan xưởng & Trạng thái mở cửa, Quản lý sản phẩm, Lô gốm & Nhật ký mộc, Yêu cầu báo giá đến, Quản lý phần việc sản xuất (Allocations), Hồ sơ xưởng, Đổi mật khẩu.
   * Tối ưu thao tác di động/tablet tại xưởng (chụp ảnh mộc, ghi nhật ký, rút/sửa báo giá, bắt đầu sản xuất, bàn giao phần việc).
4. **Admin Layout (Ban quản lý làng nghề / Hội làng gốm):**
   * Sidebar quản trị: Bảng điều hành, Quản lý danh sách hộ & cấp/reset tài khoản, Hàng chờ chia đơn mua sỉ, Quản lý phân loại gốm, Quản lý tin tức cộng đồng, Nhật ký kiểm toán (Audit Logs).

---

## 2. Danh mục màn hình chi tiết

### 2.1. Phân hệ Công khai (Public Portal)

| Mã màn hình | Tên màn hình | Đường dẫn URL | Vai trò | Use Case | Mục đích & Chức năng chính |
|---|---|---|---|---|---|
| **SCR-PUB-01** | Trang chủ vCraft | `/` | Khách, Tất cả | [UC-08](../02-specifications/use-cases.md#uc-08) | Giới thiệu làng gốm Bát Tràng, các xưởng tiêu biểu, sản phẩm độc bản nổi bật và định hướng đặt hàng mua buôn. |
| **SCR-PUB-02** | Bản đồ số làng nghề | `/map` | Khách, Tất cả | [UC-08](../02-specifications/use-cases.md#uc-08) | Bản đồ tương tác (Leaflet) hiển thị vị trí các xưởng theo tọa độ GPS, bộ lọc xưởng đang mở cửa đón khách (BR-10). Popup chỉ hiển thị thông tin vắn tắt và trạng thái mở cửa thực tế. |
| **SCR-PUB-03** | Khám phá xưởng gốm | `/workshops` | Khách, Tất cả | [UC-08](../02-specifications/use-cases.md#uc-08) | Danh sách xưởng sản xuất, tìm kiếm theo tên hộ/nghệ nhân, xem ảnh đại diện xưởng và trạng thái mở cửa. |
| **SCR-PUB-04** | Chi tiết hồ sơ xưởng | `/workshops/:id` | Khách, Tất cả | [UC-05](../02-specifications/use-cases.md#uc-05), [UC-08](../02-specifications/use-cases.md#uc-08) | Câu chuyện gia đình làm nghề, ảnh xưởng, ảnh chứng nhận (nếu có), bộ sưu tập sản phẩm đang công khai. Nếu hộ bị tạm ngừng hoặc hồ sơ không công khai, trang báo lỗi không tìm thấy (BR-04, BR-05). |
| **SCR-PUB-05** | Danh mục sản phẩm gốm | `/catalog` | Khách, Tất cả | [UC-08](../02-specifications/use-cases.md#uc-08) | Danh sách sản phẩm phân loại theo 5 nhóm chuẩn (Ấm chén, Bát đĩa, Bình lọ trang trí, Đồ thờ, Chậu gốm); lọc theo hộ sản xuất. |
| **SCR-PUB-06** | Chi tiết sản phẩm | `/catalog/:id` | Khách, Tất cả | [UC-08](../02-specifications/use-cases.md#uc-08) | Ảnh sản phẩm chất lượng cao (thu nhỏ/hiển thị), giá tham khảo, quy cách kích thước và liên kết đến Lô sản xuất của sản phẩm. |
| **SCR-PUB-07** | Truy xuất nguồn gốc lô gốm | `/traceability/:batchCode` | Khách, Quét QR | [UC-11](../02-specifications/use-cases.md#uc-11), [UC-12](../02-specifications/use-cases.md#uc-12) | **Trang QR công khai:** Hiển thị tên lô, ngày công bố, mô tả lô, dòng thời gian các mốc công đoạn (thời điểm, mô tả, ảnh minh chứng) và tên hộ sản xuất. Kèm ghi chú: *Nội dung nhật ký do hộ sản xuất tự công bố và chịu trách nhiệm*. **Nhánh hộ bị ẩn:** Nếu hộ tạm ngừng hoặc hồ sơ không công khai, chỉ hiện tên hộ, KHÔNG có liên kết dẫn sang hồ sơ xưởng (BR-04, BR-05). |
| **SCR-PUB-08** | Tin tức cộng đồng | `/community` | Khách, Tất cả | [UC-09](../02-specifications/use-cases.md#uc-09) | Danh sách thông báo về giá nguyên liệu đất/men, lịch cúp điện, chính sách hỗ trợ làng nghề Bát Tràng theo thứ tự ngày đăng mới nhất. |
| **SCR-PUB-09** | Chi tiết bài viết tin tức | `/community/:id` | Khách, Tất cả | [UC-09](../02-specifications/use-cases.md#uc-09) | Nội dung chi tiết bài viết/thông báo từ Ban quản lý làng nghề. |

---

### 2.2. Phân hệ Xác thực & Tài khoản (Authentication)

| Mã màn hình | Tên màn hình | Đường dẫn URL | Vai trò | Use Case | Mục đích & Chế độ giao diện |
|---|---|---|---|---|---|
| **SCR-AUTH-01** | Đăng nhập hệ thống | `/login` | Chưa login | [UC-02](../02-specifications/use-cases.md#uc-02) | Đăng nhập bằng `username` và `password` (không dùng email làm định danh đăng nhập). Thiết lập cookie an toàn HttpOnly (SEC-05).<br>• **Chế độ mật khẩu tạm:** Nếu tài khoản mới được cấp hoặc vừa reset mật khẩu, sau khi xác thực thành công hệ thống chuyển hướng bắt buộc sang `SCR-AUTH-03` để đổi mật khẩu lần đầu trước khi được vào portal (BR-01, SEC-05). |
| **SCR-AUTH-02** | Đăng ký tài khoản Buyer | `/register` | Khách vãng lai | [UC-01](../02-specifications/use-cases.md#uc-01) | Tự đăng ký tài khoản khách mua buôn bằng `username`, mật khẩu chuẩn OWASP, tên đơn vị/cá nhân, số điện thoại liên hệ; email là trường tùy chọn (BR-01). |
| **SCR-AUTH-03** | Đổi mật khẩu | `/account/password` | Đã đăng nhập | [UC-02](../02-specifications/use-cases.md#uc-02) | Nhập mật khẩu hiện tại và mật khẩu mới. Sau khi đổi thành công: hệ thống tự động tăng `auth_version`, hủy toàn bộ phiên làm việc (kể cả phiên hiện tại) $\rightarrow$ hiển thị thông báo thành công và chuyển về `/login` yêu cầu đăng nhập lại (SEC-05). |

---

### 2.3. Phân hệ Khách mua sỉ (Buyer Portal)

| Mã màn hình | Tên màn hình | Đường dẫn URL | Vai trò | Use Case | Mục đích & Chức năng chi tiết |
|---|---|---|---|---|---|
| **SCR-BUY-01** | Danh sách yêu cầu mua sỉ | `/buyer/requests` | Buyer | [UC-14](../02-specifications/use-cases.md#uc-14), [UC-18](../02-specifications/use-cases.md#uc-18) | Danh sách yêu cầu với bộ lọc trạng thái: Nháp, Đang nhận giá (kèm nhãn đóng nhận nếu có), Khách đã chấp nhận, Đang sản xuất, Đã nhận đủ, Đã hủy.<br>• **Thao tác nhanh:** Sửa nháp, Xóa nháp (khi ở `Draft Request`), Sao chép yêu cầu cũ thành bản nháp mới (BR-11). |
| **SCR-BUY-02** | Soạn thảo yêu cầu báo giá | `/buyer/requests/new`<br>`/buyer/requests/:id/edit` | Buyer | [UC-14](../02-specifications/use-cases.md#uc-14), [UC-15](../02-specifications/use-cases.md#uc-15) | Chọn phân loại gốm, mô tả quy cách (dung tích/kích thước, màu men, in logo, đóng gói), số lượng sỉ, đơn vị tính (chiếc/bộ), thời hạn nhận giá (`biddingDeadline`), hạn cần nhận hàng (`deliveryDeadline`).<br>• Nút **"Lưu nháp"** hoặc Nút **"Gửi đến các hộ"** (chuyển sang `Sent to Artisans` / `Artisans Bidding`). |
| **SCR-BUY-03** | Chi tiết & Phòng chào giá (Bidding Room) | `/buyer/requests/:id` | Buyer | [UC-16](../02-specifications/use-cases.md#uc-16), [UC-17](../02-specifications/use-cases.md#uc-17), [UC-19](../02-specifications/use-cases.md#uc-19), [UC-20](../02-specifications/use-cases.md#uc-20), [UC-27](../02-specifications/use-cases.md#uc-27) | **Phòng Bidding mua sỉ:**<br>1. Thông tin quy cách & Thông báo: *Giá báo chỉ bao gồm tiền hàng tại xưởng, chi phí vận chuyển thỏa thuận ngoài hệ thống*.<br>2. Đếm ngược hạn nhận giá (`biddingDeadline`) & Nhãn đóng nhận sớm nếu có.<br>3. Bảng báo giá: Hộ gửi, đơn giá, số lượng đáp ứng, tổng tiền, ngày hẹn giao, **hạn chấp nhận báo giá (`acceptedUntil`)**, nhãn trạng thái (Đã hết hạn / Đã rút / Hộ tạm ngừng).<br>4. Danh sách hộ nhận yêu cầu & phản hồi (Chưa phản hồi / Đã từ chối).<br>5. Nhãn cảnh báo khi: *"Không còn báo giá hợp lệ"*. Thao tác Hủy yêu cầu khi chưa chốt (UC-27).<br>6. **Quyết định chốt:** Nút **"Chấp nhận trực tiếp"** (nếu hộ đáp ứng đủ 100% số lượng); Nút tiện ích **"Đóng nhận sớm và nhờ BQL chia đơn"** (gọi tuần tự API đóng nhận và API nhờ chia; nếu bước 2 lỗi, yêu cầu vẫn ở trạng thái đóng nhận kèm nút bấm thử lại gửi yêu cầu BQL).<br>7. Sửa thông tin liên hệ / ghi chú nhận hàng sau khi gửi (trước khi hoàn tất). |
| **SCR-BUY-04** | Xem & Phê duyệt phương án chia đơn | `/buyer/requests/:id/proposal` | Buyer | [UC-22](../02-specifications/use-cases.md#uc-22) | Xem phương án Ban quản lý đề xuất (danh sách các hộ, số lượng từng hộ, tổng tiền, ngày giao muộn nhất).<br>• Hiển thị: **Hạn quyết định phương án (`decisionDeadline`)**; Cảnh báo phương án hết hiệu lực nếu quá hạn hoặc có báo giá bị rút.<br>• Nút **"Chấp nhận phương án"** (chuyển yêu cầu sang `Buyer Accepted`, tạo các phần việc `Assigned`).<br>• Nút **"Từ chối phương án"** (mở hộp thoại nhập lý do từ chối; yêu cầu quay lại trạng thái Bidding chờ giải pháp khác). |
| **SCR-BUY-05** | Theo dõi tiến độ & Xác nhận nhận hàng | `/buyer/requests/:id/tracking` | Buyer | [UC-23](../02-specifications/use-cases.md#uc-23), [UC-24](../02-specifications/use-cases.md#uc-24), [UC-25](../02-specifications/use-cases.md#uc-25) | Theo dõi từng phần việc của các hộ (Trạng thái: `Assigned` $\rightarrow$ `In Production` $\rightarrow$ `Delivered`).<br>• Xem mã QR lô gốm liên kết của từng phần việc (nếu hộ đã gắn lô).<br>• Nút **"Xác nhận nhận đủ hàng"** (chỉ khả dụng khi tất cả các phần việc đã `Delivered` $\rightarrow$ chuyển yêu cầu sang `Delivered`).<br>• **Hiển thị thông tin Admin làm thay:** Nếu Admin can thiệp xác nhận nhận đủ thay hoặc bàn giao thay, hiển thị rõ huy hiệu *"Admin ghi nhận thay"*, tên người thực hiện, thời điểm và căn cứ giải trình (UC-26). |

---

### 2.4. Phân hệ Nghệ nhân / Hộ sản xuất (Artisan Portal)

| Mã màn hình | Tên màn hình | Đường dẫn URL | Vai trò | Use Case | Mục đích & Chức năng chi tiết |
|---|---|---|---|---|---|
| **SCR-ART-01** | Tổng quan xưởng gốm | `/artisan/dashboard` | Artisan | [UC-05](../02-specifications/use-cases.md#uc-05), [UC-18](../02-specifications/use-cases.md#uc-18) | Thống kê số phần việc đang làm, việc cần giao trong tuần, báo giá đang chờ gửi.<br>• Công tắc bật/tắt: `Trạng thái mở cửa đón khách tham quan` (cập nhật tức thì lên bản đồ số).<br>• Banner vàng thông báo nếu hộ bị tạm ngừng (BR-05). |
| **SCR-ART-02** | Quản lý thông tin xưởng | `/artisan/profile` | Artisan | [UC-05](../02-specifications/use-cases.md#uc-05) | Cập nhật câu chuyện gia đình làm nghề, ảnh xưởng, ảnh chứng nhận chất lượng, tọa độ ghim bản đồ. |
| **SCR-ART-03** | Quản lý sản phẩm xưởng | `/artisan/products` | Artisan | [UC-07](../02-specifications/use-cases.md#uc-07) | Danh sách sản phẩm của xưởng; thêm mới/sửa sản phẩm, tải ảnh sản phẩm (tối đa 10 ảnh), gán sản phẩm vào Lô sản xuất. |
| **SCR-ART-04** | Quản lý Lô sản xuất | `/artisan/batches` | Artisan | [UC-10](../02-specifications/use-cases.md#uc-10) | Danh sách lô gốm: Mã lô, tên mẻ gốm, ngày bắt đầu, trạng thái (Nháp / Đã công bố), số mốc nhật ký.<br>• **Quyền hộ tạm ngừng:** Vẫn được tạo lô mới và ghi nhật ký để hoàn thành phần việc đã chốt (BR-05). |
| **SCR-ART-05** | Chi tiết & Ghi nhật ký công đoạn | `/artisan/batches/:id/stages` | Artisan | [UC-10](../02-specifications/use-cases.md#uc-10), [UC-11](../02-specifications/use-cases.md#uc-11), [UC-13](../02-specifications/use-cases.md#uc-13) | **Tác nghiệp xưởng:** Thêm mốc công đoạn (tên mốc, thời điểm thực tế, mô tả kỹ thuật mộc); Tải ảnh hiện trường (tối đa 10 ảnh / mốc, thanh tiến trình đo được khi upload); Xem lịch sử sửa đổi nhật ký; Nút "Công bố lô gốm" (yêu cầu tối thiểu 1 mốc có ảnh). |
| **SCR-ART-06** | Thẻ QR Code lô gốm | `/artisan/batches/:id/qr` | Artisan | [UC-11](../02-specifications/use-cases.md#uc-11) | Hiển thị mã QR ổn định; nút tải file ảnh QR (PNG/SVG) để in tem dán lên sản phẩm gốm. Ghi chú rõ QR phục vụ truy xuất câu chuyện mộc, không thay thế chứng nhận chất lượng. |
| **SCR-ART-07** | Yêu cầu báo giá đến | `/artisan/quotes/inbox` | Artisan | [UC-16](../02-specifications/use-cases.md#uc-16) | Danh sách yêu cầu sỉ phù hợp với phân loại xưởng. Hiển thị hạn nhận giá, đếm ngược thời gian. Nút mở form báo giá; Nút **"Từ chối yêu cầu"** (mở hộp thoại nhập lý do tùy chọn). Nếu hộ bị tạm ngừng: nút báo giá bị vô hiệu hóa (BR-05). |
| **SCR-ART-08** | Soạn & Quản lý báo giá | `/artisan/quotes/:requestId` | Artisan | [UC-16](../02-specifications/use-cases.md#uc-16) | Nhập đơn giá chào, số lượng đáp ứng (tối đa bằng số lượng yêu cầu), ngày cam kết bàn giao, và **Hạn chấp nhận báo giá (`acceptedUntil`)**.<br>• Thao tác: **Gửi báo giá**, **Sửa báo giá** (khi chưa đóng nhận và chưa chốt), **Rút báo giá** (cho phép rút kể cả khi yêu cầu đã đóng nhận hoặc hộ bị tạm ngừng), **Gửi lại báo giá** sau khi rút (nếu yêu cầu còn mở nhận giá). |
| **SCR-ART-09** | Quản lý phần việc sản xuất (Allocations) | `/artisan/allocations` | Artisan | [UC-23](../02-specifications/use-cases.md#uc-23), [UC-24](../02-specifications/use-cases.md#uc-24) | Danh sách phần việc trúng thầu (`Assigned`, `In Production`, `Delivered`).<br>• Nút **"Bắt đầu sản xuất"** (chuyển phần việc sang `In Production`, kích hoạt yêu cầu chuyển sang `In Production` nếu là hộ đầu tiên).<br>• Liên kết một hoặc nhiều Lô sản xuất cùng số lượng.<br>• Cảnh báo nếu bàn giao mà thiếu truy xuất/chưa gắn lô, nhưng **vẫn cho phép bàn giao**.<br>• Nút **"Bàn giao phần việc"** (chuyển phần việc sang `Delivered`). |

---

### 2.5. Phân hệ Ban quản lý Làng nghề (Admin Portal)

| Mã màn hình | Tên màn hình | Đường dẫn URL | Vai trò | Use Case | Mục đích & Chức năng chi tiết |
|---|---|---|---|---|---|
| **SCR-ADM-01** | Bảng điều hành làng nghề | `/admin/dashboard` | Admin | [UC-03](../02-specifications/use-cases.md#uc-03), [UC-21](../02-specifications/use-cases.md#uc-21) | Thống kê số hộ gốm hoạt động/tạm ngừng, yêu cầu sỉ đang điều phối, các yêu cầu chờ chia đơn cần xử lý. |
| **SCR-ADM-02** | Quản lý danh sách hộ gốm | `/admin/artisans` | Admin | [UC-03](../02-specifications/use-cases.md#uc-03), [UC-04](../02-specifications/use-cases.md#uc-04) | Danh sách hộ sản xuất.<br>• Nút **"Cấp tài khoản mới"**: Sau khi xác minh thực tế, nhập username, tên hộ $\rightarrow$ hệ thống sinh mật khẩu tạm $\rightarrow$ mở **Hộp thoại hiển thị mật khẩu tạm 1 lần**.<br>• Nút **"Reset mật khẩu hộ"**: Bắt buộc nhập mật khẩu của Admin + lý do/căn cứ $\rightarrow$ mở Hộp thoại hiển thị mật khẩu tạm 1 lần.<br>• Nút **"Tạm ngừng" / "Cho hoạt động lại"** hộ gốm (BR-05). |
| **SCR-ADM-03** | Hàng chờ điều phối chia đơn | `/admin/coordination` | Admin | [UC-20](../02-specifications/use-cases.md#uc-20), [UC-21](../02-specifications/use-cases.md#uc-21) | Danh sách các yêu cầu mua sỉ mà Buyer đã nhờ Ban quản lý chia đơn (kèm thời gian Buyer gửi nhờ chia và hạn cần nhận hàng). |
| **SCR-ADM-04** | Lập phương án phân bổ đơn hàng | `/admin/coordination/:requestId` | Admin | [UC-21](../02-specifications/use-cases.md#uc-21) | **Màn hình điều phối BQL:** Xem tất cả báo giá hợp lệ của các hộ; Nhập số lượng phân bổ cho từng hộ sao cho tổng bằng 100% yêu cầu; Tự động tính tổng tiền và lấy ngày giao muộn nhất; Đặt hạn quyết định phương án (`decisionDeadline`).<br>• Nút **"Gửi phương án cho Buyer duyệt"** (Admin chỉ lập phương án đề xuất, **Buyer mới là người quyết định chấp nhận**). Sau khi gửi, yêu cầu vẫn ở `Artisans Bidding` với nhãn phụ *"Chờ Buyer quyết định phương án"*. |
| **SCR-ADM-05** | Chi tiết đơn & Xử lý ngoại lệ điều phối | `/admin/quote-requests/:id` | Admin | [UC-24](../02-specifications/use-cases.md#uc-24), [UC-26](../02-specifications/use-cases.md#uc-26), [UC-27](../02-specifications/use-cases.md#uc-27) | Xem toàn diện yêu cầu và các phần việc.<br>• **Thao tác ngoại lệ:** Nút **"Ghi nhận bàn giao thay hộ"** (UC-24), Nút **"Xác nhận nhận đủ thay Buyer"** (UC-26), Nút **"Hủy yêu cầu sau chốt"** (UC-27). Tất cả thao tác ngoại lệ đều mở hộp thoại bắt buộc nhập **mật khẩu xác nhận của Admin** và **lý do/căn cứ giải trình** lưu vào `StatusLog` (BR-25, BR-27). |
| **SCR-ADM-06** | Quản lý phân loại sản phẩm | `/admin/categories` | Admin | [UC-06](../02-specifications/use-cases.md#uc-06) | Quản lý danh mục 5 phân loại chuẩn khởi tạo (tên phân loại, mã, trạng thái kích hoạt). Không có trường thứ tự hay mô tả mở rộng. |
| **SCR-ADM-07** | Quản lý tin tức cộng đồng | `/admin/community` | Admin | [UC-09](../02-specifications/use-cases.md#uc-09) | Soạn và đăng tin tức (tiêu đề, nội dung, ngày đăng) về giá đất/men, lịch cúp điện, hỗ trợ làng nghề. Danh sách sắp xếp theo thời gian mới nhất (không có ghim tin). |
| **SCR-ADM-08** | Tra cứu lịch sử & Kiểm toán (Audit Logs) | `/admin/audit-logs` | Admin | [UC-03](../02-specifications/use-cases.md#uc-03), [UC-27](../02-specifications/use-cases.md#uc-27) | Màn hình tra cứu, đối chiếu lịch sử chuyển trạng thái (`StatusLog`) và nhật ký kiểm toán hệ thống. **Không gộp nút bấm xử lý nghiệp vụ vào màn hình này** mà thực hiện trực tiếp tại chi tiết yêu cầu `SCR-ADM-05`. |

---

*Tài liệu này là căn cứ chính thức để cập nhật sơ đồ điều hướng trong `navigation-flows.md` và hoàn thiện wireframes trong `wireframes.md`.*
