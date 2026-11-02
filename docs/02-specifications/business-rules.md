# Quy tắc nghiệp vụ vCraft

Căn cứ: [đề bài](../01-project-brief/vCraft.md) và [phạm vi dự án](../01-project-brief/project-scope.md).

## 1. Nguyên tắc thiết kế

- Một yêu cầu báo giá (`QuoteRequest`) được theo dõi từ bản nháp đến giao hàng. Sau khi Buyer chấp nhận, chính yêu cầu đó đại diện cho đơn hàng; không tạo thêm thực thể đơn hàng riêng.
- Buyer chọn trực tiếp một báo giá nếu hộ đáp ứng đủ số lượng. Khi cần nhiều hộ cùng thực hiện, Buyer đóng nhận báo giá rồi nhờ Admin lập phương án chia đơn.
- Cả hai cách chấp nhận đều tạo phần việc (`Allocation`) cho từng hộ và dùng chung luồng sản xuất, giao hàng.
- Giữ sáu trạng thái chính của đề bài. Hạn nhận báo giá và thông tin hủy được quản lý riêng; yêu cầu đã hủy không được tiếp tục xử lý.
- Chốt giá, số lượng và thời hạn khi Buyer chấp nhận. Mọi thao tác phải kiểm tra vai trò, quyền sở hữu và trạng thái hiện tại.

Số lượng và quy cách được giữ nguyên sau khi gửi. Nếu không đủ khả năng đáp ứng, Buyer hủy yêu cầu và có thể tạo yêu cầu mới.

## 2. Tài khoản và quyền truy cập

- **BR-01:** Buyer tự đăng ký. Admin xác minh hộ ngoài hệ thống rồi trực tiếp tạo hồ sơ xưởng và cấp tài khoản Artisan; không có luồng Artisan tự nộp đơn. Người đăng ký không được tự chọn quyền Artisan hoặc Admin. Tài khoản Admin ban đầu được tạo khi thiết lập hệ thống.
- **BR-02:** Admin là đại diện Ban quản lý (Chủ tịch xã / Hội làng nghề), quản lý tài khoản hộ, phân loại, tin tức và điều phối đơn cần chia.
- **BR-03:** Artisan chỉ sửa dữ liệu xưởng và phần việc của hộ mình. Buyer chỉ sửa yêu cầu, chọn báo giá và xác nhận nhận hàng của mình. Admin không được chấp nhận giá thay Buyer.
- **BR-04:** Hồ sơ xưởng đủ điều kiện công khai, sản phẩm và tin tức đã công bố, bản đồ và trang truy xuất QR được xem không cần đăng nhập. Chi tiết yêu cầu chỉ dành cho Buyer tạo yêu cầu, các hộ nhận yêu cầu và Admin. Buyer sở hữu yêu cầu và Admin được xem toàn bộ báo giá, phương án chia đơn và phần việc của yêu cầu đó. Artisan chỉ xem báo giá và phần việc của hộ mình, không xem phương án tổng thể, đơn giá hoặc phân bổ của hộ khác. Trang QR công khai không chứa thông tin Buyer, thông tin liên hệ/bàn giao, đơn giá báo chào hoặc nội dung yêu cầu mua sỉ; quy tắc này áp dụng cả dữ liệu trả về từ máy chủ.
- **BR-05:** Hộ có hai trạng thái vận hành: hoạt động và tạm ngừng, do Admin quản lý; hộ mới được cấp tài khoản mặc định hoạt động. Việc xác minh/duyệt hộ là điều kiện cấp tài khoản, không phải trạng thái vận hành riêng; chưa có chức năng Artisan tự ngừng nhận việc. Tạm ngừng hộ chặn nhận yêu cầu, gửi/sửa báo giá, ẩn hồ sơ xưởng công khai và sản phẩm khỏi danh mục và bản đồ. Báo giá của hộ đang tạm ngừng không được chọn hoặc tính vào tổng khả năng đáp ứng. Hộ vẫn đăng nhập để hoàn thành phần việc đã chốt; QR đã công bố vẫn truy cập được. Khi Admin cho hoạt động lại, báo giá cũ được xét theo các điều kiện còn lại tại BR-15; phương án đã hết hiệu lực không tự khôi phục. Khóa đăng nhập vì lý do bảo mật là biện pháp riêng.

