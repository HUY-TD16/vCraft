# Đặc tả use case vCraft

Căn cứ: [phạm vi dự án](../01-project-brief/project-scope.md), [quy tắc nghiệp vụ](business-rules.md) và [đề bài](../01-project-brief/vCraft.md).

## 1. Quy ước chung

- Bối cảnh chung là làng gốm Bát Tràng. Hộ/xưởng là hộ sản xuất gốm; sản phẩm và lô là sản phẩm gốm và lô của hộ. Phân loại, công đoạn mẫu và quy cách mua sỉ theo mục 1 của [phạm vi dự án](../01-project-brief/project-scope.md).
- Khách là người xem công khai, không cần tài khoản. Buyer, Artisan và Admin phải đăng nhập để thực hiện nghiệp vụ tương ứng. Admin là đại diện Ban quản lý.
- “Yêu cầu” là `QuoteRequest` xuyên suốt từ nháp đến giao hàng; sau khi chấp nhận không tạo thực thể đơn hàng riêng. “Phần việc” là `Allocation` của một hộ.
- Quy tắc BR dẫn tới mã tương ứng trong [business-rules.md](business-rules.md). Mọi luồng phải tuân thủ quyền sở hữu và giới hạn dữ liệu tại BR-03–BR-04, kể cả khi gọi trực tiếp API.
- Các bước cập nhật kiểm tra trên máy chủ: xác thực và kiểm tra quyền trước; nếu đúng định danh và nội dung thao tác đã thành công thì trả kết quả đã lưu kèm trạng thái hiện tại, không thực hiện lại dù phiên bản gửi lên đã cũ. Dùng lại định danh với nội dung khác thì báo xung đột. Với thao tác mới, sai dữ liệu/điều kiện hoặc phiên bản cũ thì từ chối, giữ dữ liệu đã lưu và nêu lý do. Lưu thông tin nhận diện/kết quả cùng thay đổi nghiệp vụ theo BR-27; giao diện chỉ yêu cầu tải lại dữ liệu đã thay đổi, không yêu cầu người dùng quản lý phiên bản. Không ghi nhận thành công một phần đối với chấp nhận/phân bổ đơn.
- Thời hạn dùng ngày-giờ Việt Nam (UTC+07:00), so sánh bằng thời gian máy chủ. Tại đúng hạn nhận báo giá, yêu cầu đã đóng; tại đúng hạn chấp nhận báo giá, báo giá không còn đủ điều kiện chọn. Quá hạn giao của phần việc đã chốt không tự kết thúc hoặc hủy đơn.
- Ảnh dùng JPG/PNG/WebP, tối đa 5 MB/ảnh; sản phẩm và mỗi mốc nhật ký tối đa 10 ảnh. Chỉ lưu tham chiếu ảnh đã tải thành công; backend tạo ảnh thu nhỏ và ảnh hiển thị. Chi tiết xử lý và ngoại lệ tại [luồng ảnh dùng chung](#shared-images); UC-03, UC-05, UC-07, UC-10 áp dụng cùng luồng này.
- Các cập nhật yêu cầu, báo giá và phương án tăng `version`. Mỗi phần việc có `version` riêng, tăng khi đổi tiến độ hoặc liên kết lô; các hộ cập nhật phần việc độc lập không bị từ chối chỉ vì hộ khác vừa cập nhật. Khi đổi trạng thái chính hoặc thông tin liên hệ, tăng phiên bản yêu cầu. Mọi cập nhật phần việc vẫn kiểm tra nguyên tử trạng thái hủy/hoàn tất của yêu cầu; xác nhận nhận đủ phải kiểm tra lại toàn bộ phần việc trong cùng giao dịch. Ghi chuyển trạng thái yêu cầu, hủy và xác nhận thay vào `StatusLog`; ghi lịch sử trạng thái phần việc với người/thời điểm thực hiện và căn cứ khi Admin ghi nhận thay. Thao tác gửi lặp không được tạo thêm kết quả nghiệp vụ đã có.
- Hậu điều kiện mô tả kết quả thành công. Nếu thất bại, dữ liệu nghiệp vụ trước thao tác được giữ nguyên, trừ các trạng thái đã tự hết hiệu lực theo thời gian hoặc thay đổi hợp lệ từ thao tác khác.

<a id="shared-images"></a>
### 1.1. Luồng dùng chung: tải lên và tối ưu ảnh

Áp dụng cho ảnh hồ sơ/chứng nhận tại UC-03, UC-05, ảnh sản phẩm tại UC-07 và ảnh nhật ký tại UC-10. Đây là luồng hỗ trợ trong biểu mẫu, không phải một màn hình tối ưu ảnh độc lập.

1. Người có quyền sửa đối tượng chọn một hoặc nhiều ảnh; giao diện kiểm tra sơ bộ định dạng, dung lượng và số lượng rồi hiển thị tiến trình từng ảnh.
2. Máy chủ xác thực và kiểm tra quyền đối với đối tượng hoặc bản nháp thuộc người tải; kiểm tra nội dung ảnh thực tế, không chỉ đuôi tệp. Chỉ nhận JPG/PNG/WebP không hỏng, tối đa 5 MB/ảnh; mỗi sản phẩm hoặc mốc nhật ký tối đa 10 ảnh tính cả ảnh hiện có sau thay đổi.
3. Backend xử lý chiều xoay, tạo ảnh thu nhỏ cạnh dài tối đa 320 px và ảnh hiển thị tối đa 1600 px, giữ tỷ lệ, không phóng lớn ảnh nhỏ. Danh sách dùng ảnh thu nhỏ, chi tiết dùng ảnh hiển thị; không mặc định tải ảnh gốc trên danh sách.
4. Chỉ khi tải và tạo đủ phiên bản thành công, máy chủ trả mã ảnh sẵn sàng và bản xem trước cho người có quyền. Mã ảnh chờ gắn thuộc đúng người tải/ngữ cảnh, chưa công khai chỉ vì biết URL.
5. Người dùng lưu biểu mẫu; hệ thống kiểm tra quyền, số ảnh và điều kiện nội dung rồi gắn các mã ảnh sẵn sàng. Ảnh và các phiên bản được truy cập theo quyền của đối tượng: công khai khi đủ điều kiện, ảnh nháp và lịch sử riêng tư không truy cập công khai.

**Ngoại lệ:** Ảnh sai định dạng/quá giới hạn/hỏng: báo lỗi riêng và cho chọn lại. Mạng hoặc tối ưu lỗi: cho thử lại từng ảnh; ảnh thành công còn trong biểu mẫu, ảnh lỗi không được gắn vào dữ liệu. Cho lưu các ảnh thành công khi đủ điều kiện tối thiểu, không báo cả lượt tải thành công nếu còn ảnh lỗi. Nếu ảnh bắt buộc chưa đủ, chặn công bố/lưu mốc và giữ nội dung đang nhập để sửa. Lưu biểu mẫu thất bại không thay đổi ảnh đã gắn trước đó. Ảnh tải thành công nhưng không gắn được dọn sau 24 giờ; không dọn ảnh đang được đối tượng hoặc lịch sử nhật ký tham chiếu. Thay/xóa ảnh trong mốc đã công bố phải giữ ảnh cũ theo BR-08. Luồng này không mở thêm quyền Admin sửa nội dung hộ.

**Hậu điều kiện:** Dữ liệu chỉ tham chiếu ảnh đã xử lý thành công; ảnh hiển thị/thu nhỏ sẵn sàng, quyền truy cập không rộng hơn đối tượng sở hữu.

## 2. Danh mục use case

| Mã | Use case | Tác nhân chính | Quy tắc |
| --- | --- | --- | --- |
| [UC-01](#uc-01) | Đăng ký Buyer | Khách | BR-01 |
| [UC-02](#uc-02) | Đăng nhập, đăng xuất và quản lý mật khẩu | Buyer, Artisan, Admin | BR-01, BR-03, BR-05 |
| [UC-03](#uc-03) | Quản lý danh sách hộ và cấp tài khoản | Admin | BR-01, BR-02, BR-05, BR-28 |
| [UC-04](#uc-04) | Tạm ngừng, cho hộ hoạt động lại | Admin | BR-05, BR-18, BR-27 |
| [UC-05](#uc-05) | Quản lý hồ sơ và trạng thái đón khách | Artisan | BR-10, BR-28 |
| [UC-06](#uc-06) | Quản lý phân loại | Admin | BR-06 |
| [UC-07](#uc-07) | Quản lý sản phẩm | Artisan | BR-06, BR-07, BR-09 |
| [UC-08](#uc-08) | Khám phá xưởng, sản phẩm và bản đồ | Khách | BR-04, BR-05, BR-07, BR-10, BR-28 |
| [UC-09](#uc-09) | Quản lý và đọc tin cộng đồng | Admin, Khách | BR-02, BR-04, BR-29 |
| [UC-10](#uc-10) | Tạo lô, quản lý nhật ký | Artisan | BR-07–BR-09 |
| [UC-11](#uc-11) | Công bố lô và lấy QR | Artisan | BR-08, BR-09 |
| [UC-12](#uc-12) | Truy xuất qua QR | Khách | BR-04, BR-05, BR-09 |
| [UC-13](#uc-13) | Xem lịch sử sửa nhật ký | Artisan, Admin | BR-08 |
| [UC-14](#uc-14) | Soạn yêu cầu nháp | Buyer | BR-11 |
| [UC-15](#uc-15) | Gửi yêu cầu đến các hộ | Buyer | BR-11–BR-13, BR-26, BR-27 |
| [UC-16](#uc-16) | Phản hồi yêu cầu và quản lý báo giá | Artisan | BR-14, BR-15, BR-26, BR-27 |
| [UC-17](#uc-17) | Đóng nhận báo giá | Buyer, Hệ thống | BR-12, BR-27 |
| [UC-18](#uc-18) | Theo dõi yêu cầu và báo giá | Buyer, Artisan, Admin | BR-04, BR-15, BR-18, BR-23 |
| [UC-19](#uc-19) | Chấp nhận trực tiếp | Buyer | BR-16, BR-19, BR-20, BR-26, BR-27 |
| [UC-20](#uc-20) | Nhờ Ban quản lý chia đơn | Buyer | BR-17, BR-23, BR-27 |
| [UC-21](#uc-21) | Lập phương án chia đơn | Admin | BR-17–BR-19, BR-27 |
| [UC-22](#uc-22) | Chấp nhận hoặc từ chối phương án | Buyer | BR-18–BR-20, BR-26, BR-27 |
| [UC-23](#uc-23) | Bắt đầu phần việc, gắn lô | Artisan | BR-05, BR-20, BR-24, BR-26, BR-27 |
| [UC-24](#uc-24) | Ghi nhận bàn giao phần việc | Artisan; Admin trong ngoại lệ | BR-24, BR-26, BR-27 |
| [UC-25](#uc-25) | Xác nhận nhận đủ | Buyer | BR-25–BR-27 |
| [UC-26](#uc-26) | Xác nhận nhận đủ thay Buyer | Admin | BR-25–BR-27 |
| [UC-27](#uc-27) | Hủy yêu cầu | Buyer, Admin | BR-21–BR-23, BR-26, BR-27 |

## 3. Luồng xuyên suốt

| Tình huống | Chuỗi use case | Kết quả |
| --- | --- | --- |
| Công bố và truy xuất | UC-03 → UC-05 → UC-10 → UC-11 → UC-07 → UC-08/UC-12 | Sản phẩm có lô và trang QR công khai. |
| Một hộ nhận toàn bộ | UC-14 → UC-15 → UC-16 → UC-19 → UC-23 → UC-24 → UC-25 | Một phần việc, yêu cầu chuyển đến `Delivered`. |
| Nhiều hộ cùng thực hiện | UC-14 → UC-15 → UC-16 → UC-17 → UC-20 → UC-21 → UC-22 → UC-23/UC-24 cho từng hộ → UC-25 | Phân bổ đủ số lượng; chỉ hoàn tất khi nhận đủ toàn bộ. |
| Không đủ khả năng đáp ứng | UC-17 → UC-18 → UC-27; có thể bắt đầu lại UC-14 | Yêu cầu cũ giữ nguyên số lượng và lịch sử, được đánh dấu hủy. |
| Phương án mất hiệu lực | UC-04, rút báo giá hoặc hết hạn chấp nhận → UC-18 → UC-21 | Lập lại nếu còn đủ báo giá hợp lệ; nếu thiếu thì Buyer có thể hủy. |
| Xác nhận thay có căn cứ | UC-24 cho mọi hộ → UC-26 | `Delivered`, có lý do và căn cứ trong lịch sử. |

Đóng nhận, nhờ chia đơn và gắn lô không tạo trạng thái chính mới. Hủy giữ nguyên trạng thái chính cuối cùng và ghi thông tin hủy riêng. Không có bước tự động nhận hàng, thanh toán hay phân bổ lại sau khi chấp nhận.

## 4. Tình huống nghiệm thu trọng yếu

| Tình huống | Kết quả phải đạt | Use case |
| --- | --- | --- |
| Khách mở QR lô đã công bố, rồi thử mã của lô nháp | Xem được lô công bố không cần đăng nhập; máy chủ không trả dữ liệu lô nháp hoặc dữ liệu mua sỉ riêng tư. | UC-11, UC-12 |
| Artisan sửa một mốc đã công bố và thử xóa mốc đó | Nội dung hiện hành cập nhật; nội dung/ảnh trước sửa còn trong lịch sử; thao tác xóa bị từ chối. | UC-10, UC-13 |
| Gửi/sửa báo giá đúng lúc đạt hạn nhận, tác vụ nền chưa chạy | Bị từ chối; thời điểm đóng do hết hạn bằng hạn nhận, không bằng lúc tác vụ chạy. | UC-16, UC-17 |
| Buyer đóng sớm rồi nhờ chia khi hai xưởng lần lượt nhận tối đa 60 và 40 chiếc trên yêu cầu 100 cốc gốm | Không sửa được báo giá; hàng chờ có một mục; phương án chỉ hợp lệ khi phân bổ tổng 100 chiếc, từng hộ không vượt khả năng. | UC-17, UC-20, UC-21 |
| Hai báo giá chỉ đáp ứng tổng 90 chiếc trên yêu cầu 100 cốc gốm đã đóng nhận | Không lập/chấp nhận phương án thiếu; không sửa số lượng yêu cầu xuống 90; Buyer có thể hủy và tạo mới. | UC-20, UC-21, UC-27 |
| Buyer gửi lại thao tác chấp nhận hoặc chấp nhận đồng thời hai lựa chọn | Chỉ một kết quả được chốt, đúng tổng số lượng; không tạo phần việc trùng hoặc hai phương án đã chấp nhận. | UC-19, UC-22 |
| Hộ trong phương án bị tạm ngừng rồi hoạt động lại | Phương án hết hiệu lực không tự khôi phục; báo giá được xét lại theo thời hạn; các phần việc đã chốt vẫn thực hiện được. | UC-04, UC-18, UC-21, UC-23 |
| Mọi phần việc đã ghi nhận bàn giao nhưng Buyer chưa xác nhận | Yêu cầu vẫn `In Production`; không tự hoàn tất. Admin chỉ xác nhận thay khi có lý do và căn cứ nhận đủ. | UC-24–UC-26 |
| Admin hủy sau khi hộ báo giao, trước xác nhận nhận đủ | Giữ tiến độ và lịch sử, chặn xác nhận tiếp; không hủy được nếu yêu cầu đã `Delivered`. | UC-25–UC-27 |
| Artisan gọi trực tiếp chi tiết phương án hoặc phần việc của hộ khác | Máy chủ từ chối hoặc chỉ trả phần dữ liệu được phép; không lộ đơn giá và phân bổ của hộ khác. | UC-18, UC-23 |
| Báo giá còn hạn giao nhưng đã tới hạn chấp nhận | Không được chốt; không phụ thuộc tác vụ nền. | UC-16, UC-19, UC-22 |
| Rút báo giá sau đóng nhận khi phương án đang chờ | Báo giá bị loại, phương án hết hiệu lực, hàng chờ có lý do; không gửi lại khi đã đóng. | UC-16, UC-21 |
| Có hộ nhận đủ 100 chiếc, hai hộ khác nhận 50 chiếc/hộ với giá thấp hơn | Buyer vẫn được nhờ chia; phương án hợp lệ có ít nhất hai hộ và tổng 100. | UC-20, UC-21 |
| Buyer từ chối phương án | Bắt buộc lý do; Admin thấy lý do, thời gian chờ và hạn gần nhất để lập lại. | UC-21, UC-22 |
| Phần việc đang sản xuất, hàng đã giao đủ nhưng hộ chưa cập nhật | Admin xác minh và ghi bàn giao thay có căn cứ/lịch sử; không tự chuyển Delivered. | UC-24–UC-26 |
| Phần việc chưa bắt đầu, Admin thử ghi bàn giao thay | Từ chối; liên hệ hộ cập nhật UC-23 hoặc xử lý quyền truy cập trước; không tự tạo bước bắt đầu hoặc chuyển yêu cầu sang In Production. | UC-23, UC-24 |
| Gửi lại thao tác đã thành công với phiên bản cũ | Sau kiểm tra quyền, đúng định danh và nội dung thì trả kết quả cũ kèm trạng thái hiện tại, không ghi thêm; định danh cũ kèm nội dung khác hoặc thao tác mới với phiên bản cũ bị từ chối. | UC-19, UC-22, BR-27 |
| Một hộ đã giao, hộ còn lại không thể hoàn thành | Khi Admin hủy, giữ phần đã giao, hiển thị lý do và cách xử lý ngoài hệ thống; không giả nhận đủ. | UC-27 |
| Phần việc 100 chiếc, dữ liệu truy xuất có tổng liên kết 0, 90 hoặc 100 chiếc | Cả ba trường hợp được ghi nhận bàn giao nếu thực tế đã giao đủ; hiển thị mức độ truy xuất tương ứng. Tổng 110 hoặc lô hộ khác bị từ chối ngay khi lưu liên kết. | UC-23, UC-24 |
| Sửa số điện thoại sau chốt và sao chép đơn đã hủy | Sửa liên hệ có lịch sử, không đổi điều kiện thương mại; bản sao là nháp không mang báo giá/phần việc/hạn cũ. | UC-14 |
| Sửa giá, rút báo giá hoặc tạm ngừng hộ đồng thời với chấp nhận | Thử cả hai thứ tự: thay đổi trước thì chấp nhận cũ thất bại; chấp nhận trước thì giữ cam kết đã chốt, không sửa/rút được báo giá đã chốt. Tạm ngừng sau chốt không hủy phần việc. | UC-04, UC-16, UC-19, UC-22 |
| Hủy đồng thời với xác nhận nhận đủ | Hủy trước thì không Delivered; Delivered trước thì không hủy; không tồn tại cả hai kết quả. | UC-25–UC-27 |
| Hai hộ cập nhật hai phần việc độc lập | Không xung đột chỉ vì dùng chung yêu cầu; hai cập nhật cùng phần việc kiểm tra phiên bản riêng; hủy vẫn chặn mọi cập nhật sau đó. | UC-23, UC-24 |
| Đăng ký tên trùng khác chữ hoa/thường hoặc gửi kèm vai trò Admin | Không tạo trùng; đăng ký thành công chỉ cấp Buyer. | UC-01 |
| Artisan đăng nhập bằng mật khẩu tạm | Chỉ được đổi mật khẩu/đăng xuất; gọi API nghiệp vụ trực tiếp bị chặn cho tới đổi và đăng nhập lại. | UC-02, UC-03 |
| Đổi/đặt lại mật khẩu thành công | Mật khẩu và phiên cũ không dùng được; đặt lại cần căn cứ, cấp tạm và đổi lần đầu; không mở khóa hoặc đổi trạng thái hộ. | UC-02 |
| Admin chỉ biết tên đăng nhập/số điện thoại tự khai của người quên mật khẩu | Không đủ căn cứ đặt lại; không hiển thị mật khẩu cũ. | UC-02 |
| Sai mật khẩu 5 lần/15 phút cho cùng nguồn–tên đăng nhập, hoặc mật khẩu tạm đạt hạn 24 giờ | Chặn cặp nguồn–tên 15 phút, nguồn khác vẫn đăng nhập theo giới hạn riêng; mật khẩu tạm hết hạn bị từ chối và cần cấp lại, không dùng lại mật khẩu cũ. | UC-02 |
| Admin lọc hộ tạm ngừng, xem chi tiết rồi thử sửa câu chuyện/ảnh hộ | Xem được dữ liệu quản lý theo quyền, nhưng không có quyền sửa nội dung thay Artisan. | UC-03, UC-05 |
| Tải nhiều ảnh, một ảnh lỗi tối ưu | Ảnh lỗi không được gắn, có thể thử lại; ảnh thành công còn trong biểu mẫu. Thiếu ảnh bắt buộc không công bố. Danh sách dùng ảnh thu nhỏ đã tạo. | UC-05, UC-07, UC-10 |
| Dọn ảnh tải dở hoặc truy cập trực tiếp ảnh nháp/lịch sử | Chỉ dọn ảnh không tham chiếu sau 24 giờ; giữ ảnh lịch sử, chặn truy cập không đúng quyền. | UC-10, UC-13 |
| Một hộ im lặng, một hộ chọn không tham gia | Buyer thấy hai phản hồi khác nhau, không hiển thị đã đọc; Artisan không thấy phản hồi hộ khác. | UC-16, UC-18 |
| Hộ đổi ý sau không tham gia | Còn mở và hoạt động thì chào giá được; đã đóng thì bị chặn. Hộ từng có báo giá phải dùng rút/gửi lại, không dùng từ chối lời mời. | UC-16 |
| Hộ chỉ nhận lời mời, hộ không tham gia và hộ không được chọn gọi API chi tiết/lịch sử liên hệ | Chỉ trả dữ liệu chào giá và khu vực khái quát; không lộ tên người nhận, điện thoại, địa chỉ chi tiết hoặc hồ sơ Buyer. Hộ có phần việc chốt mới được xem bàn giao đầy đủ. | UC-14–UC-18 |
| Chào hạn chấp nhận trước, đúng hoặc sau hạn nhận cộng 24 giờ | Trước mốc bị từ chối; đúng/sau mốc chỉ hợp lệ nếu còn trước hạn giao cam kết. Đóng sớm không làm giảm mốc kiểm tra. | UC-15, UC-16 |
| Mọi báo giá bị rút/hết hạn | Buyer và Admin thấy Không còn báo giá hợp lệ; còn mở thì chờ, đã đóng thì hủy/sao chép; không lùi trạng thái hoặc tự hủy. | UC-18 |
| Cùng Admin ghi nhận bàn giao và xác nhận nhận đủ thay | Buyer thấy hai nhãn/sự kiện riêng cùng căn cứ; không ghi là Buyer tự xác nhận. | UC-24, UC-26 |
| Hủy nháp hoặc xóa đồng thời gửi nháp | Hủy nháp bị từ chối; xóa/gửi chỉ một kết quả hợp lệ, không mất yêu cầu đã gửi. | UC-14, UC-15, UC-27 |
| Quét QR của hộ tạm ngừng | Giữ tên xưởng dạng văn bản và nhật ký lô công bố, không có liên kết/dữ liệu hồ sơ bị ẩn ngoài tên xưởng. | UC-12 |
| Một nguồn sai 30 lần/15 phút trên nhiều tên hoặc cố khóa Admin bằng 5 lần sai cùng tên | Chặn nguồn hoặc cặp nguồn–tên theo BR-01; IP do client tự khai không vượt giới hạn, nguồn khác và phiên đang hợp lệ không bị khóa tài khoản toàn cục. | UC-02 |

## 5. Giới hạn đặc tả

Làng gốm Bát Tràng, danh mục khởi tạo và công đoạn mẫu đã được xác định trong phạm vi. Tên xưởng, lô và số lượng trong các ví dụ là dữ liệu minh họa. Xác thực dùng tên đăng nhập/mật khẩu theo BR-01 và UC-01–03; không triển khai OTP, email hoặc SMS. Khôi phục tài khoản Admin do người vận hành xử lý ngoài ứng dụng. Chưa quản lý công suất tự động, thay hộ, thay đổi điều kiện thương mại sau chốt, xác nhận nhận từng phần, giao thiếu, tranh chấp hoặc thanh toán. Chỉ cho sửa tên/số điện thoại liên hệ có lịch sử; Admin chỉ ghi nhận bàn giao thay hộ với căn cứ khi phần việc đã ở trạng thái đang sản xuất; không tự tạo bước bắt đầu. Quên mật khẩu Buyer/Artisan xử lý qua UC-02 sau xác minh ngoài hệ thống; mở khóa tài khoản vì sự cố bảo mật là quy trình riêng, không tự thực hiện khi đặt lại mật khẩu.

### Giải thích giới hạn khi vấn đáp

Nếu một hộ không hoàn thành, MVP không thay hộ hoặc quyết toán từng phần. Yêu cầu chỉ hoàn tất khi nhận đủ toàn bộ; Admin có thể hủy và hệ thống giữ phần đã giao, lịch sử, lý do dừng cùng cách xử lý ngoài hệ thống. Phần đã giao không bị xóa hoặc diễn giải là chưa giao. Nhóm ưu tiên phân bổ đủ số lượng, chuyển trạng thái đúng và bảo toàn lịch sử; thay hộ, bồi hoàn và kết thúc từng phần là hướng mở rộng, không phải chức năng đã triển khai.

## 6. Đặc tả chi tiết

<a id="uc-01"></a>
## UC-01 — Đăng ký Buyer

- **Tác nhân:** Khách. **Quy tắc:** BR-01.
- **Mục tiêu/kích hoạt:** Tạo tài khoản để gửi yêu cầu mua sỉ.
- **Tiền điều kiện:** Chưa đăng nhập.
- **Dữ liệu:** Tên đăng nhập, tên hiển thị, số điện thoại liên hệ, mật khẩu và xác nhận mật khẩu theo mục xác thực của BR-01.

**Luồng chính**

1. Khách nhập dữ liệu và chọn đăng ký.
2. Hệ thống chuẩn hóa tên đăng nhập, kiểm tra định dạng, tính duy nhất và mật khẩu xác nhận trùng khớp.
3. Tạo tài khoản chỉ có vai trò Buyer, lưu mật khẩu dưới dạng băm và hướng dẫn đăng nhập qua UC-02.

**Ngoại lệ:** Thiếu/sai dữ liệu hoặc trùng tên đăng nhập sau chuẩn hóa: từ chối, cho sửa. Không dùng quyền Artisan/Admin do khách gửi kèm. Số điện thoại chỉ dùng liên hệ, chưa được xác minh bằng OTP và không đủ làm căn cứ duy nhất để đặt lại mật khẩu. Không tự đăng nhập khi đăng ký thất bại.

**Hậu điều kiện:** Có một tài khoản Buyer; chưa phát sinh yêu cầu báo giá. Tên đăng nhập không được tự đổi; không cần email/SMS để kích hoạt.

<a id="uc-02"></a>
## UC-02 — Đăng nhập, đăng xuất và quản lý mật khẩu

- **Tác nhân:** Buyer, Artisan, Admin; Admin hỗ trợ đặt lại mật khẩu Buyer/Artisan.
- **Quy tắc:** BR-01, BR-03, BR-05.
- **Mục tiêu/kích hoạt:** Truy cập tài khoản, kết thúc phiên, đổi mật khẩu hoặc khôi phục truy cập sau xác minh.
- **Tiền điều kiện:** Có tài khoản. Đổi mật khẩu cần phiên hợp lệ; đặt lại cần Admin đã xác minh chủ tài khoản ngoài hệ thống.
- **Dữ liệu:** Tên đăng nhập/mật khẩu; đổi mật khẩu gồm mật khẩu hiện tại, mới và xác nhận; đặt lại gồm tài khoản đích, lý do, căn cứ xác minh.

**Luồng đăng nhập và đăng xuất**

1. Người dùng nhập tên đăng nhập và mật khẩu. Máy chủ kiểm tra đồng thời giới hạn theo nguồn truy cập và cặp nguồn–tên đăng nhập theo BR-01, rồi xác thực tài khoản/mật khẩu. Không khóa toàn cục tài khoản chỉ vì một nguồn thử sai; không kết thúc phiên đang hợp lệ do thử sai từ xa.
2. Nếu dùng mật khẩu tạm, chỉ cấp phiên giới hạn để đổi mật khẩu hoặc đăng xuất; chặn mọi API nghiệp vụ khác. Người dùng nhập mật khẩu mới, xác nhận và mật khẩu tạm hiện tại. Đổi thành công vô hiệu hóa mật khẩu tạm và mọi phiên, yêu cầu đăng nhập lại.
3. Với mật khẩu thông thường, tạo phiên theo vai trò và hộ sở hữu nếu có; hiển thị chức năng được phép.
4. Đăng xuất kết thúc phiên hiện tại; phiên hết hạn phải đăng nhập lại.

**Đổi mật khẩu chủ động:** Người dùng nhập mật khẩu hiện tại và mật khẩu mới/xác nhận. Kiểm tra mật khẩu hiện tại, chính sách và mật khẩu mới khác hiện tại; lưu băm mới, kết thúc mọi phiên rồi yêu cầu đăng nhập lại. Thất bại giữ mật khẩu cũ.

**Quên mật khẩu và Admin đặt lại**

1. Trang đăng nhập hướng dẫn liên hệ Ban quản lý ngoài hệ thống; không có nút tự đặt lại chỉ bằng tên đăng nhập/số điện thoại.
2. Admin tìm đúng tài khoản Buyer/Artisan, xác minh người yêu cầu ngoài hệ thống bằng căn cứ đối chiếu độc lập. Chỉ biết tên đăng nhập hoặc số điện thoại tự khai là chưa đủ; chưa xác minh được thì không đặt lại.
3. Admin nhập lý do/căn cứ và xác nhận lại mật khẩu Admin hiện tại. Hệ thống sinh mật khẩu tạm, thay băm mật khẩu, kết thúc mọi phiên cũ và buộc đổi ở lần đăng nhập tiếp theo.
4. Hiển thị mật khẩu tạm một lần cho Admin để bàn giao riêng ngoài hệ thống; không lưu vào nhật ký. Nếu mất thông tin bàn giao, thực hiện cấp lại, mật khẩu tạm trước mất hiệu lực. Ghi tài khoản đích, người thực hiện, thời điểm, lý do và căn cứ.

**Ngoại lệ:** Sai tên đăng nhập hoặc mật khẩu trả cùng thông báo không xác thực được; áp dụng giới hạn thử theo BR-01. Mật khẩu tạm hết hạn phải cấp lại sau xác minh. Tài khoản khóa đăng nhập không được tạo phiên; đặt lại mật khẩu không mở khóa hoặc đổi vai trò/trạng thái hộ. Hộ tạm ngừng vẫn đăng nhập để hoàn thành việc đã chốt. Không cho Admin dùng luồng này đặt lại tài khoản Admin khác hoặc chính mình; khôi phục Admin do người vận hành hệ thống thực hiện ngoài ứng dụng sau xác minh.

**Hậu điều kiện:** Phiên hoặc mật khẩu được cập nhật theo nhánh; không đổi dữ liệu nghiệp vụ, quyền hoặc trạng thái hộ. Không có chức năng xem lại mật khẩu hiện tại.

<a id="uc-03"></a>
## UC-03 — Quản lý danh sách hộ và cấp tài khoản

- **Tác nhân:** Admin. **Quy tắc:** BR-01, BR-02, BR-05, BR-28.
- **Mục tiêu/kích hoạt:** Xem, tìm kiếm hộ và cấp tài khoản cho hộ Bát Tràng đã xác minh.
- **Tiền điều kiện:** Admin đăng nhập và đã hoàn tất đổi mật khẩu tạm nếu có; tạo hộ mới cần xác minh ngoài hệ thống.
- **Dữ liệu:** Bộ lọc trạng thái hoạt động/tạm ngừng, tên/mã hộ hoặc tên đăng nhập; khi tạo gồm thông tin hộ, hồ sơ ban đầu và tên đăng nhập Artisan.

**Luồng chính**

1. Admin mở danh sách hộ có phân trang, tìm theo tên/mã hộ/tên đăng nhập và lọc trạng thái vận hành.
2. Mở chi tiết để xem hồ sơ, tài khoản liên kết, trạng thái công khai, trạng thái vận hành và phần việc theo quyền. Không hiển thị mật khẩu hoặc bản băm.
3. Để tạo mới, Admin nhập thông tin hộ đã xác minh và tên đăng nhập. Hệ thống kiểm tra tên đăng nhập duy nhất, tránh cấp lại tài khoản cho hộ đã tồn tại; MVP dùng một tài khoản Artisan cho mỗi hộ.
4. Tạo hồ sơ và tài khoản liên kết đúng hộ trong cùng thao tác, trạng thái hộ hoạt động; sinh mật khẩu tạm bắt buộc đổi lần đầu. Chỉ báo thành công khi hồ sơ và tài khoản đều được tạo.
5. Admin nhận mật khẩu tạm một lần và bàn giao riêng ngoài hệ thống. Artisan đăng nhập qua UC-02 rồi hoàn thiện hồ sơ qua UC-05; ảnh ban đầu dùng luồng ảnh chung nếu có.

**Luồng khác/ngoại lệ:** Danh sách rỗng hiển thị chưa có kết quả. Từ chi tiết, Admin chuyển sang UC-04 để tạm ngừng/hoạt động lại hoặc UC-02 để đặt lại mật khẩu sau xác minh; không tạo tài khoản mới để xử lý quên mật khẩu. Hồ sơ ban đầu thiếu tên, địa chỉ, giới thiệu hoặc ảnh chưa công khai. Sau tạo, Artisan quản lý tên hiển thị, nội dung, ảnh, tọa độ và chứng nhận; Admin không sửa thay các nội dung này. Không có Artisan tự nộp đơn/tự duyệt hoặc đổi chủ hộ qua màn hình này.

**Hậu điều kiện:** Xem danh sách không thay đổi dữ liệu; cấp tài khoản tạo đúng một hồ sơ và một tài khoản liên kết, không tự cấp chứng nhận chất lượng.

<a id="uc-04"></a>
## UC-04 — Tạm ngừng hoặc cho hộ hoạt động lại

- **Tác nhân:** Admin. **Quy tắc:** BR-05, BR-18, BR-27.
- **Mục tiêu/kích hoạt:** Thay đổi khả năng tham gia nghiệp vụ mới của hộ.
- **Tiền điều kiện:** Hộ đã tồn tại.
- **Dữ liệu:** Hộ và trạng thái vận hành cần chuyển.

**Luồng chính**

1. Admin mở hộ, xem trạng thái và chọn tạm ngừng.
2. Hệ thống đổi trạng thái, ẩn hồ sơ công khai, sản phẩm và ghim bản đồ của hộ.
3. Hệ thống chặn nhận yêu cầu và gửi/sửa báo giá; loại báo giá của hộ khỏi việc xét chọn và tính khả năng đáp ứng.
4. Phương án đề xuất có hộ này hết hiệu lực; hàng chờ Admin hiển thị lý do cần lập lại.

**Luồng khác/ngoại lệ:** Chọn hoạt động lại: khôi phục hiển thị theo điều kiện công khai, xét lại báo giá theo thời hạn; không khôi phục phương án đã hết hiệu lực hoặc tự gửi lại yêu cầu cũ. Nếu đồng thời có Buyer chấp nhận, kiểm tra nhất quán để kết quả chỉ là đã chốt hợp lệ trước khi ngừng, hoặc từ chối báo giá không còn đủ điều kiện.

**Hậu điều kiện:** Phần việc đã chốt, quyền đăng nhập và QR công khai được giữ; không tự chuyển việc sang hộ khác.

<a id="uc-05"></a>
## UC-05 — Quản lý hồ sơ và trạng thái đón khách

- **Tác nhân:** Artisan. **Quy tắc:** BR-10, BR-28.
- **Mục tiêu/kích hoạt:** Cập nhật thông tin xưởng hoặc bật/tắt đón khách.
- **Tiền điều kiện:** Tài khoản gắn với hộ sở hữu hồ sơ.
- **Dữ liệu:** Tên xưởng, câu chuyện làm nghề, địa chỉ, ảnh, tọa độ, chứng nhận tùy chọn và trạng thái đón khách.

**Luồng chính**

1. Artisan mở hồ sơ của hộ, nhập thay đổi và tải ảnh.
2. Hệ thống kiểm tra dữ liệu; chứng nhận nếu khai báo phải có tên và ảnh.
3. Hệ thống lưu hồ sơ. Khi hộ hoạt động và đủ tên, địa chỉ, giới thiệu, ít nhất một ảnh xưởng, hồ sơ tự công khai.
4. Artisan bật/tắt đón khách; hệ thống cập nhật thông tin trên bản đồ nếu xưởng đủ điều kiện hiển thị.

**Ngoại lệ:** Hồ sơ đã đủ điều kiện không được sửa thành thiếu trường bắt buộc. Tọa độ ngoài giới hạn bị từ chối; không có tọa độ thì chưa có ghim bản đồ. Hộ tạm ngừng không hiển thị công khai dù hồ sơ đầy đủ hoặc đang bật đón khách.

**Hậu điều kiện:** Hồ sơ được cập nhật; trạng thái đón khách không thay đổi quyền nhận yêu cầu mua sỉ. Không tự gắn nhãn chứng nhận khi không có chứng cứ.

<a id="uc-06"></a>
## UC-06 — Quản lý phân loại

- **Tác nhân:** Admin. **Quy tắc:** BR-06.
- **Mục tiêu/kích hoạt:** Tạo, sửa hoặc xóa phân loại sản phẩm gốm Bát Tràng.
- **Tiền điều kiện:** Admin đang đăng nhập.
- **Dữ liệu:** Tên phân loại và phân loại được thao tác.

**Luồng chính**

1. Admin mở danh sách và nhập phân loại mới hoặc sửa phân loại hiện có.
2. Hệ thống kiểm tra tên không rỗng, lưu thay đổi.
3. Phân loại được dùng trong biểu mẫu sản phẩm, yêu cầu báo giá và bộ lọc danh mục.

**Luồng khác/ngoại lệ:** Khi xóa, hệ thống kiểm tra tham chiếu. Phân loại đang được sử dụng không được xóa; kiểm tra này phải đúng cả khi có thao tác sử dụng đồng thời.

**Hậu điều kiện:** Danh mục được cập nhật, không làm mất phân loại của dữ liệu hiện hữu.

<a id="uc-07"></a>
## UC-07 — Quản lý sản phẩm

- **Tác nhân:** Artisan. **Quy tắc:** BR-06, BR-07, BR-09.
- **Mục tiêu/kích hoạt:** Soạn, công bố, sửa hoặc ẩn sản phẩm của hộ.
- **Tiền điều kiện:** Khi tạo mới: Artisan có hộ và sở hữu lô được chọn. Khi sửa/công bố/ẩn: Artisan còn phải sở hữu sản phẩm hiện hữu.
- **Dữ liệu:** Tên, một phân loại, giá VND, ảnh và lô.

**Luồng chính**

1. Artisan nhập thông tin, chọn lô của hộ và lưu sản phẩm nháp.
2. Khi chọn công bố, hệ thống kiểm tra đủ tên, phân loại, giá lớn hơn 0, ít nhất một ảnh và lô đã công bố.
3. Hệ thống chuyển sản phẩm sang công bố; đưa vào danh mục nếu hộ hoạt động.
4. Artisan có thể sửa thông tin hoặc chuyển sang ẩn; khi công bố lại, hệ thống kiểm tra lại điều kiện.

**Ngoại lệ:** Lô thuộc hộ khác hoặc dữ liệu công bố thiếu/sai: từ chối. Không đổi lô khi lô hiện tại đã công bố. Sửa sản phẩm đang công bố phải giữ đủ dữ liệu bắt buộc. Hộ tạm ngừng không xuất hiện trong danh mục dù sản phẩm mang trạng thái công bố.

**Hậu điều kiện:** Trạng thái sản phẩm quyết định việc xuất hiện trong danh mục; ẩn sản phẩm không hủy QR của lô hoặc sửa các báo giá/phần việc đã lưu.

<a id="uc-08"></a>
## UC-08 — Khám phá xưởng, sản phẩm và bản đồ

- **Tác nhân:** Khách, người dùng đã đăng nhập. **Quy tắc:** BR-04, BR-05, BR-07, BR-10, BR-28.
- **Mục tiêu/kích hoạt:** Tìm hiểu gốm Bát Tràng, tìm xưởng đón khách xem làm gốm hoặc trải nghiệm qua danh mục và bản đồ.
- **Tiền điều kiện:** Không cần đăng nhập.
- **Dữ liệu:** Bộ lọc hộ/phân loại, sản phẩm hoặc ghim xưởng được chọn.

**Luồng chính**

1. Khách mở danh mục, lọc theo hộ hoặc phân loại.
2. Hệ thống hiển thị sản phẩm công bố của hộ hoạt động; khách mở chi tiết, hồ sơ xưởng hoặc trang truy xuất công khai.
3. Khách mở bản đồ; hệ thống hiển thị xưởng đủ điều kiện công khai, có tọa độ hợp lệ và đang hoạt động.
4. Chọn ghim để xem thông tin vắn tắt và trạng thái đón khách.

**Ngoại lệ:** Không có kết quả: hiển thị danh sách rỗng. Sản phẩm nháp/ẩn, hồ sơ chưa đủ điều kiện hoặc hộ tạm ngừng không được xem qua đường dẫn công khai trực tiếp. Bản đồ tải lỗi: báo lỗi và cho thử lại; không ảnh hưởng quyền xem danh mục. Xưởng tắt đón khách vẫn có ghim nếu các điều kiện khác thỏa mãn.

**Hậu điều kiện:** Không thay đổi dữ liệu; không phát sinh đặt lịch tham quan hay đơn mua lẻ.

<a id="uc-09"></a>
## UC-09 — Quản lý và đọc tin cộng đồng

- **Tác nhân:** Admin quản lý; Khách đọc. **Quy tắc:** BR-02, BR-04, BR-29.
- **Mục tiêu/kích hoạt:** Soạn/công bố tin hoặc mở trang tin công khai.
- **Tiền điều kiện:** Thao tác quản lý cần Admin; đọc tin không cần đăng nhập.
- **Dữ liệu:** Tiêu đề, nội dung và một loại tin theo BR-29; ví dụ thông báo về đất, men gốm, lịch cúp điện hoặc chính sách hỗ trợ hộ sản xuất tại Bát Tràng.

**Luồng chính**

1. Admin tạo tin mới ở trạng thái nháp hoặc mở tin hiện hữu để sửa. Sửa giữ trạng thái hiện tại; sửa tin công bố phải vẫn đủ tiêu đề, nội dung và loại tin. Chỉ đưa về nháp khi Admin chủ động chọn gỡ công khai.
2. Admin chọn công bố; hệ thống kiểm tra đủ tiêu đề, nội dung, loại tin.
3. Hệ thống đưa tin vào danh sách công khai; khách mở danh sách và nội dung tin.

**Luồng khác/ngoại lệ:** Admin đưa tin về nháp để gỡ công khai. Khách không xem được tin nháp dù biết địa chỉ. Vai trò khác không được tạo/sửa/công bố tin. Nội dung thiếu trường bắt buộc không được công bố.

**Hậu điều kiện:** Tin hiển thị theo trạng thái; công bố tin không gửi email/SMS hoặc tạo thông báo cá nhân.

<a id="uc-10"></a>
## UC-10 — Tạo lô và quản lý nhật ký

- **Tác nhân:** Artisan. **Quy tắc:** BR-07–BR-09.
- **Mục tiêu/kích hoạt:** Ghi lại quá trình sản xuất của một lô.
- **Tiền điều kiện:** Khi tạo mới: Artisan có hộ sở hữu. Khi thêm/sửa/xóa mốc: lô đã tồn tại và thuộc hộ của Artisan.
- **Dữ liệu:** Thông tin nhận diện lô; mỗi mốc gồm thời gian thực hiện, công đoạn và 1–10 ảnh minh chứng.

**Luồng chính**

1. Artisan tạo lô; hệ thống lưu lô nháp thuộc hộ.
2. Artisan thêm mốc, nhập công đoạn làm gốm thực tế (ví dụ tạo hình cốc hoặc nung), thời gian và tải ảnh minh chứng của lô.
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

**Ngoại lệ:** Không có mốc hợp lệ: giữ nháp, yêu cầu bổ sung. Không bắt buộc đủ toàn bộ công đoạn mẫu hoặc đã nung xong mới được công bố; lô tiếp tục bổ sung nhật ký theo thực tế. Công bố lặp: trả về lô và QR đã có, không tạo mã mới. Không cho đưa về nháp hoặc xóa lô sau công bố. Nếu không thể hoàn tất công bố, không trả kết quả thành công hoặc QR truy xuất sai lô.

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
3. Trang hiển thị tên xưởng dạng văn bản và thông tin truy xuất của lô, câu chuyện, các mốc và ảnh hiện hành theo thời gian, thời điểm cập nhật gần nhất.
4. Trang ghi rõ nhật ký do hộ cung cấp; cấp tài khoản không đồng nghĩa Admin xác nhận nhật ký.

**Ngoại lệ:** Mã không tồn tại hoặc lô nháp: không trả dữ liệu lô. Hộ tạm ngừng hoặc sản phẩm bị ẩn: QR lô đã công bố vẫn xem được; không vì vậy mở lại hồ sơ xưởng bị ẩn. Chỉ hiển thị liên kết sang hồ sơ khi hồ sơ đang công khai; nếu bị ẩn/tạm ngừng, chỉ giữ tên xưởng dạng văn bản, máy chủ không trả liên kết hoặc dữ liệu hồ sơ bị ẩn ngoài tên xưởng.

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

<a id="uc-14"></a>
## UC-14 — Soạn yêu cầu nháp

- **Tác nhân:** Buyer. **Quy tắc:** BR-11.
- **Mục tiêu/kích hoạt:** Chuẩn bị yêu cầu mua sỉ; chọn tạo yêu cầu hoặc mở bản nháp của mình.
- **Tiền điều kiện:** Buyer đã đăng nhập.
- **Dữ liệu:** Một phân loại gốm, quy cách, số lượng, đơn vị chiếc/bộ, hạn nhận báo giá, hạn giao, tên người nhận, số điện thoại, hình thức nhận hàng và khu vực giao khái quát/địa chỉ chi tiết nếu nhận tại địa chỉ Buyer. Khu vực gồm tỉnh/thành phố và xã/phường, không có số nhà/đường hoặc liên hệ; địa chỉ chi tiết phải phù hợp với khu vực đã chọn, lưu thành trường riêng. Nhắc Buyer không đưa liên hệ/địa chỉ chi tiết vào quy cách mà mọi hộ nhận sẽ xem. Quy cách mô tả kích thước/dung tích, màu men, họa tiết/logo, đóng gói khi có; tính theo bộ phải nêu thành phần một bộ.

**Luồng chính**

1. Buyer nhập thông tin và chọn lưu nháp.
2. Hệ thống lưu yêu cầu thuộc Buyer ở `Draft Request`; chưa xác định/gửi cho các hộ.
3. Buyer mở lại để sửa hoặc tiếp tục gửi qua UC-15.

**Luồng khác/ngoại lệ:** Buyer được xóa bản nháp của mình; nháp không được hủy. Xóa kiểm tra trạng thái/phiên bản nguyên tử với gửi, không xóa yêu cầu đã gửi. Nháp có thể chưa đủ thông tin để gửi; các trường đã nhập phải đúng kiểu dữ liệu. Yêu cầu đã gửi không được sửa/xóa như bản nháp; sửa riêng thông tin liên hệ theo ngoại lệ dưới đây. Nháp thuộc Buyer khác không được truy cập.

**Hậu điều kiện:** Có bản nháp được lưu, cập nhật hoặc xóa; không tạo báo giá hoặc phần việc.

**Sao chép và liên hệ:** Buyer được sao chép yêu cầu của mình (kể cả đã hủy/hoàn tất) thành nháp mới. Chỉ sao chép nội dung và thông tin bàn giao; xóa thời hạn để chọn lại, không sao chép báo giá, hộ nhận, phương án, phần việc, lịch sử hoặc dấu hủy. Với yêu cầu đã gửi nhưng chưa hủy/Delivered, Buyer được sửa riêng tên và số điện thoại người nhận; lưu trước/sau, người sửa, thời điểm và tăng phiên bản yêu cầu. Buyer sở hữu, Admin và chỉ các hộ có phần việc đã chốt xem thông tin liên hệ mới nhất và lịch sử theo quyền; hộ chỉ nhận lời mời không được trả các trường liên hệ; lần xem tiếp theo hiển thị dấu đã đổi liên hệ. Không đổi khu vực giao, địa chỉ chi tiết, hình thức bàn giao, số lượng, quy cách hay thời hạn qua thao tác này.

<a id="uc-15"></a>
## UC-15 — Gửi yêu cầu đến các hộ

- **Tác nhân:** Buyer. **Quy tắc:** BR-11–BR-13, BR-26, BR-27.
- **Mục tiêu/kích hoạt:** Mời các hộ phù hợp chào giá; chọn gửi bản nháp.
- **Tiền điều kiện:** Sở hữu yêu cầu `Draft Request`, chưa hủy.
- **Dữ liệu:** Toàn bộ thông tin yêu cầu tại UC-14 và phiên bản đang xem.

**Luồng chính**

1. Buyer xem lại thông tin và xác nhận gửi.
2. Hệ thống kiểm tra đủ trường; số lượng nguyên dương; `hiện tại < hạn nhận báo giá < hạn giao`. Kiểm tra thêm `hạn giao > hạn nhận báo giá + 24 giờ` để còn khả năng chào giá hợp lệ; hạn mặc định 7 ngày chỉ dùng khi thỏa cả hai điều kiện. Không đủ khoảng thời gian thì giữ nháp và yêu cầu Buyer chọn lại, không tự gia hạn.
3. Hệ thống kiểm tra tên, điện thoại người nhận và hình thức bàn giao. Nhận tại địa chỉ Buyer phải có khu vực giao khái quát và địa chỉ chi tiết phù hợp; nhận tại xưởng nghĩa là nhận từng phần tại xưởng của hộ được chọn.
4. Hệ thống tìm toàn bộ hộ sản xuất gốm Bát Tràng đang hoạt động có ít nhất một sản phẩm công bố thuộc phân loại yêu cầu và lưu danh sách nhận, không lặp hộ. Hệ thống khớp phân loại, không tự suy luận khả năng đáp ứng màu men, logo hoặc dung tích; hộ xem quy cách trước khi chào giá.
5. Nếu có hộ nhận, chuyển sang `Sent to Artisans`, ghi lịch sử và đưa yêu cầu vào danh sách nhận của các hộ.

**Ngoại lệ:** Thiếu/sai dữ liệu, thời hạn không còn hợp lệ hoặc không có hộ phù hợp: giữ nháp, nêu lý do. Gửi lặp yêu cầu đã gửi không tạo thêm người nhận hay lịch sử chuyển trạng thái. Gửi yêu cầu không bao gồm email/SMS.

**Hậu điều kiện:** Phân loại, quy cách, số lượng, đơn vị tính, thời hạn, khu vực giao, địa chỉ và hình thức bàn giao được giữ cố định; tên/số điện thoại chỉ được sửa theo UC-14; các hộ trong danh sách chỉ xem phần thông tin chào giá theo BR-04, không được trả tên người nhận, điện thoại hoặc địa chỉ chi tiết. Sau chốt chỉ hộ được phân phần việc được mở các trường này; hộ không được chọn/không tham gia vẫn không có quyền xem, kể cả qua API hoặc lịch sử sửa.

<a id="uc-16"></a>
## UC-16 — Phản hồi yêu cầu và quản lý báo giá

- **Tác nhân:** Artisan. **Quy tắc:** BR-14, BR-15, BR-26, BR-27.
- **Mục tiêu/kích hoạt:** Chào giá cho một yêu cầu đã nhận.
- **Tiền điều kiện:** Gửi/sửa cần hộ trong danh sách nhận, đang hoạt động và yêu cầu còn mở nhận, chưa chấp nhận/hủy. Rút chỉ cần sở hữu báo giá và yêu cầu chưa chấp nhận/hủy; không yêu cầu hộ hoạt động hoặc còn mở nhận.
- **Dữ liệu:** Đơn giá VND, số lượng tối đa nhận, hạn chấp nhận báo giá, thời hạn giao cam kết và phiên bản báo giá nếu sửa/rút; lý do khi rút.

**Luồng chính**

1. Artisan mở yêu cầu, xem quy cách, số lượng, hạn giao, hình thức bàn giao và khu vực giao khái quát nếu giao đến Buyer; chưa xem liên hệ hoặc địa chỉ chi tiết.
2. Artisan nhập báo giá hoặc sửa báo giá hiện hành của hộ.
3. Hệ thống kiểm tra đơn giá lớn hơn 0, số lượng nguyên dương không vượt yêu cầu, `hiện tại < hạn chấp nhận báo giá < thời hạn giao cam kết ≤ hạn giao yêu cầu` và `hạn chấp nhận báo giá ≥ hạn nhận báo giá + 24 giờ`.
4. Hệ thống hiển thị rõ đơn giá chỉ là tiền hàng, phí vận chuyển thỏa thuận ngoài hệ thống; thời hạn cam kết là lúc bàn giao đủ, không phải chỉ hoàn tất sản xuất.
5. Hệ thống lưu một báo giá hiện hành cho hộ; khi sửa tăng phiên bản. Báo giá hợp lệ đầu tiên chuyển yêu cầu từ `Sent to Artisans` sang `Artisans Bidding` và ghi lịch sử.

**Ngoại lệ:** Với gửi/sửa nội dung: hết hạn/đóng sớm, hộ tạm ngừng, yêu cầu đã chấp nhận/hủy hoặc hộ không được mời thì từ chối. Phiên bản cũ hoặc Buyer đóng nhận/chấp nhận đồng thời: kiểm tra lại trước khi lưu. Không tạo báo giá thứ hai cho cùng hộ và yêu cầu; rút báo giá theo luồng riêng bên dưới, không bị chặn chỉ vì đã đóng nhận.

**Hậu điều kiện:** Buyer và Admin thấy báo giá hiện hành; hộ khác không thấy giá hoặc khả năng nhận của hộ này.

**Hiệu lực và rút báo giá:** Hộ tự chọn hạn chấp nhận đủ sớm để có thể giao đúng cam kết nếu Buyer chấp nhận sát hạn đó. Hạn này phải từ hạn nhận báo giá cộng 24 giờ trở đi và trước hạn giao cam kết. Dùng hạn nhận đã chốt trên yêu cầu, không dùng thời điểm đóng sớm; đóng sớm không thay đổi cam kết. Đây là khoảng so sánh/điều phối tối thiểu của MVP; báo giá chỉ được chọn khi còn hiệu lực. Chưa tự giữ chỗ công suất giữa các yêu cầu. Khi yêu cầu chưa chốt và chưa hủy, hộ sở hữu báo giá được rút cả khi đã đóng nhận hoặc hộ tạm ngừng, bắt buộc lý do; giữ nội dung báo giá, ghi người/thời điểm/lý do, tăng phiên bản và loại khỏi khả năng đáp ứng. Phương án đề xuất chứa báo giá vừa rút hết hiệu lực; Buyer và hàng chờ Admin thấy lý do. Báo giá đã rút không tự khôi phục; nếu còn mở nhận, hộ hoạt động được gửi lại trên cùng bản ghi với phiên bản mới và dữ liệu hợp lệ. Sau đóng nhận không gửi lại. Rút lặp giữ kết quả cũ. Nếu rút và chấp nhận đồng thời: rút trước thì chấp nhận thất bại; chấp nhận trước thì không được rút. Sau khi nhận một đơn, hộ phải rà soát và rút/sửa các báo giá khác nếu không còn đủ khả năng.

**Không tham gia chào giá:** Hộ thuộc danh sách nhận được chọn “Không tham gia” khi yêu cầu còn mở, chưa chốt/hủy và hộ chưa từng gửi báo giá cho yêu cầu đó; hộ tạm ngừng vẫn được từ chối lời mời cũ. Lý do tùy chọn. Lưu người, thời điểm, lý do, kiểm tra phiên bản của phản hồi; thao tác lặp không tạo thêm phản hồi. Không thao tác vẫn là “chưa phản hồi”, không tự đổi thành từ chối khi hết hạn. Khi đổi ý, hộ hoạt động được gửi báo giá nếu còn mở; phản hồi chuyển thành “đã chào giá”, giữ dấu vết từ chối trước đó. Nếu đã từng có báo giá thì không dùng nhánh này: báo giá hiện hành dùng rút báo giá; báo giá đã rút chỉ gửi lại theo điều kiện hiện có. Từ chối không tạo báo giá, không tăng khả năng đáp ứng và không chuyển yêu cầu sang Artisans Bidding. Gửi báo giá/từ chối/đóng nhận đồng thời phải kiểm tra nguyên tử, không để một hộ vừa từ chối vừa có báo giá hiện hành.

<a id="uc-17"></a>
## UC-17 — Đóng nhận báo giá

- **Tác nhân:** Buyer đóng sớm; Hệ thống ghi nhận hết hạn. **Quy tắc:** BR-12, BR-27.
- **Mục tiêu/kích hoạt:** Ngừng nhận/sửa báo giá khi Buyer chọn đóng hoặc thời gian đạt hạn.
- **Tiền điều kiện:** Yêu cầu đã gửi, chưa chấp nhận/hủy. Buyer chỉ đóng yêu cầu của mình.
- **Dữ liệu:** Yêu cầu, thời điểm máy chủ, hạn nhận và phiên bản.

**Luồng chính**

1. Buyer chọn đóng sớm; hệ thống cho xem tác động không mở lại và yêu cầu xác nhận.
2. Hệ thống kiểm tra quyền, trạng thái và lưu `bidding_closed_at` bằng thời điểm đóng.
3. Hệ thống chặn báo giá mới và sửa nội dung; vẫn cho rút báo giá chưa chốt theo UC-16, giữ báo giá còn đủ điều kiện để xét chọn.

**Luồng khác/ngoại lệ:** Nếu đã đến hạn, yêu cầu được coi là đóng ngay cả khi tác vụ nền chưa chạy; thời điểm đóng ghi bằng hạn nhận. Đóng lặp không thay đổi thời điểm đã ghi. Không cần có báo giá mới được đóng; nếu không đủ khả năng đáp ứng, Buyer dùng UC-27 và có thể tạo mới. Chấp nhận trực tiếp cũng đóng nhận trong UC-19.

**Hậu điều kiện:** Trạng thái chính vẫn là `Sent to Artisans` hoặc `Artisans Bidding`; không tự hủy, chấp nhận hoặc gia hạn.

<a id="uc-18"></a>
## UC-18 — Theo dõi yêu cầu và báo giá

- **Tác nhân:** Buyer, Artisan, Admin. **Quy tắc:** BR-04, BR-15, BR-18, BR-23.
- **Mục tiêu/kích hoạt:** Mở danh sách hoặc chi tiết yêu cầu để biết tiến độ và thao tác còn được phép.
- **Tiền điều kiện:** Buyer sở hữu yêu cầu; Artisan nằm trong danh sách nhận; hoặc Admin.
- **Dữ liệu:** Yêu cầu được chọn.

**Luồng chính**

1. Người dùng mở danh sách yêu cầu thuộc phạm vi quyền của mình.
2. Hệ thống trả trạng thái chính, trạng thái đóng nhận/hủy và dữ liệu theo BR-04. Hộ chỉ nhận lời mời xem phần chào giá và khu vực giao khái quát; không trả liên hệ/địa chỉ chi tiết hoặc lịch sử các trường đó. Hộ có phần việc đã chốt được xem thông tin bàn giao đầy đủ để thực hiện và đối chiếu sau hoàn tất/hủy.
3. Buyer sở hữu và Admin xem các báo giá, phương án và phần việc. Artisan chỉ xem báo giá/phần việc của hộ mình, không xem phương án tổng thể, đơn giá hoặc phân bổ hộ khác.
4. Với yêu cầu chưa chấp nhận, hệ thống xác định báo giá đủ điều kiện và tổng khả năng đáp ứng; phương án có hộ tạm ngừng, báo giá đã rút hoặc hạn chấp nhận báo giá đã tới bị đánh dấu hết hiệu lực.
5. Giao diện hiển thị thao tác phù hợp: chọn trực tiếp, đóng nhận, nhờ chia, xem phương án, cập nhật phần việc, xác nhận nhận đủ hoặc hủy.

**Ngoại lệ:** Nếu yêu cầu đang Artisans Bidding nhưng không còn báo giá đủ điều kiện, danh sách và chi tiết của Buyer/Admin hiển thị “Không còn báo giá hợp lệ”, giữ trạng thái chính. Còn mở nhận thì hướng dẫn tiếp tục chờ; đã đóng thì hướng dẫn hủy và sao chép thành nháp mới. Nếu có báo giá hợp lệ trở lại thì bỏ nhãn nhưng không khôi phục phương án hết hiệu lực. Nhãn này khác với trường hợp còn báo giá hợp lệ nhưng tổng số lượng chưa đủ. Đủ số lượng tổng không đồng nghĩa có thể chấp nhận trực tiếp một hộ. Thiếu khả năng đáp ứng sau đóng nhận: hiển thị lý do, không cho chia thiếu; Buyer có thể hủy và tạo mới. Yêu cầu đã hủy vẫn xem dữ liệu/lịch sử theo quyền nhưng không tiếp tục xử lý.

**Hậu điều kiện:** Người dùng thấy dữ liệu đúng quyền và điều kiện hiện tại; không tự tạo phương án hoặc phần việc. Các kiểm tra vẫn phải lặp lại khi thao tác, không chỉ lúc hiển thị nút.

**Buyer xem danh sách hộ được gửi yêu cầu:** Buyer sở hữu và Admin xem danh sách nhận đã lưu lúc UC-15, gồm mã/tên hộ, thời điểm gửi đến và tình trạng phản hồi: chưa phản hồi, không tham gia, đã chào giá hoặc đã rút báo giá. Hiển thị thời điểm/lý do từ chối hoặc rút nếu có; báo giá hết hạn vẫn là đã chào giá nhưng có nhãn hết hạn/mất điều kiện riêng, hộ tạm ngừng có nhãn riêng. “Đã gửi đến hộ” nghĩa là yêu cầu xuất hiện trong danh sách của hộ, không khẳng định đã đọc; chưa theo dõi đã xem. Artisan chỉ xem mục phản hồi/báo giá của mình, không xem danh sách phản hồi hộ khác. Tên hộ trong danh sách nhận là dữ liệu riêng của yêu cầu, vẫn xem được khi hộ tạm ngừng, không mở lại hồ sơ công khai bị ẩn. Danh sách nhận không tự bổ sung hộ mới hoặc xóa hộ đã từ chối/tạm ngừng; hộ không tham gia vẫn có quyền đọc yêu cầu đã nhận.

<a id="uc-19"></a>
## UC-19 — Chấp nhận trực tiếp một báo giá

- **Tác nhân:** Buyer. **Quy tắc:** BR-16, BR-19, BR-20, BR-26, BR-27.
- **Mục tiêu/kích hoạt:** Giao toàn bộ yêu cầu cho một hộ.
- **Tiền điều kiện:** Yêu cầu của Buyer ở `Artisans Bidding`, chưa hủy; có báo giá đủ điều kiện nhận toàn bộ số lượng. Không bắt buộc chờ hết hạn.
- **Dữ liệu:** Báo giá chọn, phiên bản yêu cầu/báo giá và xác nhận của Buyer.

**Luồng chính**

1. Buyer chọn báo giá; hệ thống hiển thị hộ, số lượng, đơn giá, tổng tiền hàng, hạn chấp nhận, thời hạn giao cam kết và thông tin bàn giao hiện hành.
2. Buyer xem lưu ý phí vận chuyển thỏa thuận ngoài hệ thống và xác nhận.
3. Hệ thống kiểm tra lại quyền, phiên bản, trạng thái hủy, hộ hoạt động, báo giá chưa rút, khả năng nhận đủ và hạn chấp nhận báo giá chưa tới.
4. Trong cùng thao tác, đóng nhận nếu còn mở, lưu một phần việc cố định và chuyển yêu cầu sang `Buyer Accepted`.
5. Hệ thống làm hết hiệu lực phương án chia đang chờ nếu có, loại yêu cầu khỏi hàng chờ và ghi lịch sử.

**Ngoại lệ:** Báo giá thay đổi, hộ bị tạm ngừng, hết hạn chấp nhận báo giá, yêu cầu đã hủy/chốt: không chấp nhận theo màn hình cũ; tải lại. Gửi lại đúng lựa chọn và phiên bản báo giá đã chốt trả kết quả cũ, không thêm phần việc; chọn báo giá/phương án khác hoặc phiên bản khác báo xung đột và hiển thị lựa chọn đã chốt, không báo thành công cho lựa chọn mới. Nếu một bước lưu thất bại, không để yêu cầu đã chấp nhận mà thiếu phần việc.

**Hậu điều kiện:** Một phần việc đủ số lượng; hộ, giá, số lượng và thời hạn cam kết đã cố định. Không tạo thực thể đơn hàng mới.

<a id="uc-20"></a>
## UC-20 — Nhờ Ban quản lý chia đơn

- **Tác nhân:** Buyer. **Quy tắc:** BR-17, BR-23, BR-27.
- **Mục tiêu/kích hoạt:** Yêu cầu Admin lập phương án nhiều hộ.
- **Tiền điều kiện:** Yêu cầu của Buyer ở `Artisans Bidding`, đã đóng nhận, chưa chấp nhận/hủy; có ít nhất hai báo giá đủ điều kiện có thể phân bổ số lượng nguyên dương cho ít nhất hai hộ và tổng khả năng đủ. Vẫn được nhờ chia dù có hộ nhận được toàn bộ.
- **Dữ liệu:** Yêu cầu và phiên bản.

**Luồng chính**

1. Buyer chọn “Nhờ Ban quản lý chia đơn”.
2. Hệ thống kiểm tra lại điều kiện và ghi `split_requested_at`.
3. Yêu cầu xuất hiện trong hàng chờ Admin; Buyer thấy đang chờ phương án.

**Ngoại lệ:** Còn mở nhận: yêu cầu đóng trước qua UC-17. Có hộ đủ toàn bộ: Buyer được so sánh chọn trực tiếp với nhờ chia; không ép chọn trực tiếp. Tổng không đủ: không tạo yêu cầu chia, cho Buyer hủy/tạo mới. Bấm lặp giữ một mục hàng chờ, không đổi mốc yêu cầu ban đầu.

**Hậu điều kiện:** Trạng thái chính không đổi; chưa có phần việc hay cam kết mua hàng. Không gửi thông báo email/SMS.

<a id="uc-21"></a>
## UC-21 — Lập phương án chia đơn

- **Tác nhân:** Admin. **Quy tắc:** BR-17–BR-19, BR-27.
- **Mục tiêu/kích hoạt:** Mở hàng chờ để lập hoặc lập lại phương án.
- **Tiền điều kiện:** Đã có `split_requested_at`, đã đóng nhận, yêu cầu chưa chấp nhận/hủy; còn đủ khả năng đáp ứng từ báo giá hợp lệ.
- **Dữ liệu:** Các hộ được chọn, số lượng từng hộ, phiên bản yêu cầu và báo giá/phương án liên quan.

**Luồng chính**

1. Admin mở yêu cầu trong hàng chờ, xem báo giá đủ điều kiện và lý do cần lập lại nếu có.
2. Admin chọn hộ và nhập số lượng; đơn giá, thời hạn cam kết lấy từ báo giá, không tự sửa.
3. Hệ thống kiểm tra mỗi hộ chỉ xuất hiện một lần, ít nhất hai hộ, số lượng nguyên dương không vượt đã chào và tổng đúng bằng yêu cầu.
4. Hệ thống kiểm tra lại điều kiện/phiên bản và lưu phương án trạng thái đề xuất; phương án đề xuất cũ hết hiệu lực nếu được thay thế.
5. Buyer xem phương án trong chi tiết yêu cầu để quyết định.

**Ngoại lệ:** Phân bổ thiếu/thừa/trùng hộ hoặc hộ không còn đủ điều kiện: từ chối, giữ phương án đang có nếu còn hợp lệ. Nếu không còn đủ khả năng, hàng chờ hiển thị lý do, không tự hạ số lượng yêu cầu. Nếu thời hạn hoặc trạng thái hộ khiến phương án cũ hết hiệu lực, không khôi phục tự động khi hộ hoạt động lại.

**Hậu điều kiện:** Có tối đa một phương án đề xuất hiện hành; chưa tạo phần việc chính thức, Admin chưa chấp nhận thay Buyer.

**Hàng chờ điều phối:** Phân biệt “chờ Admin lập”, “cần lập lại”, “chờ Buyer quyết định” và “không đủ báo giá hợp lệ”; đây là nhãn theo dõi, không phải trạng thái chính mới. Hiển thị thời điểm nhờ chia, thời gian đã chờ, lý do từ chối/mất hiệu lực và hạn chấp nhận gần nhất của các báo giá hợp lệ (hoặc của phương án đang chờ). Danh sách mặc định theo thời điểm nhờ chia từ cũ đến mới; không có cơ chế chấm điểm hoặc tự điều phối ưu tiên. Mục thiếu khả năng vẫn hiện cùng lý do, không tự xóa. Buyer thấy nhãn chờ và hạn quyết định trên danh sách yêu cầu. Không cần email/SMS. Nếu chỉ còn một hộ đủ nhận toàn bộ, hướng Buyer sang UC-19; không tạo phương án chia một hộ.

<a id="uc-22"></a>
## UC-22 — Chấp nhận hoặc từ chối phương án

- **Tác nhân:** Buyer. **Quy tắc:** BR-18–BR-20, BR-26, BR-27.
- **Mục tiêu/kích hoạt:** Quyết định phương án chia đơn của yêu cầu mình.
- **Tiền điều kiện:** Yêu cầu ở `Artisans Bidding`, chưa hủy/chấp nhận; có phương án đề xuất hiện hành.
- **Dữ liệu:** Phương án, phiên bản yêu cầu/phương án và quyết định.

**Luồng chính**

1. Buyer xem từng hộ, số lượng, đơn giá, thời hạn giao cam kết, hình thức bàn giao và tổng tiền hàng; hạn quyết định của phương án là hạn chấp nhận sớm nhất trong các báo giá được chọn.
2. Hệ thống hiển thị phí vận chuyển thỏa thuận ngoài hệ thống; Buyer xác nhận chấp nhận toàn bộ phương án.
3. Hệ thống kiểm tra lại phiên bản, điều kiện từng báo giá và tổng phân bổ bằng số lượng yêu cầu.
4. Trong một thao tác, hệ thống tạo các phần việc cố định, đánh dấu phương án đã chấp nhận, chuyển yêu cầu sang `Buyer Accepted`, loại khỏi hàng chờ và ghi lịch sử.

**Luồng khác/ngoại lệ**

- Buyer từ chối phải nhập lý do; lưu người/thời điểm/lý do để Admin xem khi lập lại. Phương án hết hiệu lực, yêu cầu giữ trạng thái chính và quay về hàng chờ cần lập lại; chưa tạo phần việc. Buyer có thể chọn hủy qua UC-27.
- Phiên bản cũ: từ chối và tải lại trạng thái hiện tại, không tự đánh dấu hết hiệu lực chỉ vì phiên bản cũ. Phương án bị thay thế/từ chối, có hộ tạm ngừng, báo giá bị rút hoặc đã tới hạn chấp nhận: hết hiệu lực và hiển thị lý do. Phương án đã chấp nhận giữ nguyên trạng thái đã chấp nhận.
- Không chấp nhận riêng một phần phương án hoặc tự sửa số lượng. Nếu có báo giá đủ toàn bộ, Buyer có thể chuyển sang UC-19.
- Chấp nhận đồng thời/lặp: chỉ một kết quả được chốt; đúng phương án và phiên bản đã chốt thì trả kết quả cũ, lựa chọn/phiên bản khác thì báo xung đột. Không tạo trùng phần việc, ghi một phần phương án hoặc ghi đè trạng thái đã chấp nhận. Từ chối cũng phải kiểm tra phiên bản và yêu cầu chưa chốt/hủy; không được từ chối phương án đã chấp nhận.

**Hậu điều kiện:** Chấp nhận tạo đầy đủ phần việc và cố định điều kiện; từ chối giữ yêu cầu chưa chốt, không tự hủy.

<a id="uc-23"></a>
## UC-23 — Bắt đầu phần việc và gắn lô

- **Tác nhân:** Artisan. **Quy tắc:** BR-05, BR-20, BR-24, BR-26, BR-27.
- **Mục tiêu/kích hoạt:** Bắt đầu phần việc đã nhận và tùy chọn liên kết lô truy xuất.
- **Tiền điều kiện:** Phần việc đã chốt thuộc hộ; yêu cầu ở `Buyer Accepted` hoặc `In Production`, chưa hủy. Hộ tạm ngừng vẫn được thực hiện.
- **Dữ liệu:** Phần việc, phiên bản phần việc và danh sách lô tùy chọn; mỗi liên kết gồm lô và số lượng thuộc phần việc.

**Luồng chính**

1. Artisan mở phần việc, xem số lượng, giá, thời hạn cam kết và hình thức bàn giao đã chốt.
2. Artisan chọn bắt đầu, có thể chọn một hoặc nhiều lô của hộ mình và số lượng tương ứng.
3. Hệ thống kiểm tra quyền, trạng thái và lô nếu có; chuyển phần việc từ chưa bắt đầu sang đang sản xuất.
4. Nếu đây là phần việc đầu tiên bắt đầu, hệ thống chuyển yêu cầu từ `Buyer Accepted` sang `In Production` và ghi lịch sử.

**Luồng khác/ngoại lệ**

- Khi đang sản xuất, Artisan có thể thêm, sửa hoặc bỏ liên kết lô của hộ; không đổi giá, số lượng hay thời hạn đã chốt.
- Không chọn lô vẫn được bắt đầu. Chọn lô nháp vẫn tạo được liên kết nhưng Buyer chưa truy xuất công khai; chỉ mở QR sau UC-11.
- Lô của hộ khác, phần việc đã báo giao hoặc yêu cầu đã hủy: từ chối cập nhật. Không tự tạo lô mới khi bắt đầu.
- Bắt đầu lặp không làm phát sinh phần việc hoặc ghi thêm lần chuyển `In Production`; hộ khác bắt đầu sau đó không chuyển lại trạng thái yêu cầu.

**Hậu điều kiện:** Phần việc đang sản xuất, có thể không liên kết hoặc liên kết nhiều lô. Các phần việc khác giữ nguyên tiến độ.

**Quy tắc liên kết lô:** Một lô chỉ xuất hiện một lần trong cùng phần việc, thuộc cùng hộ; số lượng liên kết là số nguyên dương và cùng đơn vị chiếc/bộ của phần việc. Khi lưu liên kết, tổng số lượng liên kết không vượt số lượng phần việc. Nếu tổng nhỏ hơn số lượng phần việc hoặc có lô chưa công bố, hiển thị “truy xuất chưa đầy đủ”; không liên kết thì hiển thị “chưa có dữ liệu truy xuất”. Đây là mức độ hoàn thiện truy xuất, không phải số lượng đã giao. Giao đủ trên thực tế vẫn được ghi nhận bàn giao và xác nhận nhận đủ; không buộc thêm hoặc xóa liên kết để chuyển trạng thái. Lô nháp được liên kết và giữ số lượng nhưng chưa mở QR công khai. Khóa toàn bộ liên kết sau báo giao. Các số lượng này phục vụ truy xuất, chưa phải quản lý tồn kho/công suất; không tự suy luận một lô đã được sử dụng hết trên các đơn khác.

<a id="uc-24"></a>
## UC-24 — Ghi nhận bàn giao phần việc

- **Tác nhân:** Artisan; Admin trong ngoại lệ ghi nhận thay. **Quy tắc:** BR-24, BR-26, BR-27.
- **Mục tiêu/kích hoạt:** Ghi nhận hộ đã bàn giao đủ phần việc.
- **Tiền điều kiện:** Luồng Artisan cần phần việc của hộ đang sản xuất, yêu cầu In Production và chưa hủy; hộ đã bàn giao đủ số lượng theo hình thức nhận hàng cố định. Luồng Admin dùng điều kiện riêng trong ngoại lệ ghi nhận thay bên dưới.
- **Dữ liệu:** Phần việc, xác nhận bàn giao và phiên bản phần việc; Admin ghi nhận thay còn cần lý do, căn cứ, thời điểm bàn giao thực tế.

**Luồng chính**

1. Artisan kiểm tra số lượng và thông tin bàn giao, chọn báo đã giao.
2. Hệ thống kiểm tra quyền và trạng thái hiện tại.
3. Hệ thống chuyển phần việc sang “đã ghi nhận bàn giao”, lưu người thực hiện và thời điểm, khóa thay đổi liên kết lô. Người ghi nhận là Artisan hoặc Admin theo luồng tương ứng; trạng thái này chưa phải Buyer xác nhận nhận đủ.
4. Buyer và Admin thấy tiến độ cập nhật; nếu mọi phần việc đã được ghi nhận bàn giao, Buyer được thực hiện UC-25.

**Ngoại lệ:** Phần việc chưa bắt đầu: cả Artisan và Admin không được ghi nhận bàn giao ngay. Liên hệ hộ xác minh và cập nhật bước bắt đầu qua UC-23 trước; không tự tạo bước bắt đầu từ thao tác bàn giao. Chỉ giao một phần: không ghi nhận là đã giao đủ; chưa có luồng giao thiếu. Hủy đồng thời: không lưu cập nhật sau khi hủy đã có hiệu lực. Thao tác lặp giữ kết quả đã có. Giao quá thời hạn vẫn ghi tiến độ thực tế, không tự hủy.

**Hậu điều kiện:** Yêu cầu vẫn `In Production`, kể cả mọi phần việc đã được ghi nhận bàn giao; chưa đồng nghĩa Buyer xác nhận nhận đủ. Không bắt buộc lô đã công bố để báo giao.

**Ghi nhận bàn giao thay hộ:** Khi có căn cứ xác minh hộ đã bàn giao đủ nhưng Artisan chưa cập nhật/không truy cập được, Admin chỉ được thực hiện trên phần việc đang sản xuất của yêu cầu In Production, chưa hủy. Bắt buộc lý do, căn cứ nhận đủ và thời điểm bàn giao thực tế không ở tương lai; ghi riêng thời điểm hệ thống ghi nhận, người thực hiện và trạng thái trước/sau. Nếu phần việc chưa bắt đầu, từ chối và hướng dẫn liên hệ hộ xác minh/cập nhật UC-23; khi hộ không truy cập được thì khôi phục quyền truy cập theo quy trình tài khoản trước. Admin không tạo bước bắt đầu, không chuyển yêu cầu Buyer Accepted sang In Production qua ngoại lệ này. Trường hợp chưa thể khôi phục vẫn cần xử lý ngoài hệ thống; đây là giới hạn MVP, không được bỏ qua bằng lịch sử sản xuất giả định. Buyer thấy nổi bật nhãn “Admin ghi nhận bàn giao thay hộ” tại phần việc và lịch sử, kèm người thực hiện, thời điểm, lý do và căn cứ có thể mở xem theo quyền. Hiển thị mức độ hoàn thiện truy xuất theo UC-23; thiếu liên kết hoặc lô chưa công bố không chặn ghi nhận bàn giao. Admin không tự sửa dữ liệu truy xuất của hộ. Thao tác này không xác nhận toàn bộ yêu cầu đã hoàn tất; Buyer tiếp tục UC-25 hoặc Admin thực hiện riêng UC-26 với căn cứ. Thiếu căn cứ, chỉ biết Artisan im lặng hoặc giao thiếu thì từ chối. Thao tác lặp không ghi đè người đã ghi nhận; hủy/ghi nhận đồng thời phải kiểm tra nguyên tử.

<a id="uc-25"></a>
## UC-25 — Xác nhận nhận đủ

- **Tác nhân:** Buyer. **Quy tắc:** BR-25–BR-27.
- **Mục tiêu/kích hoạt:** Xác nhận đã nhận đủ toàn bộ yêu cầu.
- **Tiền điều kiện:** Buyer sở hữu yêu cầu ở `In Production`, chưa hủy; mọi phần việc ở trạng thái “đã ghi nhận bàn giao”.
- **Dữ liệu:** Yêu cầu, phiên bản và xác nhận của Buyer.

**Luồng chính**

1. Buyer xem các phần việc và chọn xác nhận đã nhận đủ.
2. Hệ thống kiểm tra lại quyền, phiên bản, trạng thái hủy và toàn bộ phần việc.
3. Hệ thống chuyển yêu cầu sang `Delivered`, ghi người xác nhận, thời điểm và lịch sử trạng thái.

**Ngoại lệ:** Còn phần việc chưa được ghi nhận bàn giao: từ chối, chỉ rõ phần việc còn thiếu; nếu thực tế đã nhận đủ thì liên hệ hộ cập nhật hoặc Admin xác minh qua UC-24. Buyer thực tế chưa nhận đủ: không xác nhận; chưa có luồng nhận từng phần/tranh chấp. Yêu cầu hủy hoặc phiên bản thay đổi: tải lại trước thao tác. Xác nhận lặp không tạo lịch sử hoàn tất lần hai.

**Hậu điều kiện:** Yêu cầu `Delivered`, không được hủy hoặc quay lại sản xuất; không phát sinh thanh toán tự động.

<a id="uc-26"></a>
## UC-26 — Xác nhận nhận đủ thay Buyer

- **Tác nhân:** Admin. **Quy tắc:** BR-25–BR-27.
- **Mục tiêu/kích hoạt:** Hoàn tất yêu cầu trong ngoại lệ đã xác minh nhận đủ.
- **Tiền điều kiện:** Yêu cầu `In Production`, chưa hủy; mọi phần việc đã được ghi nhận bàn giao (do hộ hoặc Admin ghi nhận có căn cứ qua UC-24); Admin có căn cứ Buyer nhận đủ.
- **Dữ liệu:** Yêu cầu, lý do xác nhận thay, căn cứ xác minh và phiên bản.

**Luồng chính**

1. Admin xem toàn bộ tiến độ và chọn xác nhận thay.
2. Admin ghi lý do, căn cứ xác minh và xác nhận thao tác.
3. Hệ thống kiểm tra dữ liệu bắt buộc cùng điều kiện giao hàng và trạng thái hủy.
4. Hệ thống chuyển sang Delivered; Buyer thấy nổi bật “Admin xác nhận nhận đủ thay Buyer” trên chi tiết yêu cầu và lịch sử, kèm người thực hiện, thời điểm, lý do, căn cứ có thể mở xem theo quyền. Nếu cùng Admin từng ghi nhận bàn giao thay hộ, vẫn hiển thị hai sự kiện riêng. Không hiển thị hoặc trả dữ liệu khẳng định Buyer tự xác nhận. Căn cứ không được truy cập công khai qua QR.

**Ngoại lệ:** Chỉ có lý do Buyer không phản hồi, không có căn cứ nhận đủ: không xác nhận thay. Thiếu lý do/căn cứ hoặc còn phần việc chưa được ghi nhận bàn giao: từ chối. Buyer đã xác nhận đồng thời: giữ kết quả hoàn tất đầu tiên, không ghi đè người xác nhận. Yêu cầu đã hủy: không hoàn tất.

**Hậu điều kiện:** Yêu cầu hoàn tất với dấu vết xác nhận thay; không có lịch tự xác nhận sau 7 ngày hoặc thời hạn khác.

<a id="uc-27"></a>
## UC-27 — Hủy yêu cầu

- **Tác nhân:** Buyer trước chấp nhận; Admin sau chấp nhận. **Quy tắc:** BR-21–BR-23, BR-26, BR-27.
- **Mục tiêu/kích hoạt:** Dừng toàn bộ yêu cầu khi người có quyền chọn hủy.
- **Tiền điều kiện:** Chưa hủy, chưa `Delivered`. Buyer sở hữu yêu cầu ở Sent to Artisans hoặc Artisans Bidding; Admin thực hiện khi đã `Buyer Accepted` hoặc `In Production`.
- **Dữ liệu:** Yêu cầu, phiên bản, lý do; Admin bắt buộc nhập lý do.

**Luồng chính**

1. Người dùng mở yêu cầu, chọn hủy và xem tác động không thể khôi phục, áp dụng toàn bộ phần việc.
2. Người dùng nhập lý do theo quyền và xác nhận.
3. Hệ thống kiểm tra lại quyền theo trạng thái hiện tại, phiên bản và việc chưa hoàn tất.
4. Hệ thống ghi thời điểm, người hủy và lý do; giữ nguyên trạng thái chính cuối cùng, đánh dấu rõ đã hủy và ghi lịch sử.
5. Phương án đề xuất hết hiệu lực, yêu cầu rời hàng chờ. Chặn báo giá, phân bổ, tiến độ và xác nhận nhận hàng tiếp theo.

**Luồng khác/ngoại lệ**

- Buyer muốn hủy sau khi chấp nhận: không được trực tiếp thao tác; việc trao đổi với Admin diễn ra ngoài hệ thống, chưa có luồng gửi đơn xin hủy.
- Admin có thể hủy khi mọi phần việc đã được ghi nhận bàn giao nhưng Buyer/Admin chưa xác nhận nhận đủ. `Delivered` thì không được hủy.
- Bản nháp chỉ xóa qua UC-14, không có thao tác hủy; gọi hủy nháp trực tiếp cũng bị từ chối, không tạo dấu hủy hoặc lịch sử hủy. Xóa đồng thời với gửi phải kiểm tra trạng thái/phiên bản: gửi trước thì không xóa được, xóa trước thì không gửi được.
- Hủy đồng thời với chấp nhận/nhận đủ phải kiểm tra nhất quán; thao tác sau không được dùng trạng thái cũ. Hủy lặp trả kết quả cũ, không thêm bản ghi hủy.

**Hậu điều kiện:** Giữ toàn bộ báo giá, phân bổ, tiến độ và lịch sử; không đặt lại phần việc, không hủy riêng từng hộ, không khôi phục yêu cầu. Buyer có thể tạo yêu cầu mới. Hoàn tiền, bồi hoàn và xử lý hàng đã giao nằm ngoài hệ thống.

**Đơn có phần đã giao:** Trước khi hủy, Admin xem từng phần việc đã/chưa báo giao và phải ghi rõ lý do dừng cùng cách xử lý ngoài hệ thống đối với hàng đã bàn giao. Sau hủy vẫn hiển thị trạng thái từng phần việc và tổng số lượng thuộc các phần đã báo giao; số này không phải xác nhận Buyer đã nhận đủ. Không đặt lại tiến độ hoặc ngụ ý toàn bộ hàng chưa giao. Giao thiếu trong một phần việc được ghi vào lý do/căn cứ ngoài hệ thống, chưa theo dõi số lượng nhận từng đợt. Không tự sinh đơn thay thế, hoàn tiền hoặc chuyển hộ.

