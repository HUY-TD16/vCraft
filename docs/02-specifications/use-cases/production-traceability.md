# Lô sản xuất và truy xuất nguồn gốc

[Mục lục và quy ước chung](../use-cases.md) · [Quy tắc nghiệp vụ](../business-rules.md)

<a id="uc-10"></a>
## UC-10 — Tạo lô và quản lý nhật ký

- **Tác nhân:** Artisan. **Quy tắc:** BR-07–BR-09.
- **Mục tiêu/kích hoạt:** Ghi lại quá trình sản xuất của một lô.
- **Tiền điều kiện:** Artisan quản lý lô của hộ mình.
- **Dữ liệu:** Thông tin nhận diện lô; mỗi mốc gồm thời gian thực hiện, công đoạn và 1–10 ảnh minh chứng.

**Luồng chính**

1. Artisan tạo lô; hệ thống lưu lô nháp thuộc hộ.
2. Artisan thêm mốc, nhập công đoạn, thời gian và tải ảnh.
3. Hệ thống kiểm tra mốc hợp lệ rồi lưu; hiển thị nhật ký theo thời gian thực hiện.
4. Artisan thêm/sửa mốc tiếp theo; hệ thống giữ liên kết nhật ký với lô, không tạo nhật ký riêng cho từng sản phẩm.

**Luồng khác/ngoại lệ**

- Lô nháp: được sửa hoặc xóa mốc. Lô đã công bố: được thêm/sửa nhưng không xóa mốc.
- Sửa mốc đã công bố: lưu nội dung trước sửa, tham chiếu ảnh, người sửa và thời điểm; giữ ảnh lịch sử. Chỉ hoàn tất cập nhật nếu cả nội dung mới và lịch sử được lưu đầy đủ.
- Thiếu ảnh/công đoạn/thời gian hoặc ảnh sai giới hạn: không lưu mốc. Mốc đã sửa vẫn phải hợp lệ.
- Lô của hộ khác: từ chối truy cập sửa. Không xóa lô đã công bố hoặc dữ liệu đã được dùng trong phần việc chốt.

**Hậu điều kiện:** Lô giữ nguyên trạng thái công bố; QR công khai hiển thị nội dung hiện hành và lần cập nhật gần nhất nếu lô đã công bố.

<a id="uc-11"></a>
## UC-11 — Công bố lô và lấy QR

- **Tác nhân:** Artisan. **Quy tắc:** BR-08, BR-09.
- **Mục tiêu/kích hoạt:** Cho khách truy xuất lô qua QR; chọn công bố lô.
- **Tiền điều kiện:** Sở hữu lô nháp có ít nhất một mốc hợp lệ.
- **Dữ liệu:** Lô được chọn.

**Luồng chính**

1. Artisan xem lại nhật ký và chọn công bố.
2. Hệ thống kiểm tra quyền sở hữu và điều kiện nhật ký.
3. Hệ thống chuyển lô sang đã công bố, bảo đảm lô có mã công khai khó đoán và QR trỏ đến địa chỉ truy xuất ổn định.
4. Artisan xem/lấy QR để sử dụng cho các sản phẩm cùng lô.

**Ngoại lệ:** Không có mốc hợp lệ: giữ nháp, yêu cầu bổ sung. Công bố lặp: trả về lô và QR đã có, không tạo mã mới. Không cho đưa về nháp hoặc xóa lô sau công bố. Nếu không thể hoàn tất công bố, không trả kết quả thành công hoặc QR truy xuất sai lô.

**Hậu điều kiện:** Trang lô được truy cập công khai. Các lần sửa nhật ký sau đó không thay đổi địa chỉ QR.

<a id="uc-12"></a>
## UC-12 — Truy xuất qua QR

- **Tác nhân:** Khách. **Quy tắc:** BR-04, BR-05, BR-09.
- **Mục tiêu/kích hoạt:** Quét QR hoặc mở liên kết truy xuất.
- **Tiền điều kiện:** Có mã/địa chỉ truy xuất; không cần tài khoản.
- **Dữ liệu:** Mã công khai của lô.

**Luồng chính**

1. Khách mở địa chỉ từ QR.
2. Máy chủ tìm lô theo mã và kiểm tra lô đã công bố.
3. Trang hiển thị thông tin truy xuất của lô, câu chuyện, các mốc và ảnh hiện hành theo thời gian, thời điểm cập nhật gần nhất.
4. Trang ghi rõ nhật ký do hộ cung cấp; cấp tài khoản không đồng nghĩa Admin xác nhận nhật ký.

**Ngoại lệ:** Mã không tồn tại hoặc lô nháp: không trả dữ liệu lô. Hộ tạm ngừng hoặc sản phẩm bị ẩn: QR lô đã công bố vẫn xem được; không vì vậy mở lại hồ sơ xưởng bị ẩn.

**Hậu điều kiện:** Không thay đổi dữ liệu. Cả giao diện và dữ liệu máy chủ trả về không chứa thông tin Buyer, liên hệ/bàn giao, đơn giá báo chào, yêu cầu mua sỉ hoặc lịch sử sửa riêng tư.

<a id="uc-13"></a>
## UC-13 — Xem lịch sử sửa nhật ký

- **Tác nhân:** Artisan sở hữu lô, Admin. **Quy tắc:** BR-08.
- **Mục tiêu/kích hoạt:** Đối chiếu nội dung đã sửa của mốc nhật ký công bố.
- **Tiền điều kiện:** Đã đăng nhập và được quyền xem lô.
- **Dữ liệu:** Lô và mốc cần đối chiếu.

**Luồng chính**

1. Người dùng mở lịch sử của mốc.
2. Hệ thống kiểm tra quyền và liệt kê các lần sửa, người sửa, thời điểm.
3. Người dùng mở từng lần để xem nội dung trước sửa và ảnh được giữ lại; đối chiếu với nội dung hiện hành.

**Ngoại lệ:** Mốc chưa có lịch sử: hiển thị chưa có lần sửa được ghi nhận. Khách, Buyer hoặc Artisan hộ khác: từ chối, kể cả truy cập trực tiếp ảnh lịch sử riêng tư.

**Hậu điều kiện:** Chỉ đọc; không có chức năng khôi phục phiên bản hoặc duyệt/xác nhận nhật ký thay Artisan.