## 3. Xưởng, phân loại và truy xuất

- **BR-06:** Admin quản lý danh mục phân loại, khởi tạo sẵn theo làng nghề. Mỗi sản phẩm và yêu cầu báo giá chọn một phân loại. Không xóa phân loại đang được sử dụng.
- **BR-07:** Mỗi sản phẩm thuộc một lô của cùng hộ; nhật ký gắn với lô. Sản phẩm có ba trạng thái: nháp, công bố, ẩn. Công bố cần tên, phân loại, giá, ít nhất một ảnh và lô đã công bố. Chỉ sản phẩm công bố của hộ đang hoạt động được hiển thị trong danh mục và dùng để chọn hộ phù hợp. Các sản phẩm cùng lô dùng chung nhật ký và QR; không chuyển sản phẩm sang lô khác khi lô hiện tại đã công bố.
- **BR-08:** Mỗi mốc nhật ký có thời gian thực hiện, công đoạn và ít nhất một ảnh minh chứng; hiển thị theo thời gian thực hiện. Lô nháp cho thêm, sửa và xóa mốc. Lô đã công bố cho thêm và sửa mốc, không xóa mốc; mỗi lần sửa phải lưu nội dung trước khi sửa (gồm thời gian, công đoạn và tham chiếu ảnh), người sửa và thời điểm sửa. Ảnh được tham chiếu trong lịch sử phải được giữ để đối chiếu. Artisan sở hữu lô và Admin được xem lịch sử sửa; trang QR hiển thị nội dung hiện hành và thời điểm cập nhật gần nhất. Mốc sau khi sửa vẫn phải hợp lệ.
- **BR-09:** Lô có hai trạng thái: nháp và đã công bố. Artisan chỉ công bố lô của mình khi có ít nhất một mốc nhật ký hợp lệ; không chuyển lại nháp. Mỗi lô có một QR chứa mã công khai khó đoán với địa chỉ ổn định. Máy chủ chỉ cho truy xuất công khai lô đã công bố, kể cả khi người dùng biết địa chỉ lô nháp. Không xóa lô đã công bố hoặc dữ liệu đã dùng trong phần việc được chấp nhận. Trang QR ghi rõ nhật ký do hộ cung cấp; việc Admin cấp tài khoản không đồng nghĩa Admin xác nhận nội dung nhật ký.
- **BR-10:** Artisan tự bật/tắt trạng thái đón khách. Trạng thái tham quan không quyết định khả năng nhận yêu cầu mua sỉ. Xưởng phải có tọa độ hợp lệ để xuất hiện trên bản đồ.

## 4. Gửi yêu cầu và chào giá

