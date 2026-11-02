# Tài khoản, xưởng và danh mục

[Mục lục và quy ước chung](../use-cases.md) · [Quy tắc nghiệp vụ](../business-rules.md)

<a id="uc-01"></a>
## UC-01 — Đăng ký Buyer

- **Tác nhân:** Khách. **Quy tắc:** BR-01.
- **Mục tiêu/kích hoạt:** Tạo tài khoản để gửi yêu cầu mua sỉ; chọn đăng ký.
- **Tiền điều kiện:** Chưa đăng nhập.
- **Dữ liệu:** Thông tin định danh và thông tin xác thực theo chính sách tài khoản được chọn.

**Luồng chính**

1. Khách nhập thông tin đăng ký và gửi.
2. Hệ thống kiểm tra định dạng, tính duy nhất của định danh và thông tin xác thực.
3. Hệ thống tạo tài khoản với vai trò Buyer và hướng dẫn đăng nhập.

**Ngoại lệ:** Thiếu/sai thông tin hoặc định danh đã tồn tại: không tạo tài khoản, cho sửa. Dữ liệu gửi kèm quyền Artisan/Admin không được dùng để cấp quyền.

**Hậu điều kiện:** Có một tài khoản Buyer; chưa phát sinh yêu cầu báo giá.

<a id="uc-02"></a>
## UC-02 — Đăng nhập và đăng xuất

- **Tác nhân:** Buyer, Artisan, Admin. **Quy tắc:** BR-01, BR-03, BR-05.
- **Mục tiêu/kích hoạt:** Mở hoặc kết thúc phiên làm việc.
- **Tiền điều kiện:** Có tài khoản; đăng xuất cần phiên đang hoạt động.
- **Dữ liệu:** Định danh và thông tin xác thực.

**Luồng chính**

1. Người dùng gửi thông tin đăng nhập.
2. Hệ thống xác thực tài khoản và tạo phiên gắn với vai trò, hộ sở hữu nếu có.
3. Hệ thống hiển thị khu vực chức năng theo quyền.
4. Khi người dùng chọn đăng xuất, hệ thống kết thúc phiên.

**Ngoại lệ:** Sai thông tin: không tạo phiên. Phiên hết hiệu lực: yêu cầu đăng nhập lại trước thao tác riêng tư. Hộ tạm ngừng vẫn được đăng nhập để hoàn thành việc đã chốt; đăng nhập thành công không khôi phục quyền nhận việc mới.

**Hậu điều kiện:** Phiên hợp lệ được tạo hoặc bị kết thúc; trạng thái vận hành hộ không thay đổi.

<a id="uc-03"></a>
## UC-03 — Cấp tài khoản hộ

- **Tác nhân:** Admin. **Quy tắc:** BR-01, BR-02, BR-05, BR-28.
- **Mục tiêu/kích hoạt:** Đưa hộ đã xác minh vào hệ thống.
- **Tiền điều kiện:** Admin đã xác minh hộ thuộc làng nghề ngoài hệ thống.
- **Dữ liệu:** Thông tin hộ, hồ sơ xưởng ban đầu và định danh tài khoản Artisan.

**Luồng chính**

1. Admin nhập thông tin hộ và tài khoản.
2. Hệ thống kiểm tra thông tin và định danh tài khoản chưa được dùng.
3. Hệ thống tạo hồ sơ, tài khoản Artisan liên kết đúng hộ và trạng thái hộ `hoạt động`.
4. Admin bàn giao thông tin truy cập ngoài hệ thống; Artisan hoàn thiện hồ sơ qua UC-05.

**Ngoại lệ:** Thông tin sai hoặc trùng định danh: từ chối tạo. Hồ sơ chưa đủ tên, địa chỉ, giới thiệu và ảnh vẫn là hồ sơ ban đầu, chưa hiển thị công khai. Không có bước Artisan tự nộp đơn hoặc tự duyệt.

**Hậu điều kiện:** Tài khoản gắn với đúng một hồ sơ hộ; không tự cấp chứng nhận chất lượng.

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
- **Mục tiêu/kích hoạt:** Tạo, sửa hoặc xóa phân loại sản phẩm của làng nghề.
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
- **Tiền điều kiện:** Artisan sở hữu sản phẩm và lô được chọn; đã có lô khi tạo sản phẩm.
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
- **Mục tiêu/kích hoạt:** Tìm hiểu làng nghề qua danh mục hoặc bản đồ.
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
- **Dữ liệu:** Tiêu đề, nội dung và một loại tin theo BR-29.

**Luồng chính**

1. Admin soạn hoặc sửa tin và lưu nháp.
2. Admin chọn công bố; hệ thống kiểm tra đủ tiêu đề, nội dung, loại tin.
3. Hệ thống đưa tin vào danh sách công khai; khách mở danh sách và nội dung tin.

**Luồng khác/ngoại lệ:** Admin đưa tin về nháp để gỡ công khai. Khách không xem được tin nháp dù biết địa chỉ. Vai trò khác không được tạo/sửa/công bố tin. Nội dung thiếu trường bắt buộc không được công bố.

**Hậu điều kiện:** Tin hiển thị theo trạng thái; công bố tin không gửi email/SMS hoặc tạo thông báo cá nhân.
