# Chạy vCraft bằng Docker

1. Khởi động Docker Desktop ở chế độ Linux containers hoặc Docker Engine trên Linux. Phiên bản mục tiêu là Engine 29.9.3 và Compose 5.7.0. Chạy các lệnh bên dưới từ thư mục gốc của repo.
2. Sao chép `.env.example` thành `.env`. Điền hai chuỗi ngẫu nhiên riêng biệt vào `POSTGRES_PASSWORD` và `SESSION_SECRET`, mỗi chuỗi ít nhất 32 ký tự chữ và số. Compose dùng mật khẩu này trong URL kết nối nội bộ.
3. Build và khởi động bốn dịch vụ:

   ```sh
   docker compose --env-file .env -f deploy/compose.yaml up -d --build --wait
   docker compose --env-file .env -f deploy/compose.yaml ps
   ```

4. Mở [trang chủ](http://localhost). Backend chỉ lắng nghe sau khi Prisma chạy thành công `SELECT 1` trên PostgreSQL. Có thể kiểm tra đường proxy bằng `curl -i http://localhost/api/` (PowerShell dùng `curl.exe`): với backend hiện tại, Nest trả JSON 404 vì chưa khai báo route gốc. Nếu nhận 502 hoặc dịch vụ chưa sẵn sàng, xem log:

   ```sh
   docker compose --env-file .env -f deploy/compose.yaml logs --tail=50 backend reverse-proxy postgres
   ```

Dừng stack và giữ dữ liệu bằng `docker compose --env-file .env -f deploy/compose.yaml down`.

Container backend chạy `prisma migrate deploy` trước khi mở NestJS. Compose dùng `.env` ở gốc để tạo `DATABASE_URL` trỏ đến `postgres:5432`. Khi NestJS khởi động, `DatabaseModule` mở kết nối qua Prisma và chạy `SELECT 1`.

Trước khi mở cổng, backend kiểm tra URL PostgreSQL, khóa phiên (ít nhất 32 ký tự), cổng (1–65535), môi trường, origin HTTP(S) và quyền đọc/ghi thư mục ảnh. Nếu cấu hình sai, log nêu tên biến cần sửa. Trong Compose, thư mục ảnh là volume `/var/lib/vcraft/uploads`.

API dùng prefix `/api/v1`. Để kiểm tra qua Nginx, gọi `curl -i http://localhost/api/v1/`: khi chưa có route gốc, phản hồi dự kiến là HTTP 404, `application/problem+json`, mã `RESOURCE_NOT_FOUND` và `tracking_id`. Khi thêm DTO, dùng `@Body(new ZodValidationPipe(schema))` với `z.strictObject(...)` cho từng object và khai báo quy tắc trim theo trường. Các lỗi validation trả đường dẫn JSON Pointer trong `errors`.

**Chạy backend trên máy host:** khởi động riêng PostgreSQL bằng `docker compose up -d postgres` từ gốc sau khi chuẩn bị `.env`. Sao chép `backend/.env.example` thành `backend/.env` và chỉnh `DATABASE_URL` khớp với user, mật khẩu, tên database và cổng đã công bố (mặc định `localhost:5433`). Từ gốc repo chạy:

```sh
pnpm install --frozen-lockfile
pnpm --filter vcraft-backend exec prisma migrate deploy
pnpm dev:backend
```

**Nếu đang dùng PostgreSQL 17:** sao lưu database cũ bằng `pg_dump` và thử khôi phục vào PostgreSQL 18 trước khi chuyển dữ liệu thật. Cấu hình mới tạo volume `vcraft_pgdata18` riêng. Volume cũ `vcraft_pgdata` vẫn chứa dữ liệu bản 17.