- **BR-11:** Buyer được sửa hoặc xóa bản nháp. Khi gửi phải có phân loại, quy cách, số lượng nguyên dương, đơn vị tính, hạn nhận báo giá, hạn giao, tên người nhận, số điện thoại liên hệ và hình thức nhận hàng: tại xưởng hoặc tại địa chỉ Buyer. Nhận tại địa chỉ Buyer bắt buộc có địa chỉ giao; nhận tại xưởng nghĩa là Buyer nhận từng phần việc tại xưởng của hộ được chọn. Nội dung đã gửi, gồm thông tin bàn giao, được giữ cố định; không giảm số lượng, thay đổi thông tin bàn giao hoặc gia hạn trên yêu cầu cũ.
- **BR-12:** Hạn nhận báo giá là ngày-giờ, phải sau thời điểm gửi và trước hạn giao. Mặc định là 7 ngày sau khi gửi nếu hợp lệ; nếu không, Buyer phải chọn lại. Buyer được đóng nhận sớm khi yêu cầu đã gửi và chưa chấp nhận hoặc hủy. Hệ thống lưu thời điểm đóng thực tế (`bidding_closed_at`); khi `thời điểm hiện tại ≥ hạn nhận báo giá` thì đã đóng dù tác vụ nền chưa chạy. Khi đóng do hết hạn, thời điểm đóng thực tế là hạn nhận báo giá, không phải thời điểm tác vụ nền chạy. Đã đóng thì không thêm/sửa báo giá hoặc mở lại; các báo giá đã gửi vẫn được xét chọn, yêu cầu không tự hủy.
- **BR-13:** Hộ phù hợp là hộ đang hoạt động và có ít nhất một sản phẩm công bố thuộc phân loại yêu cầu. Hệ thống gửi đến toàn bộ hộ phù hợp, lưu danh sách nhận. Không có hộ phù hợp thì giữ bản nháp và báo Buyer.
- **BR-14:** Mỗi hộ nhận yêu cầu có một báo giá hiện hành, gồm đơn giá tiền hàng, số lượng tối đa có thể nhận và thời hạn giao cam kết. Thời hạn giao cam kết là ngày-giờ hộ cam kết bàn giao đủ phần việc cho Buyer theo hình thức nhận hàng của yêu cầu, không phải thời điểm hoàn tất sản xuất. Số lượng chào không vượt số lượng yêu cầu. Khi gửi hoặc sửa báo giá phải thỏa `thời điểm hiện tại < thời hạn giao cam kết ≤ hạn giao yêu cầu`. Đơn giá chỉ là tiền hàng; phí vận chuyển thỏa thuận ngoài hệ thống, phải hiển thị rõ điều này khi chào giá và khi Buyer chấp nhận.
- **BR-15:** Chỉ hộ thuộc danh sách nhận yêu cầu và đang hoạt động được gửi/sửa báo giá khi còn mở nhận và yêu cầu chưa được chấp nhận hoặc hủy. Mỗi lần sửa tăng `version` của báo giá. Chưa hỗ trợ rút báo giá; không dùng giá giả hoặc đổi số lượng để biểu thị rút. Báo giá đủ điều kiện xét chọn phải thuộc hộ đang hoạt động và thỏa `thời điểm hiện tại < thời hạn giao cam kết ≤ hạn giao yêu cầu`; áp dụng cho cả chọn trực tiếp, chia đơn và tính tổng khả năng đáp ứng.

## 5. Chấp nhận và chia đơn

- **BR-16:** Khi một báo giá đủ điều kiện đáp ứng toàn bộ số lượng, Buyer được chấp nhận trực tiếp trước hoặc sau khi đóng nhận. Hệ thống đóng nhận nếu còn mở và tạo một phần việc với đúng số lượng yêu cầu, theo đơn giá và thời hạn giao cam kết của báo giá đó.
- **BR-17:** Sau khi đóng nhận, nếu không hộ nào đủ số lượng nhưng tổng các báo giá đủ điều kiện đáp ứng yêu cầu, Buyer được chọn “Nhờ Ban quản lý chia đơn”. Ghi `split_requested_at` trên yêu cầu để đưa vào hàng chờ Admin; bấm lặp không tạo thêm mục. Admin chỉ lập phương án cho yêu cầu trong hàng chờ. Mỗi hộ xuất hiện một lần, nhận số lượng không vượt khả năng đã chào; tổng phân bổ phải bằng số lượng yêu cầu.
- **BR-18:** Mỗi yêu cầu chỉ có một phương án đang chờ Buyer. Phương án có `version` và ba trạng thái: đề xuất, đã chấp nhận, hết hiệu lực. Hộ được chọn bị tạm ngừng hoặc thời điểm hiện tại đạt hoặc vượt thời hạn giao cam kết làm phương án hết hiệu lực. Lập phương án mới hoặc Buyer từ chối cũng làm phương án cũ hết hiệu lực. Hàng chờ Admin hiển thị yêu cầu cần lập lại và lý do; chưa làm danh sách thông báo riêng, email hoặc SMS. Yêu cầu đã chấp nhận hoặc hủy được loại khỏi hàng chờ.
- **BR-19:** Buyer chỉ chấp nhận phương án đề xuất hiện hành. Nếu có báo giá đủ điều kiện đáp ứng toàn bộ số lượng, Buyer vẫn được chọn trực tiếp; phương án chia đang chờ hết hiệu lực. Cả hai đường đều kiểm tra lại điều kiện báo giá tại thời điểm chấp nhận. Tổng giá trị bằng tổng `số lượng phân bổ × đơn giá`.
- **BR-20:** Khi chấp nhận, lưu cố định hộ, số lượng, đơn giá và thời hạn giao cam kết trong từng phần việc; đóng chào giá. Không đổi hộ, giá, số lượng hoặc thời hạn giao cam kết sau đó. Chấp nhận và tạo phần việc phải thành công toàn bộ hoặc không thay đổi dữ liệu; thao tác lặp không tạo thêm phần việc.

