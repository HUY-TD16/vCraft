# Yêu cầu báo giá và phân bổ

[Mục lục và quy ước chung](../use-cases.md) · [Quy tắc nghiệp vụ](../business-rules.md)

<a id="uc-14"></a>
## UC-14 — Soạn yêu cầu nháp

- **Tác nhân:** Buyer. **Quy tắc:** BR-11.
- **Mục tiêu/kích hoạt:** Chuẩn bị yêu cầu mua sỉ; chọn tạo yêu cầu hoặc mở bản nháp của mình.
- **Tiền điều kiện:** Buyer đã đăng nhập.
- **Dữ liệu:** Một phân loại, quy cách, số lượng, đơn vị tính, hạn nhận báo giá, hạn giao, tên người nhận, số điện thoại, hình thức nhận hàng và địa chỉ nếu nhận tại địa chỉ Buyer.

**Luồng chính**

1. Buyer nhập thông tin và chọn lưu nháp.
2. Hệ thống lưu yêu cầu thuộc Buyer ở `Draft Request`; chưa xác định/gửi cho các hộ.
3. Buyer mở lại để sửa hoặc tiếp tục gửi qua UC-15.

**Luồng khác/ngoại lệ:** Buyer được xóa bản nháp của mình. Nháp có thể chưa đủ thông tin để gửi; các trường đã nhập phải đúng kiểu dữ liệu. Yêu cầu đã gửi không được sửa/xóa như bản nháp. Nháp thuộc Buyer khác không được truy cập.

**Hậu điều kiện:** Có bản nháp được lưu, cập nhật hoặc xóa; không tạo báo giá hoặc phần việc.

<a id="uc-15"></a>
## UC-15 — Gửi yêu cầu đến các hộ

- **Tác nhân:** Buyer. **Quy tắc:** BR-11–BR-13, BR-26, BR-27.
- **Mục tiêu/kích hoạt:** Mời các hộ phù hợp chào giá; chọn gửi bản nháp.
- **Tiền điều kiện:** Sở hữu yêu cầu `Draft Request`, chưa hủy.
- **Dữ liệu:** Toàn bộ thông tin yêu cầu tại UC-14 và phiên bản đang xem.

**Luồng chính**

1. Buyer xem lại thông tin và xác nhận gửi.
2. Hệ thống kiểm tra đủ trường; số lượng nguyên dương; `hiện tại < hạn nhận báo giá < hạn giao`. Hạn mặc định 7 ngày chỉ dùng khi thỏa điều kiện.
3. Hệ thống kiểm tra tên, điện thoại người nhận và hình thức bàn giao. Nhận tại địa chỉ Buyer phải có địa chỉ; nhận tại xưởng nghĩa là nhận từng phần tại xưởng của hộ được chọn.
4. Hệ thống tìm toàn bộ hộ hoạt động có ít nhất một sản phẩm công bố thuộc phân loại yêu cầu và lưu danh sách nhận, không lặp hộ.
5. Nếu có hộ nhận, chuyển sang `Sent to Artisans`, ghi lịch sử và đưa yêu cầu vào danh sách nhận của các hộ.

**Ngoại lệ:** Thiếu/sai dữ liệu, thời hạn không còn hợp lệ hoặc không có hộ phù hợp: giữ nháp, nêu lý do. Gửi lặp yêu cầu đã gửi không tạo thêm người nhận hay lịch sử chuyển trạng thái. Gửi yêu cầu không bao gồm email/SMS.

**Hậu điều kiện:** Nội dung yêu cầu, số lượng và thông tin bàn giao được giữ cố định; các hộ trong danh sách có quyền xem yêu cầu để chào giá.

<a id="uc-16"></a>
## UC-16 — Gửi hoặc sửa báo giá

- **Tác nhân:** Artisan. **Quy tắc:** BR-14, BR-15, BR-26, BR-27.
- **Mục tiêu/kích hoạt:** Chào giá cho một yêu cầu đã nhận.
- **Tiền điều kiện:** Hộ trong danh sách nhận, đang hoạt động; yêu cầu còn mở nhận, chưa chấp nhận và chưa hủy.
- **Dữ liệu:** Đơn giá VND, số lượng tối đa nhận, thời hạn giao cam kết và phiên bản báo giá nếu sửa.

**Luồng chính**

1. Artisan mở yêu cầu, xem quy cách, số lượng, hạn giao và hình thức bàn giao.
2. Artisan nhập báo giá hoặc sửa báo giá hiện hành của hộ.
3. Hệ thống kiểm tra đơn giá lớn hơn 0, số lượng nguyên dương không vượt yêu cầu, `hiện tại < thời hạn giao cam kết ≤ hạn giao yêu cầu`.
4. Hệ thống hiển thị rõ đơn giá chỉ là tiền hàng, phí vận chuyển thỏa thuận ngoài hệ thống; thời hạn cam kết là lúc bàn giao đủ, không phải chỉ hoàn tất sản xuất.
5. Hệ thống lưu một báo giá hiện hành cho hộ; khi sửa tăng phiên bản. Báo giá hợp lệ đầu tiên chuyển yêu cầu từ `Sent to Artisans` sang `Artisans Bidding` và ghi lịch sử.

