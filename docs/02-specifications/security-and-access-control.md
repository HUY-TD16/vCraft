# Bảo mật, xác thực và phân quyền

Áp dụng cho vCraft tại làng gốm Bát Tràng. Căn cứ: [phạm vi](../01-project-brief/project-scope.md), [quy tắc nghiệp vụ](business-rules.md) và [use case](use-cases.md). Chính sách tài khoản đã chốt tại BR-01 được giữ nguyên; tài liệu này bổ sung cách thực thi và tiêu chí kiểm tra bảo mật.

## 1. Nguyên tắc nền tảng

- **SEC-01 — Mặc định từ chối:** Chỉ cho phép hành động được định nghĩa rõ. Quyền hợp lệ phải đồng thời thỏa vai trò, quan hệ với bản ghi, các trường được thao tác và trạng thái nghiệp vụ. Admin không có quyền bỏ qua toàn bộ quy tắc.
- **SEC-02 — Kiểm tra phía máy chủ:** Mọi API, ảnh, lịch sử và tác vụ nền đều áp dụng quyền tương ứng. Ẩn nút, URL khó đoán hoặc kiểm tra ở frontend không thay thế kiểm tra quyền. Không tin `role`, `user_id`, `workshop_id`, giá tổng, trạng thái hoặc người thực hiện do client khai báo.
- **SEC-03 — Quyền tối thiểu:** MVP mỗi tài khoản có một vai trò, mỗi hộ có một Artisan. Không có chức năng tự đổi vai trò/chủ hộ hoặc Admin đăng nhập giả danh người khác. Người vận hành hạ tầng không phải vai trò nghiệp vụ thứ tư trong ứng dụng.
- **SEC-04 — Bảo vệ nhiều lớp:** Dùng kiểm tra đầu vào, phân quyền, giao dịch, giới hạn tài nguyên và nhật ký cùng nhau. Lỗi kiểm tra quyền hoặc không đọc được trạng thái bảo mật phải từ chối, không mặc định cho qua.

Thiết kế quyền dựa trên nguyên tắc của [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html). Các mã SEC bên dưới là yêu cầu của dự án, không phải tuyên bố ứng dụng đã được kiểm thử hoặc không thể bị tấn công.

## 2. Xác thực và quản lý phiên — SEC-05

### 2.1. Tài khoản và mật khẩu

| Nội dung | Quy định |
| --- | --- |
| Đăng nhập | Tên đăng nhập/mật khẩu cho Buyer, Artisan, Admin; chưa có OTP, email/SMS, đăng nhập mạng xã hội. |
| Tên đăng nhập | 4–32 ký tự ASCII chữ, số, dấu chấm, gạch dưới. Bỏ khoảng trắng hai đầu, chuyển chữ thường rồi kiểm tra duy nhất/đăng nhập; không tự đổi tên. Ràng buộc duy nhất đặt cả ở cơ sở dữ liệu. |
| Mật khẩu thường | 12–128 ký tự, cho phép khoảng trắng; không tự cắt hoặc chuẩn hóa. Mật khẩu xác nhận phải trùng, mật khẩu mới khác hiện tại. Không ép đổi định kỳ khi không có sự cố. |
| Lưu mật khẩu | Dùng Argon2id qua thư viện được duy trì, salt ngẫu nhiên riêng. Cấu hình khởi điểm `m=19 MiB, t=2, p=1`; đo tải trước triển khai, không tự giảm dưới mức này. Lưu định dạng có thông tin thuật toán/tham số để nâng cấp khi đăng nhập. Không dùng MD5/SHA thuần, mã hóa đảo ngược hoặc bản rõ. |
| Buyer | Tự đăng ký với tên hiển thị, số điện thoại (ràng buộc độ dài và định dạng theo BR-01); máy chủ luôn gán vai trò Buyer. Số điện thoại chưa xác minh không đủ để khôi phục tài khoản. |
| Artisan/Admin ban đầu | Artisan do Admin cấp sau xác minh ngoài hệ thống; Admin ban đầu do người vận hành tạo. Sinh mật khẩu tạm bằng bộ sinh số ngẫu nhiên mật mã, ít nhất 16 ký tự, hết hạn 24 giờ, buộc đổi trước nghiệp vụ. |
| Bàn giao mật khẩu tạm | Chỉ trả một lần trong phản hồi không lưu cache; chỉ giữ bản băm. Không gửi trong URL/log/analytics. Mất phản hồi hoặc hết hạn phải cấp lại; mật khẩu tạm trước mất hiệu lực. Không lưu bản rõ để phục vụ gửi lại thao tác. |

