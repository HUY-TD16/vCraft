# Thiết kế giao diện & Trải nghiệm người dùng (UI/UX) — vCraft

Căn cứ: [đề bài vCraft](../01-project-brief/vCraft.md), [phạm vi dự án](../01-project-brief/project-scope.md), [đặc tả use case](../02-specifications/use-cases.md), [quy tắc nghiệp vụ](../02-specifications/business-rules.md) và [bảo mật & phân quyền](../02-specifications/security-and-access-control.md).

Thư mục này lưu trữ toàn bộ đặc tả thiết kế giao diện frontend cho nền tảng Triển lãm số & Điều phối đơn hàng Làng gốm Bát Tràng vCraft, tập trung vào trải nghiệm hình ảnh sản phẩm gốm sứ, bản đồ tương tác làng nghề, dòng thời gian truy xuất nguồn gốc bằng mã QR và phòng đấu thầu báo giá mua sỉ (Bidding Room).

---

## 1. Hệ thống tài liệu thiết kế chi tiết

| Tài liệu | Nội dung & Phạm vi đặc tả |
|---|---|
| [screen-inventory.md](screen-inventory.md) | **Danh mục toàn bộ màn hình hệ thống:** Định tuyến URL, phân quyền vai trò (Public, Buyer, Artisan, Admin), liên kết mã Use Case và mục đích nghiệp vụ; đặc tả các chế độ màn hình và hộp thoại ngoại lệ. |
| [navigation-flows.md](navigation-flows.md) | **Sơ đồ điều hướng & Hành trình người dùng:** Sơ đồ Site Map phân cấp, 4 biểu đồ Mermaid chi tiết cho luồng Khách tham quan (QR Scan), Người mua sỉ (B2B Procurement), Nghệ nhân (Tác nghiệp xưởng & Chào giá) và Ban quản lý (Điều phối chia đơn & Xử lý ngoại lệ); kiểm soát quyền theo từng hành động cụ thể. |
| [wireframes.md](wireframes.md) | **Bản phác thảo bố cục (Wireframes) & Trạng thái UI:** Bản vẽ ASCII chi tiết các màn hình hạt nhân (Bản đồ Leaflet, Landing Page QR Timeline, Phòng Bidding, Màn hình BQL chia đơn, Quản lý phần việc & Bắt đầu sản xuất, Form nhật ký lô tải ảnh); quy chuẩn xử lý giao dịch an toàn (Idempotency), lỗi mạng/timeout và thiết kế thích ứng di động (Mobile-First). |
| [design-guidelines.md](design-guidelines.md) | **Quy chuẩn thẩm mỹ & Design System:** Bảng màu lấy cảm hứng từ làng gốm Bát Tràng (Đất nung `#8C4623`, Men lam `#1B4965`, Men ngọc `#3A7D6B`), hệ thống phông chữ (Playfair Display & Be Vietnam Pro), chuẩn hóa huy hiệu 6 trạng thái yêu cầu, trạng thái phần việc, trạng thái báo giá và nút bấm an toàn. |

---

## 2. Tiêu chuẩn bàn giao kỹ thuật cho Frontend (`frontend/`)

1. **Khung công nghệ triển khai:** React 19 + TypeScript 5.x + Vite 6 + Tailwind CSS (v3.4+/v4) + shadcn/ui.
2. **Quản lý biểu mẫu & Validation:** React Hook Form + Zod (đồng bộ 100% với backend DTOs và quy tắc Fail-Fast).
3. **Quản lý giao dịch an toàn & Idempotency:**
   * **Tuyệt đối không dùng Optimistic UI giả định thành công** cho các thao tác chốt đơn, chấp nhận báo giá, bàn giao, nhận đủ hoặc hủy yêu cầu.
   * Chuyển nút bấm sang trạng thái Disabled kèm nhãn *"Đang xử lý giao dịch..."*, sinh `idempotencyKey` gửi kèm header và chỉ cập nhật giao diện khi máy chủ phản hồi `200 OK`.
   * Khi gặp lỗi mạng/timeout: giữ nguyên form và idempotency key để hỗ trợ người dùng kiểm tra trạng thái trước khi gửi lại, ngăn chặn tạo đơn trùng lặp.
4. **Tối ưu hóa hình ảnh (SEC-10):**
   * Chỉ tải ảnh thu nhỏ (320px) trên danh sách, xem ảnh phóng lớn (1600px) tại trang chi tiết/timeline.
   * Thanh tiến trình tải ảnh: Đo và hiển thị % thực tế khi client upload tệp lên máy chủ; hiển thị trạng thái chờ khi máy chủ đang nén và tối ưu ảnh.
5. **Tiêu chuẩn tương thích di động:** Đảm bảo toàn bộ quy trình quét mã QR và duyệt bản đồ xưởng thao tác trơn tru trên màn hình smartphone (Touch target $\ge$ 44px).