**Ngoại lệ:** Hết hạn/đóng sớm, hộ tạm ngừng, yêu cầu đã chấp nhận/hủy hoặc hộ không được mời: từ chối. Phiên bản cũ hoặc Buyer đóng nhận/chấp nhận đồng thời: kiểm tra lại trước khi lưu. Không có thao tác rút báo giá; không tạo báo giá thứ hai cho cùng hộ và yêu cầu.

**Hậu điều kiện:** Buyer và Admin thấy báo giá hiện hành; hộ khác không thấy giá hoặc khả năng nhận của hộ này.

<a id="uc-17"></a>
## UC-17 — Đóng nhận báo giá

- **Tác nhân:** Buyer đóng sớm; Hệ thống ghi nhận hết hạn. **Quy tắc:** BR-12, BR-27.
- **Mục tiêu/kích hoạt:** Ngừng nhận/sửa báo giá khi Buyer chọn đóng hoặc thời gian đạt hạn.
- **Tiền điều kiện:** Yêu cầu đã gửi, chưa chấp nhận/hủy. Buyer chỉ đóng yêu cầu của mình.
- **Dữ liệu:** Yêu cầu, thời điểm máy chủ, hạn nhận và phiên bản.

**Luồng chính**

1. Buyer chọn đóng sớm; hệ thống cho xem tác động không mở lại và yêu cầu xác nhận.
2. Hệ thống kiểm tra quyền, trạng thái và lưu `bidding_closed_at` bằng thời điểm đóng.
3. Hệ thống chặn mọi báo giá mới hoặc sửa báo giá, giữ các báo giá đã gửi để xét chọn.

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
2. Hệ thống trả trạng thái chính, trạng thái đóng nhận/hủy, nội dung yêu cầu và dữ liệu được phép xem.
3. Buyer sở hữu và Admin xem các báo giá, phương án và phần việc. Artisan chỉ xem báo giá/phần việc của hộ mình, không xem phương án tổng thể, đơn giá hoặc phân bổ hộ khác.
4. Với yêu cầu chưa chấp nhận, hệ thống xác định báo giá đủ điều kiện và tổng khả năng đáp ứng; phương án có hộ tạm ngừng hoặc thời hạn cam kết đã tới bị đánh dấu hết hiệu lực.
5. Giao diện hiển thị thao tác phù hợp: chọn trực tiếp, đóng nhận, nhờ chia, xem phương án, cập nhật phần việc, xác nhận nhận đủ hoặc hủy.

**Ngoại lệ:** Đủ số lượng tổng không đồng nghĩa có thể chấp nhận trực tiếp một hộ. Thiếu khả năng đáp ứng sau đóng nhận: hiển thị lý do, không cho chia thiếu; Buyer có thể hủy và tạo mới. Yêu cầu đã hủy vẫn xem dữ liệu/lịch sử theo quyền nhưng không tiếp tục xử lý.

**Hậu điều kiện:** Người dùng thấy dữ liệu đúng quyền và điều kiện hiện tại; không tự tạo phương án hoặc phần việc. Các kiểm tra vẫn phải lặp lại khi thao tác, không chỉ lúc hiển thị nút.

<a id="uc-19"></a>
## UC-19 — Chấp nhận trực tiếp một báo giá

- **Tác nhân:** Buyer. **Quy tắc:** BR-16, BR-19, BR-20, BR-26, BR-27.
- **Mục tiêu/kích hoạt:** Giao toàn bộ yêu cầu cho một hộ.
- **Tiền điều kiện:** Yêu cầu của Buyer ở `Artisans Bidding`, chưa hủy; có báo giá đủ điều kiện nhận toàn bộ số lượng. Không bắt buộc chờ hết hạn.
- **Dữ liệu:** Báo giá chọn, phiên bản yêu cầu/báo giá và xác nhận của Buyer.

**Luồng chính**

1. Buyer chọn báo giá; hệ thống hiển thị hộ, số lượng, đơn giá, tổng tiền hàng, thời hạn cam kết và thông tin bàn giao cố định.
2. Buyer xem lưu ý phí vận chuyển thỏa thuận ngoài hệ thống và xác nhận.
3. Hệ thống kiểm tra lại quyền, phiên bản, trạng thái hủy, hộ hoạt động, khả năng nhận đủ và thời hạn cam kết chưa tới.
4. Trong cùng thao tác, đóng nhận nếu còn mở, lưu một phần việc cố định và chuyển yêu cầu sang `Buyer Accepted`.
5. Hệ thống làm hết hiệu lực phương án chia đang chờ nếu có, loại yêu cầu khỏi hàng chờ và ghi lịch sử.

