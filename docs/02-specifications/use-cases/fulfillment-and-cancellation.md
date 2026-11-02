# Thực hiện, giao hàng và hủy yêu cầu

[Mục lục và quy ước chung](../use-cases.md) · [Quy tắc nghiệp vụ](../business-rules.md)

<a id="uc-23"></a>
## UC-23 — Bắt đầu phần việc và gắn lô

- **Tác nhân:** Artisan. **Quy tắc:** BR-05, BR-20, BR-24, BR-26, BR-27.
- **Mục tiêu/kích hoạt:** Bắt đầu phần việc đã nhận và tùy chọn liên kết lô truy xuất.
- **Tiền điều kiện:** Phần việc đã chốt thuộc hộ; yêu cầu ở `Buyer Accepted` hoặc `In Production`, chưa hủy. Hộ tạm ngừng vẫn được thực hiện.
- **Dữ liệu:** Phần việc, lô tùy chọn qua `batch_id`, phiên bản yêu cầu.

**Luồng chính**

1. Artisan mở phần việc, xem số lượng, giá, thời hạn cam kết và hình thức bàn giao đã chốt.
2. Artisan chọn bắt đầu, có thể chọn một lô của hộ mình.
3. Hệ thống kiểm tra quyền, trạng thái và lô nếu có; chuyển phần việc từ chưa bắt đầu sang đang sản xuất.
4. Nếu đây là phần việc đầu tiên bắt đầu, hệ thống chuyển yêu cầu từ `Buyer Accepted` sang `In Production` và ghi lịch sử.

**Luồng khác/ngoại lệ**

- Khi đang sản xuất, Artisan có thể gắn hoặc đổi sang một lô khác của hộ; không đổi giá, số lượng hay thời hạn đã chốt.
- Không chọn lô vẫn được bắt đầu. Chọn lô nháp vẫn tạo được liên kết nhưng Buyer chưa truy xuất công khai; chỉ mở QR sau UC-11.
- Lô của hộ khác, phần việc đã báo giao hoặc yêu cầu đã hủy: từ chối cập nhật. Không tự tạo lô mới khi bắt đầu.
- Bắt đầu lặp không làm phát sinh phần việc hoặc ghi thêm lần chuyển `In Production`; hộ khác bắt đầu sau đó không chuyển lại trạng thái yêu cầu.

**Hậu điều kiện:** Phần việc đang sản xuất, có tối đa một lô liên kết. Các phần việc khác giữ nguyên tiến độ.

<a id="uc-24"></a>
## UC-24 — Báo đã giao phần việc

- **Tác nhân:** Artisan. **Quy tắc:** BR-24, BR-27.
- **Mục tiêu/kích hoạt:** Ghi nhận hộ đã bàn giao đủ phần việc.
- **Tiền điều kiện:** Phần việc của hộ đang sản xuất; yêu cầu ở `In Production`, chưa hủy. Hộ đã bàn giao đủ số lượng theo hình thức nhận hàng cố định.
- **Dữ liệu:** Phần việc, xác nhận bàn giao và phiên bản yêu cầu.

**Luồng chính**

1. Artisan kiểm tra số lượng và thông tin bàn giao, chọn báo đã giao.
2. Hệ thống kiểm tra quyền và trạng thái hiện tại.
3. Hệ thống chuyển phần việc sang “hộ báo đã giao”, khóa thay đổi lô liên kết.
4. Buyer và Admin thấy tiến độ cập nhật; nếu mọi phần việc đã báo giao, Buyer được thực hiện UC-25.

**Ngoại lệ:** Chưa bắt đầu: không cho bỏ bước. Chỉ giao một phần: không ghi nhận là đã giao đủ; chưa có luồng giao thiếu. Hủy đồng thời: không lưu cập nhật sau khi hủy đã có hiệu lực. Thao tác lặp giữ kết quả đã có. Giao quá thời hạn vẫn ghi tiến độ thực tế, không tự hủy.

**Hậu điều kiện:** Yêu cầu vẫn `In Production`, kể cả mọi hộ đã báo giao; chưa đồng nghĩa Buyer xác nhận nhận đủ. Không bắt buộc lô đã công bố để báo giao.

<a id="uc-25"></a>
## UC-25 — Xác nhận nhận đủ

- **Tác nhân:** Buyer. **Quy tắc:** BR-25–BR-27.
- **Mục tiêu/kích hoạt:** Xác nhận đã nhận đủ toàn bộ yêu cầu.
- **Tiền điều kiện:** Buyer sở hữu yêu cầu ở `In Production`, chưa hủy; mọi phần việc ở trạng thái “hộ báo đã giao”.
- **Dữ liệu:** Yêu cầu, phiên bản và xác nhận của Buyer.

**Luồng chính**

1. Buyer xem các phần việc và chọn xác nhận đã nhận đủ.
2. Hệ thống kiểm tra lại quyền, phiên bản, trạng thái hủy và toàn bộ phần việc.
3. Hệ thống chuyển yêu cầu sang `Delivered`, ghi người xác nhận, thời điểm và lịch sử trạng thái.