## 6. Hết hạn và hủy

- **BR-21:** Trước khi chấp nhận, Buyer được hủy yêu cầu của mình. Sau khi chấp nhận, chỉ Admin được hủy khi yêu cầu chưa ở trạng thái `Delivered`, kể cả khi mọi hộ đã báo giao nhưng chưa có xác nhận nhận đủ. Yêu cầu ở trạng thái `Delivered` không được hủy. Lưu thời điểm, người hủy và lý do; Admin bắt buộc nhập lý do. Giữ trạng thái chính cuối cùng nhưng hiển thị rõ “Đã hủy”. Chặn mọi cập nhật báo giá, phân bổ, tiến độ và xác nhận nhận hàng sau hủy; phương án đang chờ hết hiệu lực.
- **BR-22:** Hủy áp dụng cho toàn bộ yêu cầu; không hủy riêng từng phần việc. Giữ nguyên báo giá, phân bổ, tiến độ đã ghi nhận và lịch sử để đối chiếu; không xóa hoặc đặt lại tiến độ các phần việc khi hủy. Hoàn tiền, bồi hoàn và xử lý hàng đã giao được thỏa thuận ngoài hệ thống. Yêu cầu đã hủy không được khôi phục; thao tác hủy lặp không tạo thêm bản ghi hủy.
- **BR-23:** Sau khi đóng nhận, nếu đủ khả năng đáp ứng, Buyer tiếp tục chọn báo giá hoặc nhờ Admin chia đơn. Nếu không đủ, Buyer hủy và có thể tạo yêu cầu mới; không sửa số lượng trên yêu cầu đã gửi. Trước khi chấp nhận, Buyer cũng được hủy khi không muốn chờ hoặc không đồng ý phương án. Hệ thống không tự chấp nhận, hủy hoặc gia hạn.

## 7. Sản xuất và giao hàng

`Draft Request → Sent to Artisans → Artisans Bidding → Buyer Accepted → In Production → Delivered`

| Chuyển trạng thái | Người thực hiện | Điều kiện |
| --- | --- | --- |
| Draft Request → Sent to Artisans | Buyer | Yêu cầu hợp lệ, có hộ nhận. |
| Sent to Artisans → Artisans Bidding | Hệ thống | Có báo giá hợp lệ đầu tiên. |
| Artisans Bidding → Buyer Accepted | Buyer | Chọn trực tiếp hoặc chấp nhận phương án chia hợp lệ. |
| Buyer Accepted → In Production | Hệ thống | Hộ đầu tiên xác nhận bắt đầu phần việc. |
| In Production → Delivered | Buyer; Admin trong ngoại lệ tại BR-25 | Yêu cầu chưa hủy, tất cả phần việc ở trạng thái “hộ báo đã giao” và có xác nhận Buyer nhận đủ theo BR-25. |

