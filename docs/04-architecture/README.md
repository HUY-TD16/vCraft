# Kiến trúc

Lưu thiết kế kỹ thuật cho vCraft tại làng gốm Bát Tràng. Các thành phần cần thể hiện quan hệ hộ/xưởng, sản phẩm gốm, lô và nhật ký, cùng yêu cầu báo giá và phần việc của từng hộ. Phạm vi phục vụ một làng nghề.

## Tài liệu hiện có

- [architecture-overview.md](architecture-overview.md): kiến trúc tổng thể, cấu trúc React/NestJS, ranh giới module, transaction, xác thực và kiểm thử.
- [api-design.md](api-design.md): đặc tả hợp đồng API và DTO, endpoint, cấu trúc request/response, validation, mã lỗi RFC 9457, phân trang và ma trận phân quyền.

- [api-dtos.md](api-dtos.md): trường phản hồi, kiểu dữ liệu, nullability và biến thể theo quyền đọc.

## Tài liệu dự kiến

- `source-code-structure.md`: cách tổ chức mã nguồn và quy ước phụ thuộc giữa các module.
- `database.md`: mô hình dữ liệu, sơ đồ ERD và các ràng buộc.
- `deployment.md`: môi trường vận hành, sơ đồ triển khai và cấu hình hạ tầng.

Có thể viết sơ đồ bằng Mermaid trong Markdown; lưu hình và tệp sơ đồ riêng trong `assets/` khi cần.

Các tài liệu dự kiến sẽ bổ sung chi tiết cho thiết kế tổng thể hiện có.