**Ngoại lệ:** Còn hộ chưa báo giao: từ chối, chỉ rõ phần việc còn thiếu. Buyer thực tế chưa nhận đủ: không xác nhận; chưa có luồng nhận từng phần/tranh chấp. Yêu cầu hủy hoặc phiên bản thay đổi: tải lại trước thao tác. Xác nhận lặp không tạo lịch sử hoàn tất lần hai.

**Hậu điều kiện:** Yêu cầu `Delivered`, không được hủy hoặc quay lại sản xuất; không phát sinh thanh toán tự động.

<a id="uc-26"></a>
## UC-26 — Xác nhận nhận đủ thay Buyer

- **Tác nhân:** Admin. **Quy tắc:** BR-25–BR-27.
- **Mục tiêu/kích hoạt:** Hoàn tất yêu cầu trong ngoại lệ đã xác minh nhận đủ.
- **Tiền điều kiện:** Yêu cầu `In Production`, chưa hủy; mọi phần việc đã báo giao; Admin có căn cứ Buyer nhận đủ.
- **Dữ liệu:** Yêu cầu, lý do xác nhận thay, căn cứ xác minh và phiên bản.

**Luồng chính**

1. Admin xem toàn bộ tiến độ và chọn xác nhận thay.
2. Admin ghi lý do, căn cứ xác minh và xác nhận thao tác.
3. Hệ thống kiểm tra dữ liệu bắt buộc cùng điều kiện giao hàng và trạng thái hủy.
4. Hệ thống chuyển sang `Delivered`; ghi rõ Admin thực hiện thay Buyer, thời điểm, lý do và căn cứ trong lịch sử.

**Ngoại lệ:** Chỉ có lý do Buyer không phản hồi, không có căn cứ nhận đủ: không xác nhận thay. Thiếu lý do/căn cứ hoặc còn phần việc chưa báo giao: từ chối. Buyer đã xác nhận đồng thời: giữ kết quả hoàn tất đầu tiên, không ghi đè người xác nhận. Yêu cầu đã hủy: không hoàn tất.

**Hậu điều kiện:** Yêu cầu hoàn tất với dấu vết xác nhận thay; không có lịch tự xác nhận sau 7 ngày hoặc thời hạn khác.

<a id="uc-27"></a>
## UC-27 — Hủy yêu cầu

- **Tác nhân:** Buyer trước chấp nhận; Admin sau chấp nhận. **Quy tắc:** BR-21–BR-23, BR-26, BR-27.
- **Mục tiêu/kích hoạt:** Dừng toàn bộ yêu cầu khi người có quyền chọn hủy.
- **Tiền điều kiện:** Chưa hủy, chưa `Delivered`. Buyer sở hữu yêu cầu trước `Buyer Accepted`; Admin thực hiện khi đã `Buyer Accepted` hoặc `In Production`.
- **Dữ liệu:** Yêu cầu, phiên bản, lý do; Admin bắt buộc nhập lý do.

**Luồng chính**

1. Người dùng mở yêu cầu, chọn hủy và xem tác động không thể khôi phục, áp dụng toàn bộ phần việc.
2. Người dùng nhập lý do theo quyền và xác nhận.
3. Hệ thống kiểm tra lại quyền theo trạng thái hiện tại, phiên bản và việc chưa hoàn tất.
4. Hệ thống ghi thời điểm, người hủy và lý do; giữ nguyên trạng thái chính cuối cùng, đánh dấu rõ đã hủy và ghi lịch sử.
5. Phương án đề xuất hết hiệu lực, yêu cầu rời hàng chờ. Chặn báo giá, phân bổ, tiến độ và xác nhận nhận hàng tiếp theo.

**Luồng khác/ngoại lệ**

- Buyer muốn hủy sau khi chấp nhận: không được trực tiếp thao tác; việc trao đổi với Admin diễn ra ngoài hệ thống, chưa có luồng gửi đơn xin hủy.
- Admin có thể hủy khi mọi hộ đã báo giao nhưng Buyer/Admin chưa xác nhận nhận đủ. `Delivered` thì không được hủy.
- Bản nháp có thể xóa qua UC-14; nếu hủy thì giữ bản nháp cùng dấu hủy, không cho gửi lại.
- Hủy đồng thời với chấp nhận/nhận đủ phải kiểm tra nhất quán; thao tác sau không được dùng trạng thái cũ. Hủy lặp trả kết quả cũ, không thêm bản ghi hủy.

**Hậu điều kiện:** Giữ toàn bộ báo giá, phân bổ, tiến độ và lịch sử; không đặt lại phần việc, không hủy riêng từng hộ, không khôi phục yêu cầu. Buyer có thể tạo yêu cầu mới. Hoàn tiền, bồi hoàn và xử lý hàng đã giao nằm ngoài hệ thống.
