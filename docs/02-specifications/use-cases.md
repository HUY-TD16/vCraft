# Đặc tả use case vCraft

Căn cứ: [phạm vi dự án](../01-project-brief/project-scope.md), [quy tắc nghiệp vụ](business-rules.md) và [đề bài](../01-project-brief/vCraft.md).

## 1. Quy ước chung

- Khách là người xem công khai, không cần tài khoản. Buyer, Artisan và Admin phải đăng nhập để thực hiện nghiệp vụ tương ứng. Admin là đại diện Ban quản lý.
- “Yêu cầu” là `QuoteRequest` xuyên suốt từ nháp đến giao hàng; sau khi chấp nhận không tạo thực thể đơn hàng riêng. “Phần việc” là `Allocation` của một hộ.
- Quy tắc BR dẫn tới mã tương ứng trong [business-rules.md](business-rules.md). Mọi luồng phải tuân thủ quyền sở hữu và giới hạn dữ liệu tại BR-03–BR-04, kể cả khi gọi trực tiếp API.
- Các bước cập nhật kiểm tra lại dữ liệu trên máy chủ. Sai quyền, dữ liệu không hợp lệ hoặc phiên bản cũ: từ chối thao tác, giữ dữ liệu đã lưu và nêu lý do. Không ghi nhận thành công một phần đối với chấp nhận/phân bổ đơn.
- Thời hạn dùng ngày-giờ Việt Nam (UTC+07:00), so sánh bằng thời gian máy chủ. Tại đúng hạn nhận báo giá, yêu cầu đã đóng; tại đúng thời hạn giao cam kết, báo giá không còn đủ điều kiện chọn. Quá hạn giao của phần việc đã chốt không tự kết thúc hoặc hủy đơn.
- Ảnh dùng JPG/PNG/WebP, tối đa 5 MB/ảnh; sản phẩm và mỗi mốc nhật ký tối đa 10 ảnh. Chỉ lưu tham chiếu ảnh đã tải thành công; backend tạo ảnh thu nhỏ và ảnh hiển thị. Lỗi tải ảnh phải cho sửa hoặc thử lại, không công bố dữ liệu thiếu ảnh bắt buộc.
- Các cập nhật yêu cầu, báo giá và phương án tăng `version`. Ghi chuyển trạng thái yêu cầu, hủy và xác nhận thay vào `StatusLog`. Thao tác gửi lặp không được tạo thêm kết quả nghiệp vụ đã có.
- Hậu điều kiện mô tả kết quả thành công. Nếu thất bại, dữ liệu nghiệp vụ trước thao tác được giữ nguyên, trừ các trạng thái đã tự hết hiệu lực theo thời gian hoặc thay đổi hợp lệ từ thao tác khác.

## 2. Danh mục use case

