# Phạm vi dự án vCraft

Nguồn: [Đề bài vCraft](vCraft.md).

## 1. Mục tiêu và giới hạn

vCraft là nền tảng web phục vụ Ban quản lý làng gốm Bát Tràng, tập trung vào triển lãm số, truy xuất nguồn gốc và điều phối đơn hàng mua buôn. Mỗi hộ sản xuất gốm/nghệ nhân có không gian giới thiệu xưởng, kể câu chuyện làm nghề và trưng bày sản phẩm gốm.

Phạm vi triển khai là một làng nghề duy nhất: Bát Tràng, với ba vai trò: hộ sản xuất gốm/nghệ nhân (Artisan), khách hàng/khách tham quan (Buyer/Tourist) và quản trị viên (Admin — đại diện Ban quản lý/Hội làng nghề, tương ứng vai trò Chủ tịch xã / Hội làng nghề trong đề bài). Đây là vai trò nghiệp vụ, không chỉ định một cá nhân hoặc cơ quan thực tế vận hành dự án.

### Bối cảnh nghiệp vụ Bát Tràng

- **Danh mục khởi tạo:** ấm, chén và cốc; bát, đĩa và khay; bình, lọ và đồ trang trí; đồ thờ bằng gốm; chậu gốm. Đây là cách phân nhóm của ứng dụng; mỗi sản phẩm và yêu cầu chọn một nhóm chính, Admin quản lý theo BR-06.
- **Nhật ký mẫu:** chuẩn bị đất → tạo hình → phơi/sấy và sửa mộc → trang trí, tráng men → nung → kiểm tra thành phẩm. Đây là các mốc minh họa cho dữ liệu dự án, không phải quy trình bắt buộc cho mọi sản phẩm; Artisan ghi đúng công đoạn thực tế của lô, có thể thêm hoặc lặp mốc.
- **Quy cách mua sỉ:** mô tả loại sản phẩm, kích thước/dung tích, màu men, họa tiết/logo và yêu cầu đóng gói khi có. Các chi tiết nằm trong nội dung quy cách, chưa tạo cấu hình biến thể hay quy trình duyệt mẫu riêng.
- **Đơn vị tính:** chiếc cho sản phẩm đơn; bộ cho bộ ấm chén hoặc bộ bát đĩa, kèm mô tả thành phần của một bộ. Một yêu cầu dùng một đơn vị thống nhất, không tự quy đổi chiếc/bộ.
- **Ví dụ:** đặt 5.000 cốc gốm dung tích 300 ml, men trắng, in logo theo mô tả; các hộ chào giá và cam kết bàn giao theo ngày-giờ được chọn. Có thể chia số lượng cho nhiều hộ sau khi đóng nhận báo giá.
- **Tham quan:** bản đồ hiển thị các xưởng trong phạm vi Bát Tràng, thông tin đón khách xem làm gốm hoặc trải nghiệm tại xưởng. Chưa đặt lịch hay bán vé trực tuyến.

Tên hộ, lô, số lượng và giá trong dữ liệu demo là dữ liệu minh họa; thông tin, hình ảnh và tọa độ xưởng thực tế phải được xác minh trước khi sử dụng.

## 2. Chức năng trong phạm vi