- **BR-24:** Mỗi phần việc chuyển tuần tự: chưa bắt đầu → đang sản xuất → hộ báo đã giao. Artisan chỉ cập nhật phần của mình và chỉ báo đã giao khi đã bàn giao đủ số lượng phần việc theo hình thức nhận hàng đã chốt; thao tác này chưa phải xác nhận Buyer nhận đủ toàn bộ yêu cầu. Khi bắt đầu hoặc đang sản xuất, hộ có thể gắn một lô của mình vào phần việc qua `batch_id` tùy chọn; liên kết này không quyết định chuyển trạng thái. Buyer chỉ mở được trang truy xuất khi lô đã công bố. Không đổi liên kết sau khi phần việc ở trạng thái “hộ báo đã giao”. Một hộ bắt đầu không đồng nghĩa tất cả hộ đã bắt đầu.
- **BR-25:** Buyer chỉ xác nhận nhận đủ khi mọi phần việc ở trạng thái “hộ báo đã giao” và yêu cầu chưa hủy; xác nhận thành công chuyển yêu cầu sang `Delivered`. Không tự xác nhận nhận hàng sau một khoảng thời gian. Admin chỉ xác nhận thay khi đáp ứng cùng điều kiện và có căn cứ Buyer nhận đủ; lưu lý do, căn cứ xác minh và người xác nhận. Buyer không phản hồi không đủ để xác nhận thay. Chưa hỗ trợ xác nhận nhận từng phần.
- **BR-26:** Không bỏ bước hoặc quay ngược trạng thái. Mỗi lần chuyển trạng thái yêu cầu lưu trạng thái trước/sau, người thực hiện và thời điểm trong `StatusLog`; ghi cả thao tác hủy và xác nhận thay. Chưa có lịch sử trạng thái riêng cho phần việc.
- **BR-27:** Yêu cầu, báo giá và phương án có `version`, tăng sau mỗi cập nhật. Kiểm tra quyền, trạng thái hủy, đóng nhận, thời hạn và phiên bản ngay khi xử lý. Các thao tác đồng thời như sửa báo giá, đóng nhận, chấp nhận, hủy hoặc tạm ngừng hộ phải được kiểm tra và ghi nhận nhất quán; dữ liệu cũ phải tải lại trước khi xác nhận. Việc chấp nhận không được sử dụng báo giá đã mất điều kiện.

## 8. Hồ sơ xưởng và tin tức

- **BR-28:** Admin tạo hồ sơ ban đầu; Artisan quản lý tên hiển thị, câu chuyện làm nghề, địa chỉ, hình ảnh, tọa độ và chứng nhận của hộ mình. Hồ sơ tự công khai khi hộ hoạt động và có đủ tên xưởng, địa chỉ, giới thiệu, ít nhất một ảnh xưởng; không có thao tác công bố hồ sơ riêng. Hồ sơ đã đủ điều kiện công khai không được sửa thành thiếu các trường bắt buộc. Hộ tạm ngừng bị ẩn hồ sơ công khai, khi hoạt động lại hồ sơ tự hiển thị nếu đủ điều kiện; QR đã công bố vẫn truy cập được. Chứng nhận không bắt buộc; nếu khai báo phải có tên và ảnh minh chứng. Không tự gắn nhãn chứng nhận khi thiếu chứng cứ; việc Admin cấp tài khoản không thay thế chứng nhận chất lượng.
- **BR-29:** Chỉ Admin tạo, sửa và công bố tin tức. Tin có trạng thái nháp/công bố, gồm tiêu đề, nội dung và một loại: nguyên vật liệu, lịch cúp điện, chính sách hỗ trợ hoặc thông báo chung. Chỉ tin công bố được xem công khai; Admin có thể đưa về nháp để gỡ khỏi trang tin.

## 9. Dữ liệu tối thiểu

- Tọa độ: vĩ độ từ −90 đến 90, kinh độ từ −180 đến 180.
- Ảnh: JPG, PNG hoặc WebP; tối đa 5 MB/ảnh và 10 ảnh cho mỗi sản phẩm hoặc mốc nhật ký. Backend tạo ảnh thu nhỏ và ảnh hiển thị.
- Giá dùng VND, lớn hơn 0; số lượng là số nguyên dương. Các phần phân bổ dùng cùng đơn vị tính với yêu cầu.
- Hạn nhận báo giá, hạn giao yêu cầu và thời hạn giao cam kết đều là ngày-giờ, nhập và hiển thị theo giờ Việt Nam (UTC+07:00); kiểm tra trên thời gian máy chủ, kể cả khi tác vụ nền chưa chạy.

## 10. Giới hạn và điểm còn mở

- Chưa chọn làng nghề, công đoạn nhật ký và danh mục phân loại cụ thể.
- Chưa xử lý sửa đơn đã chấp nhận, thay hộ, giao thiếu, tranh chấp, bồi hoàn hoặc tự động xử lý quá hạn giao. Đơn quá hạn vẫn giữ trạng thái thực tế.
- Khóa đăng nhập khẩn cấp khi hộ có việc đang chạy cần quy trình xử lý riêng; không tự chuyển phần việc sang hộ khác.
- Thuế, phí vận chuyển, thanh toán và hoàn tiền chưa được tính tự động. Tổng giá trị hiện tại chỉ gồm giá chào cho số lượng đã chốt.