Cấu hình băm theo [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Ngưỡng độ dài và quy trình tài khoản là lựa chọn MVP đã có trong BR-01.

### 2.2. Phiên đăng nhập

- Chọn **phiên lưu phía máy chủ**, frontend và API cùng origin qua reverse proxy. Trình duyệt chỉ giữ mã phiên ngẫu nhiên tối thiểu 256 bit trong cookie `__Host-vcraft-session; Secure; HttpOnly; SameSite=Lax; Path=/`, không đặt `Domain`. Không lưu mã phiên trong URL, `localStorage` hoặc `sessionStorage`; không dùng JWT để thay cơ chế thu hồi phiên trong MVP.
- Lưu phiên bằng kho dùng chung giữa các instance, chỉ lưu bản băm mã phiên cùng tài khoản, thời điểm tạo, hoạt động cuối và mức phiên. Cấp mã phiên mới sau xác thực; không nâng quyền bằng cách giữ mã phiên khách cũ. Không chấp nhận mã phiên do client tự đặt.
- Phiên thường hết hạn khi không hoạt động 30 phút hoặc sau tối đa 12 giờ từ đăng nhập, lấy mốc tới trước. Phiên mật khẩu tạm tối đa 15 phút, chỉ được đổi mật khẩu hoặc đăng xuất; chặn cả API đọc nghiệp vụ. Thời hạn mật khẩu tạm vẫn phải còn hiệu lực khi đổi.
- Đăng xuất thu hồi phiên hiện tại ở máy chủ và xóa cookie. Đổi/đặt lại mật khẩu thu hồi tất cả phiên, buộc đăng nhập lại. Thu hồi/khóa bảo mật có hiệu lực ở yêu cầu tiếp theo; không chỉ xóa cookie trên một thiết bị.
- Kiểm tra trạng thái tài khoản và quyền hiện hành mỗi request riêng tư. Hộ tạm ngừng vẫn có phiên hợp lệ; trạng thái vận hành hộ không đồng nghĩa khóa tài khoản. Đặt lại mật khẩu không tự mở khóa hoặc đổi vai trò.

Lựa chọn cookie và thu hồi phiên dựa trên [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

### 2.3. Đổi, đặt lại và chống đoán mật khẩu

- Đổi chủ động cần mật khẩu hiện tại. Admin chỉ đặt lại cho Buyer/Artisan sau xác minh ngoài hệ thống, có lý do/căn cứ và xác nhận mật khẩu Admin hiện tại trong chính thao tác. Không cho Admin đặt lại tài khoản Admin qua API này. Khôi phục Admin do người vận hành xác minh và thực hiện ngoài ứng dụng; có ghi nhận, không tạo mật khẩu mặc định dùng chung.
- Lưu băm mới, thu hồi phiên và nhật ký đặt lại trong cùng giao dịch. Nếu lưu nhật ký bắt buộc thất bại, không báo đặt lại thành công. Các thao tác cấp/đặt lại không có API xem lại mật khẩu.
- Đăng nhập sai trả thông báo chung cho tên không tồn tại, mật khẩu sai hoặc tài khoản không được đăng nhập; không trả nguyên nhân nội bộ. Với tên không tồn tại, thực hiện kiểm tra băm giả tương đương để giảm khác biệt thời gian. Thông báo trùng tên khi đăng ký được giữ theo UC-01 nhưng phải giới hạn tần suất.
- Giữ giới hạn BR-01: **5 lần sai/15 phút cho cặp IP–tên chuẩn hóa** thì chặn cặp 15 phút; **30 lần sai/15 phút cho một IP trên mọi tên** thì chặn xác thực mật khẩu từ IP đó 15 phút. Áp dụng cả tên không tồn tại và xác nhận mật khẩu khi đổi/đặt lại; tính theo tài khoản đang xác thực, không phải tài khoản đích.
- Thành công chỉ xóa bộ đếm cặp tương ứng, không xóa bộ đếm chung IP. Lượt thử khi đang chặn không kéo dài thời gian chặn. Không khóa toàn cục tài khoản hoặc thu hồi phiên đang hợp lệ chỉ vì thử sai từ xa. Bộ đếm dùng chung, cập nhật nguyên tử giữa các instance; không chỉ lưu trong trình duyệt hoặc RAM từng tiến trình.
- IP lấy từ kết nối hoặc proxy đã cấu hình tin cậy; không tin `X-Forwarded-For` tùy ý. Khi chặn trả `429` và thời gian thử lại. Giới hạn này không tự ngăn được bot phân tán; theo dõi dấu hiệu bất thường theo SEC-15.

## 3. Ma trận quyền thao tác

“Của mình” là Buyer sở hữu bản ghi hoặc Artisan thuộc hộ sở hữu. “Theo BR” nghĩa là vẫn phải kiểm tra trạng thái, thời hạn, phiên bản và dữ liệu bắt buộc. Khách không có quyền ghi; chỉ có quyền đọc công khai ở mục 4 và đăng ký/đăng nhập.

| Thao tác | Buyer | Artisan | Admin | Ràng buộc |
| --- | --- | --- | --- | --- |
| Đổi mật khẩu | Của mình | Của mình | Của mình | Mật khẩu hiện tại; thu hồi mọi phiên. |
| Cấp tài khoản Artisan | Không | Không | Có | Xác minh hộ, một tài khoản/hộ; không tạo Admin qua API này. |
| Đặt lại mật khẩu | Không tự đặt lại | Không tự đặt lại | Buyer/Artisan | Xác minh + lý do/căn cứ + mật khẩu Admin. |
| Tạm ngừng/hoạt động lại hộ | Không | Không | Có | BR-05; không giả lập khóa đăng nhập. |
| Tạo hồ sơ xưởng ban đầu | Không | Không | Khi cấp hộ | Không có quyền sửa thay nội dung sau tạo. |
| Sửa hồ sơ, đón khách | Không | Hộ mình | Không | BR-10, BR-28. |
| Quản lý sản phẩm, lô, nhật ký, công bố | Không | Hộ mình | Không | BR-07–BR-09; quyền đọc lịch sử không tạo quyền sửa. |
| Quản lý phân loại/tin tức | Không | Không | Có | BR-06, BR-29. |
| Tạo/sửa/xóa nháp, sao chép yêu cầu | Của mình | Không | Không | Nháp chỉ xóa; không hủy. Sao chép không mang theo quan hệ cũ. |
| Gửi, đóng nhận, nhờ chia | Của mình | Không | Không | BR-11–BR-13, BR-17. |
| Sửa tên/điện thoại người nhận | Của mình | Không | Không | Chưa hủy/Delivered; có lịch sử. Không đổi điều kiện thương mại/địa chỉ. |
| Không tham gia yêu cầu | Không | Hộ mình được mời | Không | Chưa từng báo giá, còn mở; kể cả hộ tạm ngừng. |
| Gửi/sửa/gửi lại báo giá | Không | Hộ mình được mời | Không | Còn mở, hộ hoạt động, chưa chốt/hủy; BR-14–BR-15. |
| Rút báo giá | Không | Báo giá của mình | Không | Chưa chốt/hủy; có lý do, kể cả đóng nhận hoặc hộ tạm ngừng. |
| Lập/thay phương án chia | Không | Không | Có | Trong hàng chờ; ít nhất hai hộ, đủ số lượng; BR-17–BR-18. |
| Chấp nhận giá/phương án, từ chối phương án | Của mình | Không | Không | Buyer quyết định cuối; BR-16, BR-19–BR-20. |
| Bắt đầu phần việc, liên kết lô | Không | Phần việc hộ mình | Không | Nhiều lô cùng hộ, số lượng hợp lệ; BR-24. |
| Ghi nhận bàn giao | Không | Phần việc hộ mình | Ngoại lệ có căn cứ | Đang sản xuất, chưa hủy; Admin không tự tạo bước bắt đầu hoặc sửa liên kết lô. |
| Xác nhận nhận đủ | Của mình | Không | Ngoại lệ có căn cứ | Mọi phần việc đã ghi nhận bàn giao; BR-25. |
| Hủy trước chấp nhận | Của mình | Không | Không | Chỉ Sent to Artisans/Artisans Bidding. |
| Hủy sau chấp nhận | Không | Không | Có | Chưa Delivered, có lý do và xử lý hàng đã bàn giao; BR-21–BR-22. |
| Sửa/xóa lịch sử hoặc sửa điều kiện đã chốt | Không | Không | Không | Không có API thực hiện. |

Tạm ngừng hộ không chặn hoàn thành việc đã chốt, rút giá hoặc phản hồi không tham gia theo BR-15. Không suy diễn rằng mọi quyền ghi của hộ bị khóa.

## 4. Dữ liệu công khai và quyền đọc từng bản ghi

| Dữ liệu | Công khai | Quyền đọc riêng tư |
| --- | --- | --- |
| Tài khoản, số điện thoại đăng ký | Không | Chủ tài khoản; Admin chỉ trường cần cho cấp/đặt lại Buyer/Artisan. Không cho liệt kê người dùng qua API công khai. |
| Băm mật khẩu, mã phiên, bí mật hệ thống | Không | Không vai trò nghiệp vụ nào được nhận; chỉ thành phần xác thực xử lý. Mật khẩu tạm chỉ có ngoại lệ bàn giao một lần tại mục 2. |
| Hồ sơ xưởng, ảnh/chứng nhận | Hộ hoạt động và đủ điều kiện BR-28 | Artisan hộ mình; Admin xem để quản lý hộ. Chỉ công khai trường nội dung hồ sơ, không kèm tên đăng nhập hoặc dữ liệu tài khoản. |
| Sản phẩm | Công bố và hộ hoạt động | Artisan hộ mình; Admin không mặc nhiên được duyệt toàn bộ nháp sản phẩm. |
| Lô, nhật ký hiện hành | Chỉ lô đã công bố | Artisan chủ lô; Admin xem để đối chiếu nhật ký theo BR-08. Buyer có phần việc cũng không được mở lô nháp chỉ vì lô đã được liên kết. |
| Lịch sử sửa nhật ký và ảnh cũ | Không | Artisan chủ lô và Admin. Không mở cho Buyer qua QR hoặc liên kết phần việc. |
| Phân loại, tin tức | Phân loại dùng trong danh mục; tin đã công bố | Admin quản lý; tin nháp chỉ Admin. |
| Yêu cầu nháp | Không | Buyer sở hữu và Admin theo quyền xem yêu cầu BR-04; Admin không sửa/gửi thay. |
| Yêu cầu đã gửi | Không | Buyer sở hữu và Admin xem đầy đủ; hộ thuộc danh sách nhận chỉ xem quy cách, phân loại, số lượng, đơn vị, thời hạn, hình thức nhận, khu vực giao khái quát. |
| Tên/điện thoại người nhận, địa chỉ chi tiết, lịch sử liên hệ | Không | Buyer sở hữu, Admin và chỉ hộ đã có phần việc chốt của yêu cầu. Giữ quyền đọc cho hộ này sau hoàn tất/hủy; không mở cho hộ chỉ được mời. |
| Danh sách hộ nhận, phản hồi, báo giá | Không | Buyer sở hữu yêu cầu và Admin xem toàn bộ; Artisan chỉ phản hồi/báo giá của hộ mình, không xem danh sách đối thủ. |
| Phương án tổng thể, hàng chờ chia | Không | Admin; Buyer chỉ phương án yêu cầu của mình, không xem hàng chờ toàn hệ thống. Artisan không xem phương án tổng thể. |
| Phần việc, lịch sử tiến độ | Không | Buyer sở hữu yêu cầu, Admin và Artisan đúng hộ được giao. Không trả phần việc/đơn giá của hộ khác cho Artisan. |
| Căn cứ Admin ghi nhận/xác nhận thay | Không | Buyer sở hữu, Admin; Artisan chỉ phần dữ liệu gắn với phần việc của hộ. Căn cứ cấp yêu cầu phải lọc bỏ thông tin hộ khác trước khi cho Artisan xem. |
| Ảnh chờ gắn, ảnh nháp, ảnh lịch sử | Không | Chủ ảnh đúng ngữ cảnh hoặc người có quyền đọc đối tượng tương ứng; áp dụng cả ảnh thu nhỏ và ảnh hiển thị. |

**Ngoại lệ QR:** Lô đã công bố vẫn truy xuất được khi hộ tạm ngừng. Chỉ giữ tên xưởng dạng văn bản nếu hồ sơ bị ẩn; không trả dữ liệu hồ sơ bị ẩn, thông tin Buyer, địa chỉ bàn giao, giá báo chào, yêu cầu mua sỉ hoặc căn cứ riêng tư.

**Lịch sử không làm rộng quyền:** API lịch sử liên hệ, phiên bản báo giá, căn cứ và tệp đính kèm phải lọc giống dữ liệu hiện hành. Không trả đối tượng đầy đủ rồi để frontend giấu trường. Nếu một ảnh từng được công khai, việc chuyển nó sang lịch sử riêng tư chỉ chặn các truy cập mới; không thể thu hồi bản đã được khách tải về.

## 5. Cách thực thi quyền trên máy chủ — SEC-06

1. Xác thực phiên; kiểm tra hết hạn, thu hồi, khóa bảo mật và giới hạn phiên đổi mật khẩu tạm.
2. Lấy `user_id`, vai trò và hộ liên kết từ dữ liệu máy chủ. Kiểm tra quyền hành động trước khi đọc nội dung riêng tư.
3. Truy vấn theo quan hệ bản ghi: `request.buyer_id = current_user.id`; hoặc `record.workshop_id = current_user.workshop_id`; hoặc tồn tại lời mời/phần việc theo đúng loại dữ liệu. ID nằm trong URL/body chỉ là đối tượng được yêu cầu, không phải bằng chứng quyền.
4. Với quan hệ lồng nhau, kiểm tra toàn bộ chuỗi: báo giá thuộc đúng yêu cầu; phần việc thuộc đúng yêu cầu và hộ; các lô thuộc hộ; ảnh thuộc người tải và đúng đối tượng. Không chỉ kiểm tra ID cuối cùng.
5. Với request ghi, nhận danh sách trường cho phép riêng cho từng thao tác. Từ chối trường ngoài schema; người dùng không được tự đổi chủ sở hữu, vai trò, trạng thái, tổng tiền, người xác nhận hoặc dấu thời gian hệ thống. Tiến độ chỉ đổi qua hành động đã định nghĩa.
6. Sau kiểm tra quyền, xử lý gửi lặp theo BR-27; khóa định danh thao tác theo tài khoản + hành động + đối tượng. Không trả kết quả đã lưu cho tài khoản khác dù biết định danh. Khi trả lại kết quả vẫn lọc theo quyền hiện tại, không khôi phục phiên hoặc phát lại mật khẩu tạm.
7. Thao tác mới kiểm tra phiên bản, điều kiện thời gian và trạng thái trong giao dịch; lưu kết quả nghiệp vụ, thông tin gửi lặp và lịch sử bắt buộc nhất quán. Tổng tiền tính bằng dữ liệu báo giá máy chủ.
8. Chỉ trả tập trường được phép. Bộ lọc, tìm kiếm, phân trang, tổng số bản ghi và tệp tải về đều dùng cùng điều kiện quyền.

API riêng tư chưa đăng nhập trả `401`; hành động không được phép trả `403`; bản ghi không được quyền biết tồn tại trả `404` chung. Phiên bản/định danh thao tác xung đột trả `409`; vượt giới hạn trả `429`. Không trả stack trace, câu SQL, đường dẫn máy chủ hoặc chi tiết bí mật trong thông báo lỗi.

## 6. Phòng chống tấn công

### SEC-07 — Chèn lệnh và sửa trường ngoài quyền

- Mọi truy vấn dữ liệu dùng tham số hoặc ORM an toàn; không ghép chuỗi từ input vào SQL/NoSQL. Cột sắp xếp, toán tử và bộ lọc lấy từ danh sách cho phép; ORM không bảo vệ truy vấn raw tự ghép.
- Kiểm tra kiểu, độ dài, khoảng giá trị và quan hệ ở máy chủ; từ chối số âm, số không hữu hạn và cấu trúc không mong đợi. Không dùng `eval`, deserialize đối tượng thực thi hoặc đưa input vào câu lệnh shell.
- Tên tệp/path lưu trữ do hệ thống sinh. Không nối đường dẫn người dùng cung cấp vào thao tác đọc/xóa tệp; không cho đọc `.env`, bản sao lưu hoặc thư mục khác qua tham số tải ảnh.

Tham chiếu: [OWASP SQL Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html).

### SEC-08 — XSS và nội dung do người dùng nhập

- Mặc định lưu câu chuyện xưởng, quy cách, công đoạn, lý do và tin tức dưới dạng văn bản; render bằng cơ chế escape theo ngữ cảnh của framework. Không đưa trực tiếp vào HTML, script, thuộc tính sự kiện hoặc CSS.
- Nếu bổ sung trình soạn thảo giàu định dạng, phải dùng thư viện sanitize với danh sách thẻ/thuộc tính cho phép ở máy chủ; không tự lọc bằng regex. Liên kết chỉ nhận giao thức cho phép, không `javascript:` hoặc nội dung nhúng tùy ý.
- Áp dụng cho cả màn hình Admin, lịch sử và popup bản đồ. Dữ liệu Admin nhập vẫn phải kiểm tra. CSP hỗ trợ giảm thiệt hại, không thay thế escape/sanitize.

XSS có thể đọc CSRF token nếu token nằm trong DOM hoặc biến JavaScript — hai lớp bảo vệ này phụ thuộc nhau: CSP và sanitize tốt là điều kiện để CSRF token có hiệu lực, không phải hai lựa chọn thay thế.

Tham chiếu: [OWASP XSS Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html).

### SEC-09 — CSRF, CORS và giả mạo thao tác

- Các request thay đổi dữ liệu dùng POST/PUT/PATCH/DELETE và token CSRF gắn với phiên; áp dụng cả upload, đăng xuất, đổi/đặt lại mật khẩu. Đăng nhập/đăng ký dùng cơ chế chống CSRF của framework với phiên trước xác thực; hủy phiên này khi đăng nhập thành công. MVP dùng **per-session token** (một token/phiên, cấp mới khi tạo phiên và thay toàn bộ khi đổi/đặt lại mật khẩu); token không được lưu trong cookie có thể đọc bằng JS — chỉ truyền qua response header hoặc body API và gắn vào request header phía client. Nếu chuyển sang SPA với per-request token thì phải cập nhật tài liệu này.
- Kiểm tra `Origin` theo danh sách cho phép, dùng `Referer` cùng origin làm phương án kiểm tra khi cần; không bỏ qua token vì cookie có `SameSite`. Không dùng GET để chấp nhận giá, công bố, hủy hoặc đổi trạng thái do người dùng yêu cầu.
- MVP cùng origin không cần mở CORS. Nếu kiến trúc thay đổi, chỉ cho origin cụ thể; không phản chiếu origin tùy ý, không dùng `*` cùng credentials. CORS không phải cơ chế xác thực và không chặn người gọi API trực tiếp.

Tham chiếu: [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

### SEC-10 — Upload và quyền truy cập ảnh

- Giữ JPG/PNG/WebP, 5 MB/ảnh và 10 ảnh/sản phẩm hoặc mốc. Kiểm tra đuôi, MIME, chữ ký và giải mã ảnh thực tế; từ chối SVG, HTML, tệp thực thi, ảnh hỏng và tệp nhiều khung hình. Không tin `Content-Type` của client.
- Giới hạn thêm 25 triệu pixel/ảnh và thời gian xử lý 10 giây/ảnh; xử lý trong worker có giới hạn CPU/RAM và hàng đợi hữu hạn. Xoay ảnh trước khi bỏ metadata, loại EXIF/GPS, mã hóa lại ảnh an toàn; tạo bản 320 px/1600 px theo BR. Không phục vụ trực tiếp tệp upload chưa xử lý.
- Kho ảnh ngoài thư mục thực thi, không có quyền chạy tệp. Dùng khóa lưu trữ ngẫu nhiên; không dùng tên gốc làm đường dẫn. Chỉ gắn ảnh đã xử lý đúng chủ/ngữ cảnh, không cho dùng mã ảnh hộ khác.
- MVP đọc ảnh qua cổng kiểm tra quyền phía máy chủ; kho lưu trữ không cho truy cập công khai trực tiếp. Mọi phiên bản ảnh và ảnh lịch sử đều kiểm tra quyền. Công khai ảnh chỉ khi có đối tượng hiện hành cho phép công khai; không có quyền công khai vĩnh viễn chỉ vì trước đây từng dùng.
- Dọn ảnh không tham chiếu sau 24 giờ; kiểm tra lại tham chiếu trong lúc dọn, giữ ảnh lịch sử BR-08. Không dùng mã ảnh/URL để bỏ qua quyền của lô nháp.

Tham chiếu: [OWASP File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html). Giới hạn pixel/thời gian là cấu hình khởi điểm của vCraft, cần kiểm tra trên hạ tầng triển khai.

### SEC-11 — SSRF và dịch vụ bên ngoài

- Không có chức năng để máy chủ tải ảnh hoặc nội dung từ URL tùy ý do người dùng nhập. Ảnh được upload; QR sinh cục bộ từ origin cấu hình cố định, không từ `Host`/URL client tùy ý.
- Tích hợp bản đồ dùng nhà cung cấp và hostname đã cấu hình. Không biến API thành proxy URL tự do. Không gửi dữ liệu Buyer, địa chỉ giao chi tiết hoặc mã phiên tới bản đồ/analytics.
- Nếu cần gọi dịch vụ từ backend: chỉ HTTPS tới host/port cho phép, đặt timeout; kiểm tra IP đích sau phân giải DNS, chặn loopback, mạng nội bộ, link-local và metadata hạ tầng cả IPv4/IPv6. Tắt redirect hoặc kiểm tra lại từng đích; hạn chế mạng đầu ra tại hạ tầng.

Tham chiếu: [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

### SEC-12 — HTTPS, cấu hình và bí mật

- Môi trường triển khai dùng HTTPS toàn bộ, TLS 1.2 trở lên; chuyển HTTP sang HTTPS, bật HSTS sau khi xác nhận tên miền dùng HTTPS. Không tắt kiểm tra chứng chỉ dịch vụ ngoài.
- Thiết lập CSP theo nguồn thực sự dùng: mặc định cùng origin, script bằng nonce/hash hoặc nguồn cụ thể; `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, `form-action 'self'`. Không cho `unsafe-eval` hoặc nới `*` để chạy bản đồ. Thêm `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
- API riêng tư, phản hồi tài khoản/mật khẩu tạm và ảnh có kiểm tra quyền dùng `Cache-Control: no-store`; không cache chung theo URL giữa người dùng. MVP cũng không cache nội dung/ảnh có thể bị ẩn tại CDN. Tài nguyên tĩnh của ứng dụng có thể cache theo hash.
- Tắt debug, danh sách thư mục, tài khoản mẫu và trang quản trị cơ sở dữ liệu công khai. Khóa bí mật nằm trong cấu hình triển khai/kho bí mật, không commit, nhúng frontend hoặc ghi log. Khóa bản đồ dùng ở trình duyệt phải giới hạn origin, API và quota; không dùng khóa backend làm khóa công khai.
- **API chỉ nhận và trả `Content-Type: application/json`; không để trả plain text hoặc HTML từ endpoint JSON.** Tệp tải về gắn `Content-Disposition: attachment` và MIME đúng loại tệp; không để browser tự suy luận kiểu nội dung.
- Tách môi trường dev/test/triển khai, tài khoản DB và kho tệp. Runtime chỉ có quyền đọc/ghi cần thiết, không dùng DB root hoặc quyền thay schema; migration dùng tài khoản riêng. Dữ liệu thử nghiệm không sao chép thông tin cá nhân thật.

Tham chiếu: [OWASP HTTP Headers](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html).

### SEC-13 — Toàn vẹn nghiệp vụ và cập nhật đồng thời

- Dùng giao dịch cùng ràng buộc DB: tên đăng nhập duy nhất, một Artisan/hộ, tối đa một báo giá/hộ/yêu cầu, không trùng phần việc được sinh khi chấp nhận, không trùng lô trong liên kết phần việc. Kiểm tra tổng số lượng, tiền và điều kiện thời hạn ở máy chủ.
- Chấp nhận/rút báo giá, hủy/ghi nhận bàn giao, tạm ngừng/chấp nhận phải được điều phối nhất quán. Khóa/version/điều kiện ghi bảo đảm chỉ kết quả hợp lệ được chốt; không kiểm tra ngoài giao dịch rồi ghi mù.
- Nhiều lô của phần việc phải cùng hộ, tổng số lượng liên kết không vượt phần việc; không đổi liên kết sau ghi nhận bàn giao. Không giả định có tồn kho hoặc giữ chỗ công suất nếu chưa thiết kế.
- Admin ghi nhận thay phải lưu người thực hiện thực tế, lý do/căn cứ và mốc thời gian; không giả danh Buyer/Artisan hoặc tự tạo bước sản xuất. Lịch sử bắt buộc được lưu cùng thay đổi nghiệp vụ; không có API sửa/xóa lịch sử.

### SEC-14 — Giới hạn tài nguyên và xử lý lỗi

Các ngưỡng dưới đây là cấu hình MVP ban đầu, phải có giới hạn cứng ở máy chủ và được đo lại khi triển khai; không thay các ngưỡng xác thực BR-01.

| Tài nguyên | Giới hạn khởi điểm |
| --- | --- |
| Đăng ký | 5 yêu cầu/phút/IP; vẫn kiểm tra duy nhất ở DB. |
| API đọc nghiệp vụ | 120 yêu cầu/phút/tài khoản; phân trang tối đa 100 bản ghi/trang. |
| API ghi nghiệp vụ | 60 yêu cầu/phút/tài khoản; không tính request upload trong nhóm này. |
| Upload | 20 ảnh/phút/tài khoản, 2 ảnh xử lý đồng thời/tài khoản; mỗi request một ảnh, body tối đa 6 MiB gồm multipart. |
| API công khai | 300 yêu cầu/phút/IP, tách ngân sách ảnh 600/phút/IP. |
| JSON API | Body tối đa 1 MiB; schema giới hạn chuỗi/mảng theo từng endpoint. |
| Request thông thường | Timeout máy chủ 15 giây; tác vụ ảnh có giới hạn riêng SEC-10. |

Trả `413` khi body quá lớn, `429` khi quá tần suất; không gom tải lại thành vòng lặp vô hạn. Kho phiên/giới hạn không hoạt động thì tạm từ chối thao tác cần kiểm soát, không cho truy cập không giới hạn. **Khi store rate-limit (Redis hoặc tương đương) không truy cập được, xác thực mật khẩu bị chặn (fail-closed); không để pass-through dù tạm thời.** Lỗi DB/worker phải trả lỗi có mã tra cứu, rollback thao tác chưa hoàn tất; không lộ lỗi nội bộ. Không ghi trạng thái thành công trước khi commit.

### SEC-15 — Nhật ký, giám sát và xử lý sự cố

- Ghi xác thực thất bại/giới hạn, tạo/thu hồi phiên, cấp/đặt lại tài khoản, từ chối quyền bất thường, thay trạng thái hộ và thao tác Admin nhạy cảm. Mỗi sự kiện có thời gian máy chủ, loại, kết quả, tài khoản nếu biết, đối tượng, IP tin cậy và mã request.
- Không ghi mật khẩu, băm mật khẩu, cookie, token CSRF, khóa bí mật, toàn bộ body hoặc địa chỉ/điện thoại vào log kỹ thuật. Lịch sử liên hệ và căn cứ nghiệp vụ có dữ liệu riêng được lưu riêng theo BR, áp dụng quyền mục 4. Dữ liệu log phải có cấu trúc và escape ký tự điều khiển để không chèn dòng giả.
- Người vận hành xem log kỹ thuật; Admin xem lịch sử nghiệp vụ đúng quyền, không nhận quyền tải toàn bộ log máy chủ. Runtime không được sửa/xóa sự kiện audit; tài khoản bảo trì riêng mới được quản lý lưu trữ theo quy trình.
- Thiết lập cảnh báo vận hành khi vượt ngưỡng xác thực nhiều nguồn, tăng lỗi phân quyền/upload, mất kho phiên hoặc gián đoạn ghi log. Cảnh báo tới kênh vận hành, không thêm tính năng thông báo khách hàng/email/SMS vào MVP.
- Khi phát hiện tài khoản bị chiếm: người vận hành xác minh, khóa đăng nhập bảo mật và thu hồi toàn bộ phiên, giữ bằng chứng; sau xử lý mới mở khóa riêng. Không dùng tạm ngừng hộ thay biện pháp này, không tự sửa phần việc đang chạy.
- Ghi log kỹ thuật bị gián đoạn phải có tín hiệu sức khỏe và bộ đệm giới hạn; không làm đầy đĩa. Riêng lịch sử bắt buộc cho đặt lại mật khẩu, chấp nhận, hủy, ghi nhận/xác nhận thay: không lưu được thì rollback nghiệp vụ.

Tham chiếu: [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).

### SEC-16 — Thư viện, triển khai và phục hồi

- Chốt phiên bản phụ thuộc bằng lockfile, dùng nguồn tin cậy; kiểm tra thư viện trực tiếp và gián tiếp. CI quét dependency và bí mật; không triển khai khi còn lỗi Critical/High ảnh hưởng chức năng đang dùng mà chưa sửa hoặc có biện pháp giảm thiểu được ghi nhận. **Tài nguyên tĩnh tải từ CDN hoặc nguồn ngoài phải có Subresource Integrity (SRI) hash; không tải script/style bên ngoài mà không có `integrity` attribute.**
- Review thay đổi xác thực, phân quyền, migration, pipeline và dependency. Build từ revision đã duyệt; CI dùng quyền tối thiểu, không cấp secret triển khai cho mã từ nguồn không tin cậy. Chỉ deploy artifact do pipeline tin cậy tạo, kiểm tra digest trước dùng.
- Sao lưu DB và ảnh/lịch sử cần thiết hằng ngày, mã hóa bản sao và giới hạn người đọc; khóa mã hóa tách khỏi bản sao. Cấu hình lưu 30 ngày cho backup, 90 ngày cho log kỹ thuật ở MVP. Đây là thời hạn vận hành, không xóa lịch sử nghiệp vụ đang được tham chiếu.
- Thử phục hồi trước khi đưa lên môi trường triển khai và sau thay đổi lớn. Sau phục hồi phải thu hồi phiên đã khôi phục, đối chiếu ảnh/lịch sử, không tự chạy lại thao tác chấp nhận đã thành công. Lộ secret phải thay khóa và thu hồi thông tin cũ, không chỉ xóa khỏi commit mới.

## 7. Đối chiếu 10 nhóm rủi ro OWASP

Khung tham chiếu là [OWASP Top 10:2025](https://top10.owasp.org/2025/). Đây là 10 nhóm rủi ro, không phải danh sách chỉ gồm 10 kiểu tấn công đơn lẻ.

| Nhóm | Yêu cầu của vCraft |
| --- | --- |
| A01 — Kiểm soát truy cập bị phá vỡ | SEC-01–SEC-03, SEC-06, SEC-09, SEC-11: quyền bản ghi/trường, chống IDOR, CSRF, SSRF. |
| A02 — Cấu hình bảo mật sai | SEC-12, SEC-14: HTTPS, cookie, CORS, CSP, tắt debug và giới hạn. |
| A03 — Lỗi chuỗi cung ứng phần mềm | SEC-16: nguồn phụ thuộc, lockfile, CI và artifact tin cậy. |
| A04 — Lỗi mật mã | SEC-05, SEC-12, SEC-16: băm mật khẩu, truyền mã hóa, quản lý khóa/backup. |
| A05 — Chèn mã/lệnh | SEC-07–SEC-08: truy vấn tham số, escape, sanitize, không thực thi input. |
| A06 — Thiết kế không an toàn | SEC-01–SEC-04, SEC-13–SEC-14: mô hình quyền, giới hạn và bất biến nghiệp vụ. |
| A07 — Xác thực thất bại | SEC-05: mật khẩu, chống đoán, khôi phục và thu hồi phiên. |
| A08 — Mất toàn vẹn dữ liệu/phần mềm | SEC-10, SEC-13, SEC-16: ảnh, giao dịch, lịch sử và artifact. |
| A09 — Thiếu ghi log và cảnh báo | SEC-15: audit, bảo vệ log và cảnh báo vận hành. |
| A10 — Xử lý ngoại lệ không an toàn | SEC-04, SEC-14–SEC-16: từ chối an toàn, rollback, timeout và phục hồi. |

## 8. Tiêu chí nghiệm thu bảo mật

Thực hiện trên môi trường kiểm thử được phép, với ít nhất hai Buyer, hai hộ Artisan, một Admin và khách. Kiểm tra trực tiếp API/tệp, không chỉ kiểm tra nút giao diện.

| Mã | Tình huống | Kết quả bắt buộc |
| --- | --- | --- |
| AT-01 | Buyer/Artisan đổi ID trong URL/body sang bản ghi người khác | Không đọc/sửa được; không lộ dữ liệu qua lỗi, số đếm, lịch sử hoặc thao tác gửi lặp. |
| AT-02 | Gửi thêm `role`, chủ hộ, trạng thái, tổng tiền hoặc người xác nhận | Bị từ chối; không tự nâng quyền hoặc sửa trường hệ thống. |
| AT-03 | Hộ được mời nhưng chưa có phần việc mở yêu cầu/lịch sử | Chỉ thấy dữ liệu mời; không có tên/điện thoại/địa chỉ chi tiết. Sau được chọn mới có quyền; hộ khác vẫn không có. |
| AT-04 | Khách mở QR lô công bố, lô nháp, ảnh cũ và hồ sơ hộ tạm ngừng | Lô công bố còn xem được đúng tập trường; lô nháp/ảnh lịch sử bị chặn; hồ sơ bị ẩn không lộ ngoài tên xưởng trên QR. |
| AT-05 | Mật khẩu tạm gọi API nghiệp vụ; mật khẩu tạm hết hạn | Phiên giới hạn không dùng nghiệp vụ; hết hạn không đổi được bằng mật khẩu tạm cũ. |
| AT-06 | Đăng xuất/đổi/đặt lại rồi dùng cookie cũ; thử phiên trước đăng nhập | Phiên tương ứng bị thu hồi; mã phiên cũ không được nâng thành phiên đăng nhập. |
| AT-07 | Thử sai đúng ngưỡng, tên không tồn tại, giả header IP | Giới hạn đúng BR-01, dùng IP tin cậy; không khóa toàn cục tài khoản hoặc gia hạn chặn mỗi lượt. |
| AT-08 | Gọi API thay đổi dữ liệu không có/sai CSRF token hoặc từ origin khác | Bị chặn; GET không thực hiện hành động ghi của người dùng; CORS không nới wildcard. |
| AT-09 | Chuỗi kiểm thử SQL/NoSQL, lệnh hoặc đường dẫn trong bộ lọc/tên tệp | Được xử lý như dữ liệu hoặc từ chối; không đổi truy vấn, chạy lệnh hoặc đọc tệp ngoài quyền. |
| AT-10 | Nội dung kiểm thử XSS trong xưởng, nhật ký, tin, popup, lịch sử | Không thực thi trong trang khách hoặc Admin; dữ liệu đã escape/sanitize, CSP hoạt động. |
| AT-11 | Upload ảnh giả MIME, SVG, quá dung lượng/pixel; gắn mã ảnh hộ khác | Bị từ chối; không thực thi, không lộ ảnh riêng, không để worker vượt giới hạn. |
| AT-12 | Yêu cầu máy chủ tải URL nội bộ hoặc đổi hostname đích dịch vụ | Không có proxy tùy ý; đích không được phép bị chặn, không truy cập metadata/nội bộ. |
| AT-13 | Rút/chấp nhận, hủy/bàn giao và gửi lặp đồng thời | Một kết quả hợp lệ, đủ lịch sử; không trùng phần việc hoặc chốt báo giá đã rút. |
| AT-14 | Admin sửa xưởng hộ, bắt đầu thay, xác nhận thiếu căn cứ hoặc đặt lại Admin | Bị chặn; quyền Admin không vượt ma trận. Ngoại lệ đúng quyền lưu tên người thực hiện thật. |
| AT-15 | Mất DB/kho phiên, lỗi ghi audit bắt buộc, upload timeout | Từ chối hoặc rollback đúng; không mở quyền, báo thành công giả hay lộ stack trace. |
| AT-16 | Đọc dữ liệu bằng tài khoản khác sau logout, qua cache hoặc URL ảnh cũ | Không lộ dữ liệu riêng; request mới kiểm tra quyền hiện hành, không trả từ cache chung. **Phải chạy lại nếu bật CDN hoặc reverse proxy caching.** |
| AT-17 | Quét dependency/secret và kiểm tra cấu hình triển khai | Không có secret/tài khoản mẫu, lỗi nghiêm trọng chưa xử lý; TLS, cookie, header, quyền DB/kho tệp đúng thiết kế. |
| AT-18 | Phục hồi backup và mô phỏng sự kiện tấn công | Khôi phục được dữ liệu/ảnh/lịch sử; phiên cũ không dùng lại; log đủ đối chiếu, không chứa bí mật; cảnh báo tới người vận hành. |

## 9. Điều kiện hoàn tất thiết kế và triển khai

Tài liệu quy định yêu cầu, chưa chứng minh chúng đã được cài đặt. Khi chọn framework/hạ tầng, phải ánh xạ SEC-01–SEC-16 vào middleware, schema, giao dịch, kho phiên, kho ảnh, cấu hình và kiểm thử tương ứng. Các ngưỡng tài nguyên cần đo tải; mọi điều chỉnh phải cập nhật tài liệu và giữ nguyên quyền nghiệp vụ đã chốt.

MVP chưa có MFA, phòng thủ DDoS quy mô lớn hoặc quản lý tranh chấp. Trước khi vận hành dữ liệu thật cần đánh giá lại các giới hạn này, nhất là bảo vệ tài khoản Admin. Không dùng việc đạt bảng OWASP để tuyên bố hệ thống an toàn tuyệt đối.