**Ngoại lệ:** Báo giá thay đổi, hộ bị tạm ngừng, hết thời hạn cam kết, yêu cầu đã hủy/chốt: không chấp nhận theo màn hình cũ; tải lại. Yêu cầu lặp sau thành công trả kết quả đã chốt, không thêm phần việc. Nếu một bước lưu thất bại, không để yêu cầu đã chấp nhận mà thiếu phần việc.

**Hậu điều kiện:** Một phần việc đủ số lượng; hộ, giá, số lượng và thời hạn cam kết đã cố định. Không tạo thực thể đơn hàng mới.

<a id="uc-20"></a>
## UC-20 — Nhờ Ban quản lý chia đơn

- **Tác nhân:** Buyer. **Quy tắc:** BR-17, BR-23, BR-27.
- **Mục tiêu/kích hoạt:** Yêu cầu Admin lập phương án nhiều hộ.
- **Tiền điều kiện:** Yêu cầu của Buyer ở `Artisans Bidding`, đã đóng nhận, chưa chấp nhận/hủy; không báo giá đủ điều kiện nào nhận trọn, nhưng tổng khả năng đủ.
- **Dữ liệu:** Yêu cầu và phiên bản.

**Luồng chính**

1. Buyer chọn “Nhờ Ban quản lý chia đơn”.
2. Hệ thống kiểm tra lại điều kiện và ghi `split_requested_at`.
3. Yêu cầu xuất hiện trong hàng chờ Admin; Buyer thấy đang chờ phương án.

**Ngoại lệ:** Còn mở nhận: yêu cầu đóng trước qua UC-17. Có hộ đủ toàn bộ: hướng đến chọn trực tiếp. Tổng không đủ: không tạo yêu cầu chia, cho Buyer hủy/tạo mới. Bấm lặp giữ một mục hàng chờ, không đổi mốc yêu cầu ban đầu.

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
3. Hệ thống kiểm tra mỗi hộ chỉ xuất hiện một lần, số lượng nguyên dương không vượt đã chào và tổng đúng bằng yêu cầu.
4. Hệ thống kiểm tra lại điều kiện/phiên bản và lưu phương án trạng thái đề xuất; phương án đề xuất cũ hết hiệu lực nếu được thay thế.
5. Buyer xem phương án trong chi tiết yêu cầu để quyết định.

**Ngoại lệ:** Phân bổ thiếu/thừa/trùng hộ hoặc hộ không còn đủ điều kiện: từ chối, giữ phương án đang có nếu còn hợp lệ. Nếu không còn đủ khả năng, hàng chờ hiển thị lý do, không tự hạ số lượng yêu cầu. Nếu thời hạn hoặc trạng thái hộ khiến phương án cũ hết hiệu lực, không khôi phục tự động khi hộ hoạt động lại.

**Hậu điều kiện:** Có tối đa một phương án đề xuất hiện hành; chưa tạo phần việc chính thức, Admin chưa chấp nhận thay Buyer.

<a id="uc-22"></a>
## UC-22 — Chấp nhận hoặc từ chối phương án

- **Tác nhân:** Buyer. **Quy tắc:** BR-18–BR-20, BR-26, BR-27.
- **Mục tiêu/kích hoạt:** Quyết định phương án chia đơn của yêu cầu mình.
- **Tiền điều kiện:** Yêu cầu ở `Artisans Bidding`, chưa hủy/chấp nhận; có phương án đề xuất hiện hành.
- **Dữ liệu:** Phương án, phiên bản yêu cầu/phương án và quyết định.

**Luồng chính**

1. Buyer xem từng hộ, số lượng, đơn giá, thời hạn giao cam kết, hình thức bàn giao và tổng tiền hàng.
2. Hệ thống hiển thị phí vận chuyển thỏa thuận ngoài hệ thống; Buyer xác nhận chấp nhận toàn bộ phương án.
3. Hệ thống kiểm tra lại phiên bản, điều kiện từng báo giá và tổng phân bổ bằng số lượng yêu cầu.
4. Trong một thao tác, hệ thống tạo các phần việc cố định, đánh dấu phương án đã chấp nhận, chuyển yêu cầu sang `Buyer Accepted`, loại khỏi hàng chờ và ghi lịch sử.

**Luồng khác/ngoại lệ**

- Buyer từ chối: phương án hết hiệu lực, yêu cầu giữ trạng thái chính và quay về hàng chờ cần lập lại; chưa tạo phần việc. Buyer có thể chọn hủy qua UC-27.
- Phương án cũ, hộ tạm ngừng hoặc thời hạn cam kết đã tới: không chấp nhận; hiển thị hết hiệu lực và lý do.
- Không chấp nhận riêng một phần phương án hoặc tự sửa số lượng. Nếu có báo giá đủ toàn bộ, Buyer có thể chuyển sang UC-19.
- Chấp nhận đồng thời/lặp: chỉ một kết quả được chốt; không tạo trùng phần việc hoặc ghi một phần phương án.

**Hậu điều kiện:** Chấp nhận tạo đầy đủ phần việc và cố định điều kiện; từ chối giữ yêu cầu chưa chốt, không tự hủy.
