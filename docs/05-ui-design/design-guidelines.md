# Quy chuẩn thiết kế giao diện (Design Guidelines) — vCraft

Căn cứ: [đề bài vCraft](../01-project-brief/vCraft.md), [danh mục màn hình](screen-inventory.md), [luồng điều hướng](navigation-flows.md) và [bản phác thảo wireframe](wireframes.md).

Tài liệu này xác định ngôn ngữ thiết kế, bảng màu lấy cảm hứng từ làng gốm Bát Tràng, kiểu chữ, quy cách thành phần giao diện (Design System) và hệ thống huy hiệu trạng thái nghiệp vụ chuẩn xác cho nền tảng vCraft.

---

## 1. Triết lý thiết kế (Design Philosophy)

* **Tôn vinh văn hóa gốm Bát Tràng:** Thiết kế tái hiện không gian triển lãm nghệ thuật, mang hơi thở của đất sét nung, men lam cổ và lửa lò Bát Tràng.
* **Hình ảnh là trung tâm (Image-Centric):** Tôn vinh sản phẩm thủ công mỹ nghệ qua hình ảnh chân thực, góc chụp rõ nét, hiển thị thớ đất mộc và đường rạn men.
* **Minh bạch và Chuyên nghiệp:** Luồng báo giá và truy xuất nguồn gốc hiển thị số liệu rõ ràng, thời hạn cụ thể, không giả định thành công trước khi có kết quả giao dịch từ máy chủ.

---

## 2. Bảng màu chủ đạo (Ceramic Color Palette)

| Tên màu sắc | Mã Hex | Ý nghĩa văn hóa & Công năng sử dụng trên giao diện |
|---|---|---|
| **Đất Nung (Terracotta)** | `#8C4623` | **Màu thương hiệu chính (Primary):** Màu của đất sét đỏ sau khi nung. Dùng cho Header chính, nút hành động chính (Primary Button), liên kết nổi bật. |
| **Men Lam Cổ (Cobalt Blue)** | `#1B4965` | **Màu phụ trợ (Secondary):** Màu men lam đại diện cho gốm Bát Tràng truyền thống. Dùng cho thẻ phân loại, nút phụ (Secondary Button). |
| **Men Ngọc (Celadon)** | `#3A7D6B` | **Màu thành công & Sinh khí (Success / Accent):** Màu men ngọc trầm ấm. Dùng cho trạng thái *"Đang mở cửa đón khách"*, *"Đã nhận đủ hàng"*, *"Khớp đủ 100% số lượng"*. |
| **Trắng Ngà Mộc (Warm Porcelain)** | `#FBF8F4` | **Màu nền toàn trang (Background):** Tông màu trắng ấm của xương gốm mộc, tạo cảm giác dễ chịu cho mắt. |
| **Trắng Bề Mặt (Surface White)** | `#FFFFFF` | **Màu nền khối thẻ (Card Surface):** Nền của các thẻ sản phẩm, bảng biểu dữ liệu, popup bản đồ. |
| **Tro Than Lò (Charcoal Text)** | `#2B2623` | **Màu chữ chính (Text Primary):** Màu của tro trấu và than lò nung, độ tương phản cao, đạt chuẩn WCAG AA. |
| **Xám Khói Lò (Muted Grey)** | `#7A726D` | **Màu chữ phụ (Text Secondary / Muted):** Dùng cho thời gian, chú thích mốc công đoạn, số đo quy cách. |
| **Vàng Thổ Hoàng (Ochre)** | `#C47D17` | **Màu cảnh báo & Chờ đợi (Warning):** Dùng cho trạng thái *"Đang chào giá (Bidding)"*, *"Chờ Buyer quyết định"*. |
| **Đỏ Lửa Lò (Kiln Flame Red)** | `#B3261E` | **Màu nguy hiểm / Hủy (Destructive):** Dùng cho nút Hủy yêu cầu, huy hiệu *"Đã hủy"*, thông báo lỗi xung đột đồng thời (409 Conflict). |

---

## 3. Hệ thống Typography

* **Phông chữ Tiêu đề (Headings):**
  * Ưu tiên: `Playfair Display` hoặc `Merriweather` (Google Fonts, hỗ trợ tiếng Việt đầy đủ).
  * Ứng dụng: Tiêu đề trang chủ (`h1`), Tên lô gốm trên trang QR, Tên xưởng nghệ nhân. Mang lại vẻ trang nhã, cổ kính của di sản làng nghề.
* **Phông chữ Thân bài & Giao diện tác nghiệp (Body & UI):**
  * Ưu tiên: `Be Vietnam Pro` hoặc `Inter` (Sans-serif chuẩn quốc gia, cực kỳ sắc nét trên màn hình Retina/Mobile).
  * Ứng dụng: Bảng dữ liệu báo giá, form nhập liệu, nhãn nút bấm, văn bản nhật ký mộc.