| Nhóm chức năng | Nội dung |
| --- | --- |
| Xác thực và phân quyền | Buyer tự đăng ký tài khoản; Artisan do Admin kiểm duyệt và cấp tài khoản. Người dùng đăng nhập để thực hiện nghiệp vụ theo vai trò; hệ thống kiểm soát quyền truy cập và thao tác trên dữ liệu. |
| Hồ sơ xưởng | Nghệ nhân quản lý lịch sử gia đình, hình ảnh xưởng và chứng nhận chất lượng. Khách xem thông tin để tìm hiểu người làm nghề. |
| Trưng bày sản phẩm | Nghệ nhân đăng sản phẩm và giá bán; mỗi sản phẩm thuộc một lô, nhật ký sản xuất gắn với lô đó. Khách xem danh mục theo hộ gia đình hoặc phân loại. |
| Nhật ký và truy xuất | Lưu nhật ký theo lô với các mốc thời gian và hình ảnh minh chứng. Tự động sinh một mã QR cho mỗi lô; các sản phẩm cùng lô dùng chung mã. Quét QR mở trang công khai kể câu chuyện và toàn bộ quy trình sản xuất của lô, không yêu cầu đăng nhập. |
| Yêu cầu báo giá | Khách tạo yêu cầu mua sỉ; hệ thống gửi đến các hộ phù hợp. Các hộ phản hồi với mức giá và thời gian hoàn thành; khách chấp nhận báo giá. |
| Điều phối đơn hàng | Buyer chọn trực tiếp báo giá đủ số lượng hoặc đóng nhận báo giá rồi nhờ Ban quản lý chia đơn. Admin xử lý hàng chờ chia đơn, Buyer chấp nhận phương án. Theo dõi phần việc của từng hộ đến giao hàng; có thể liên kết phần việc với lô để truy xuất. |
| Bản đồ làng nghề | Hiển thị xưởng bằng ghim theo tọa độ và thông tin vắn tắt khi nhấn ghim. Artisan tự bật/tắt trạng thái mở cửa đón khách tham quan/trải nghiệm của xưởng; khách xem trạng thái này trên bản đồ. |
| Quản lý hộ gia đình | Admin xác minh hộ ngoài hệ thống rồi trực tiếp tạo hồ sơ và cấp tài khoản. Hộ tạm ngừng không nhận việc mới nhưng vẫn hoàn thành phần việc đã chốt. |
| Tin tức cộng đồng | Admin quản lý tin về nguyên vật liệu làm gốm như đất, men, lịch cúp điện và chính sách hỗ trợ các hộ tại Bát Tràng. |

## 3. Luồng báo giá bắt buộc

`Draft Request → Sent to Artisans → Artisans Bidding → Buyer Accepted → In Production → Delivered`

Tương ứng: nháp yêu cầu → gửi đến các hộ → các hộ chào giá → khách chấp nhận → đang sản xuất → đã giao hàng.

Hệ thống kiểm soát chuyển trạng thái và cập nhật đồng thời để tránh xung đột. Buyer có thể đóng nhận báo giá sớm; số lượng giữ nguyên sau khi gửi. Nếu không đủ khả năng đáp ứng, Buyer hủy và tạo yêu cầu mới. Quyền chuyển trạng thái, điều kiện công bố và xử lý ngoại lệ được quy định trong [quy tắc nghiệp vụ](../02-specifications/business-rules.md).

## 4. Yêu cầu kỹ thuật và giao diện

- Tích hợp API hoặc thư viện bản đồ để hiển thị tọa độ và thông tin xưởng.
- Hỗ trợ tải lên nhiều ảnh; backend tối ưu kích thước ảnh để phục vụ danh sách hàng trăm sản phẩm.
- Giao diện chú trọng hình ảnh sản phẩm, xưởng và quá trình làm nghề.
- Nhóm tự lựa chọn công nghệ frontend và backend; chưa chốt công nghệ trong bước xác định phạm vi.

## 5. Ngoài phạm vi đề bài

Các chức năng sau không được đề bài yêu cầu và chưa đưa vào phạm vi thực hiện:

- Giỏ hàng bán lẻ, thanh toán trực tuyến và tích hợp đơn vị vận chuyển.
- Đặt lịch, bán vé tham quan hoặc trải nghiệm tại xưởng.
- Quản lý kho, kế toán và mua nguyên vật liệu.
- Vận hành nhiều làng nghề trên cùng nền tảng hoặc ứng dụng di động riêng.

Trạng thái “đã giao hàng” vẫn thuộc luồng đơn hàng; thông tin xưởng mở cửa vẫn thuộc bản đồ.

## 6. Kết quả bàn giao và dữ liệu triển khai

Sản phẩm là ứng dụng web có thể demo trực tiếp các chức năng và luồng nghiệp vụ trên tại buổi thi vấn đáp. Nhóm gồm 3 sinh viên; đề bài không yêu cầu slide hoặc tài liệu thuyết trình.

Làng nghề đã chọn là Bát Tràng; danh mục khởi tạo và mốc nhật ký mẫu được xác định ở mục 1. Bước tiếp theo cần chuẩn bị hồ sơ, tọa độ xưởng, ảnh gốm và lô minh họa. Hàng chờ Admin phục vụ điều phối; chưa triển khai danh sách thông báo riêng, email hoặc SMS.