| Mã | Use case | Tác nhân chính | Quy tắc |
| --- | --- | --- | --- |
| [UC-01](use-cases/accounts-and-catalog.md#uc-01) | Đăng ký Buyer | Khách | BR-01 |
| [UC-02](use-cases/accounts-and-catalog.md#uc-02) | Đăng nhập, đăng xuất | Buyer, Artisan, Admin | BR-01, BR-03, BR-05 |
| [UC-03](use-cases/accounts-and-catalog.md#uc-03) | Cấp tài khoản hộ | Admin | BR-01, BR-02, BR-05, BR-28 |
| [UC-04](use-cases/accounts-and-catalog.md#uc-04) | Tạm ngừng, cho hộ hoạt động lại | Admin | BR-05, BR-18, BR-27 |
| [UC-05](use-cases/accounts-and-catalog.md#uc-05) | Quản lý hồ sơ và trạng thái đón khách | Artisan | BR-10, BR-28 |
| [UC-06](use-cases/accounts-and-catalog.md#uc-06) | Quản lý phân loại | Admin | BR-06 |
| [UC-07](use-cases/accounts-and-catalog.md#uc-07) | Quản lý sản phẩm | Artisan | BR-06, BR-07, BR-09 |
| [UC-08](use-cases/accounts-and-catalog.md#uc-08) | Khám phá xưởng, sản phẩm và bản đồ | Khách | BR-04, BR-05, BR-07, BR-10, BR-28 |
| [UC-09](use-cases/accounts-and-catalog.md#uc-09) | Quản lý và đọc tin cộng đồng | Admin, Khách | BR-02, BR-04, BR-29 |
| [UC-10](use-cases/production-traceability.md#uc-10) | Tạo lô, quản lý nhật ký | Artisan | BR-07–BR-09 |
| [UC-11](use-cases/production-traceability.md#uc-11) | Công bố lô và lấy QR | Artisan | BR-08, BR-09 |
| [UC-12](use-cases/production-traceability.md#uc-12) | Truy xuất qua QR | Khách | BR-04, BR-05, BR-09 |
| [UC-13](use-cases/production-traceability.md#uc-13) | Xem lịch sử sửa nhật ký | Artisan, Admin | BR-08 |
| [UC-14](use-cases/quotation-and-allocation.md#uc-14) | Soạn yêu cầu nháp | Buyer | BR-11 |
| [UC-15](use-cases/quotation-and-allocation.md#uc-15) | Gửi yêu cầu đến các hộ | Buyer | BR-11–BR-13, BR-26, BR-27 |
| [UC-16](use-cases/quotation-and-allocation.md#uc-16) | Gửi, sửa báo giá | Artisan | BR-14, BR-15, BR-26, BR-27 |
| [UC-17](use-cases/quotation-and-allocation.md#uc-17) | Đóng nhận báo giá | Buyer, Hệ thống | BR-12, BR-27 |
| [UC-18](use-cases/quotation-and-allocation.md#uc-18) | Theo dõi yêu cầu và báo giá | Buyer, Artisan, Admin | BR-04, BR-15, BR-18, BR-23 |
| [UC-19](use-cases/quotation-and-allocation.md#uc-19) | Chấp nhận trực tiếp | Buyer | BR-16, BR-19, BR-20, BR-26, BR-27 |
| [UC-20](use-cases/quotation-and-allocation.md#uc-20) | Nhờ Ban quản lý chia đơn | Buyer | BR-17, BR-23, BR-27 |
| [UC-21](use-cases/quotation-and-allocation.md#uc-21) | Lập phương án chia đơn | Admin | BR-17–BR-19, BR-27 |
| [UC-22](use-cases/quotation-and-allocation.md#uc-22) | Chấp nhận hoặc từ chối phương án | Buyer | BR-18–BR-20, BR-26, BR-27 |
| [UC-23](use-cases/fulfillment-and-cancellation.md#uc-23) | Bắt đầu phần việc, gắn lô | Artisan | BR-05, BR-20, BR-24, BR-26, BR-27 |
| [UC-24](use-cases/fulfillment-and-cancellation.md#uc-24) | Báo đã giao phần việc | Artisan | BR-24, BR-27 |
| [UC-25](use-cases/fulfillment-and-cancellation.md#uc-25) | Xác nhận nhận đủ | Buyer | BR-25–BR-27 |
| [UC-26](use-cases/fulfillment-and-cancellation.md#uc-26) | Xác nhận nhận đủ thay Buyer | Admin | BR-25–BR-27 |
| [UC-27](use-cases/fulfillment-and-cancellation.md#uc-27) | Hủy yêu cầu | Buyer, Admin | BR-21–BR-23, BR-26, BR-27 |

## 3. Luồng xuyên suốt

| Tình huống | Chuỗi use case | Kết quả |
| --- | --- | --- |
| Công bố và truy xuất | UC-03 → UC-05 → UC-10 → UC-11 → UC-07 → UC-08/UC-12 | Sản phẩm có lô và trang QR công khai. |
| Một hộ nhận toàn bộ | UC-14 → UC-15 → UC-16 → UC-19 → UC-23 → UC-24 → UC-25 | Một phần việc, yêu cầu chuyển đến `Delivered`. |
| Nhiều hộ cùng thực hiện | UC-14 → UC-15 → UC-16 → UC-17 → UC-20 → UC-21 → UC-22 → UC-23/UC-24 cho từng hộ → UC-25 | Phân bổ đủ số lượng; chỉ hoàn tất khi nhận đủ toàn bộ. |
| Không đủ khả năng đáp ứng | UC-17 → UC-18 → UC-27; có thể bắt đầu lại UC-14 | Yêu cầu cũ giữ nguyên số lượng và lịch sử, được đánh dấu hủy. |
| Phương án mất hiệu lực | UC-04 hoặc hết thời hạn giao cam kết → UC-18 → UC-21 | Lập lại nếu còn đủ báo giá hợp lệ; nếu thiếu thì Buyer có thể hủy. |
| Xác nhận thay có căn cứ | UC-24 cho mọi hộ → UC-26 | `Delivered`, có lý do và căn cứ trong lịch sử. |

Đóng nhận, nhờ chia đơn và gắn lô không tạo trạng thái chính mới. Hủy giữ nguyên trạng thái chính cuối cùng và ghi thông tin hủy riêng. Không có bước tự động nhận hàng, thanh toán hay phân bổ lại sau khi chấp nhận.

## 4. Tình huống nghiệm thu trọng yếu

| Tình huống | Kết quả phải đạt | Use case |
| --- | --- | --- |
| Khách mở QR lô đã công bố, rồi thử mã của lô nháp | Xem được lô công bố không cần đăng nhập; máy chủ không trả dữ liệu lô nháp hoặc dữ liệu mua sỉ riêng tư. | UC-11, UC-12 |
| Artisan sửa một mốc đã công bố và thử xóa mốc đó | Nội dung hiện hành cập nhật; nội dung/ảnh trước sửa còn trong lịch sử; thao tác xóa bị từ chối. | UC-10, UC-13 |
| Gửi/sửa báo giá đúng lúc đạt hạn nhận, tác vụ nền chưa chạy | Bị từ chối; thời điểm đóng do hết hạn bằng hạn nhận, không bằng lúc tác vụ chạy. | UC-16, UC-17 |
| Buyer đóng sớm rồi nhờ chia khi hai hộ lần lượt nhận tối đa 60 và 40 trên yêu cầu 100 | Không sửa được báo giá; hàng chờ có một mục; phương án chỉ hợp lệ khi phân bổ tổng 100, từng hộ không vượt khả năng. | UC-17, UC-20, UC-21 |
| Hai báo giá chỉ đáp ứng tổng 90 trên yêu cầu 100 đã đóng nhận | Không lập/chấp nhận phương án thiếu; không sửa số lượng yêu cầu xuống 90; Buyer có thể hủy và tạo mới. | UC-20, UC-21, UC-27 |
| Buyer gửi lại thao tác chấp nhận hoặc chấp nhận đồng thời hai lựa chọn | Chỉ một kết quả được chốt, đúng tổng số lượng; không tạo phần việc trùng hoặc hai phương án đã chấp nhận. | UC-19, UC-22 |
| Hộ trong phương án bị tạm ngừng rồi hoạt động lại | Phương án hết hiệu lực không tự khôi phục; báo giá được xét lại theo thời hạn; các phần việc đã chốt vẫn thực hiện được. | UC-04, UC-18, UC-21, UC-23 |
| Mọi hộ báo đã giao nhưng Buyer chưa xác nhận | Yêu cầu vẫn `In Production`; không tự hoàn tất. Admin chỉ xác nhận thay khi có lý do và căn cứ nhận đủ. | UC-24–UC-26 |
| Admin hủy sau khi hộ báo giao, trước xác nhận nhận đủ | Giữ tiến độ và lịch sử, chặn xác nhận tiếp; không hủy được nếu yêu cầu đã `Delivered`. | UC-25–UC-27 |
| Artisan gọi trực tiếp chi tiết phương án hoặc phần việc của hộ khác | Máy chủ từ chối hoặc chỉ trả phần dữ liệu được phép; không lộ đơn giá và phân bổ của hộ khác. | UC-18, UC-23 |

## 5. Giới hạn đặc tả

Chưa chọn làng nghề, công đoạn nhật ký và phân loại cụ thể. Cơ chế đăng nhập chi tiết, định danh tài khoản và yêu cầu mật khẩu sẽ được chốt ở đặc tả xác thực; các use case không mặc định có OTP, email hoặc SMS. Khóa đăng nhập khẩn cấp, thay hộ, sửa đơn đã chốt, giao thiếu, tranh chấp và thanh toán không được bổ sung thành luồng trong tài liệu này.