---

## 4. Quy chuẩn huy hiệu trạng thái nghiệp vụ (State Badges)

### 4.1. 6 Trạng thái chính của Yêu cầu mua sỉ (`QuoteRequest`)
Mỗi trạng thái trong luồng nghiệp vụ 6 bước bắt buộc được định dạng màu sắc và nhãn hiển thị chính xác:

1. `Draft Request`: Viền xám, nền xám nhạt (`bg-stone-100 text-stone-700`) — **Nháp yêu cầu** (chưa gửi).
2. `Sent to Artisans`: Viền xanh dương, nền xanh nhạt (`bg-blue-50 text-blue-700`) — **Đã gửi đến các hộ** (chờ đến giờ mở nhận giá hoặc đã mở nhận).
3. `Artisans Bidding`: Viền vàng đất, nền vàng ấm (`bg-amber-50 text-amber-800 font-semibold`) — **Các hộ đang chào giá** (Kèm nhãn phụ: *[Đang nhận giá]* hoặc *[Đã đóng nhận giá]*).
4. `Buyer Accepted`: Viền tím nhạt, nền tím mộc (`bg-purple-50 text-purple-800 font-semibold`) — **Khách đã chấp nhận** (Đã chốt hộ nhận việc, chờ các hộ bắt đầu sản xuất).
5. `In Production`: Viền xanh lam, nền xanh biển sâu (`bg-sky-50 text-sky-800 animate-pulse-slow`) — **Đang sản xuất** (Ít nhất một hộ đã bấm bắt đầu sản xuất).
6. `Delivered`: Viền xanh men ngọc, nền xanh lá ấm (`bg-emerald-50 text-emerald-800 font-bold`) — **Đã xác nhận nhận đủ** (Khách hoặc Admin xác nhận đã nhận đủ toàn bộ hàng).
* Trạng thái hủy bổ sung: `Cancelled`: Viền đỏ, nền đỏ nhạt (`bg-rose-50 text-rose-800`) — **Đã hủy yêu cầu** (Kèm lý do hủy).

### 4.2. Trạng thái phần việc của từng hộ (`Allocation States`)
* `Assigned`: Viền tím nhạt, nền tím nhạt (`bg-purple-50 text-purple-700`) — **Đã giao việc** (chờ hộ bấm Bắt đầu).
* `In Production`: Viền xanh lam, nền xanh lam nhạt (`bg-sky-50 text-sky-700`) — **Đang sản xuất**.
* `Delivered`: Viền xanh lá, nền xanh lá nhạt (`bg-emerald-50 text-emerald-700 font-semibold`) — **Hộ đã bàn giao** (chờ Buyer nhận đủ).

### 4.3. Trạng thái từng Báo giá của Nghệ nhân (`Quote States`)
* `Submitted`: Nền trắng, viền vàng ấm — **Đã gửi báo giá** (đang chờ Buyer quyết định).
* `Accepted`: Nền xanh lá ấm, chữ xanh đậm — **Đã được chọn / Trúng thầu**.
* `Expired`: Nền xám, chữ xám (`text-stone-400 line-through`) — **Đã hết hạn chấp nhận**.
* `Withdrawn`: Nền cam nhạt, chữ cam — **Nghệ nhân đã rút báo giá**.
* `Rejected`: Nền xám nhạt, chữ xám — **Không được chọn / Phương án bị từ chối**.

### 4.4. Huy hiệu trạng thái xưởng đón khách (Workshop Badges)
* 🟢 **Đang mở cửa đón khách:** Chấm tròn xanh lá (`bg-emerald-500 ring-2 ring-emerald-200 text-emerald-900`) kèm chữ *"Đang mở cửa đón khách"*.
* ⚪ **Tạm đóng cửa:** Chấm tròn xám (`bg-stone-400 text-stone-600`) kèm chữ *"Tạm đóng cửa"*.

---

## 5. Quy chuẩn thành phần nút bấm & Thao tác an toàn

* **Primary (Chính):** Nền Đất nung `#8C4623`, chữ trắng, bo góc `rounded-lg`, hover `#73381B`, đổ bóng `shadow-sm`.
* **Secondary (Phụ):** Nền trắng, viền Men lam `#1B4965`, chữ `#1B4965`, hover `bg-blue-50`.
* **Destructive (Hủy):** Nền trắng, viền Đỏ lửa `#B3261E`, chữ đỏ, hover `bg-rose-50`.
* **Thao tác Giao dịch Quan trọng (Chấp nhận, Bàn giao, Nhận đủ, Hủy):**
  * Nút chuyển sang trạng thái Disabled kèm nhãn: `[Đang xử lý giao dịch...]`.
  * Khóa bấm lặp (Double-click protection) và gửi kèm `idempotencyKey`.
* **Touch Target Di động:** Chiều cao nút bấm trên màn hình điện thoại tối thiểu **44px**.
