# Danh mục công nghệ — vCraft

Căn cứ: [phạm vi dự án](../01-project-brief/project-scope.md), [bảo mật & phân quyền](../02-specifications/security-and-access-control.md), [thiết kế dữ liệu](../02-specifications/data-design.md) và [kiến trúc tổng thể](../04-architecture/architecture-overview.md).

Tài liệu này xác định bộ công nghệ, thư viện, công cụ phát triển và trạng thái lựa chọn cho toàn bộ nền tảng vCraft (Làng gốm Bát Tràng).

---

## 1. Bộ công nghệ cốt lõi đã chốt

Bộ công nghệ nền tảng của vCraft là **React + TypeScript + Vite** cho Frontend, **NestJS + TypeScript** cho Backend, và **PostgreSQL + Prisma** cho Cơ sở dữ liệu.

### 1.1. Lựa chọn nền tảng kiến trúc đã thống nhất

| Nhóm | Lựa chọn đã chốt | Vai trò & Lý do lựa chọn |
|---|---|---|
| **Frontend Framework** | **React + TypeScript** | Xây dựng giao diện Single Page Application (SPA) phản hồi nhanh, kiểm soát kiểu dữ liệu tĩnh chặt chẽ. |
| **Backend Framework** | **NestJS + TypeScript** | Cung cấp khung làm việc hướng module (Module, Dependency Injection, Middleware, Guard, Interceptor) phù hợp tự nhiên với Modular Monolith. |
| **Phong cách kiến trúc** | **Modular Monolith + Clean / Hexagonal "gọn"** | Chia hệ thống thành 7 module nghiệp vụ độc lập, giao tiếp qua Ports & Adapters (`public/`), đảm bảo tính đóng gói nhưng chỉ chạy trong một tiến trình (*single process*). |
| **Tổ chức dự án** | **Monorepo (1 Git repository)** | Tách riêng hai thư mục `frontend/` và `backend/`, chia tính năng theo module/feature dọc (Vertical Slice) cho nhóm 3 người. |
| **Cấu trúc phân tầng backend** | `common/`, `infrastructure/`, `modules/`, `workflows/`, `bootstrap/`, `tests/` | Phân định ranh giới rõ ràng giữa hạ tầng dùng chung, lõi nghiệp vụ từng module và quy trình điều phối giao dịch đa module trong cùng transaction. |

---

### 1.2. Lựa chọn kỹ thuật, dữ liệu và bảo mật đã đưa vào kiến trúc

| Nhóm | Lựa chọn đã chốt | Chi tiết áp dụng |
|---|---|---|
| **Cơ sở dữ liệu (Database)** | **PostgreSQL** | Lưu trữ toàn bộ dữ liệu quan hệ, kiểm soát ràng buộc toàn vẹn ACID, giao dịch điều phối đơn hàng và lịch sử kiểm toán (*Audit Logs*). |
| **Truy cập dữ liệu (Data Access)** | **Prisma ORM kết hợp SQL thuần** | - **Ghi (Commands):** Dùng Prisma Client trong Repository của từng module để bảo đảm quy tắc domain.<br>- **Đọc (Queries):** Cho phép viết SQL JOIN trực tiếp tại adapter persistence để tối ưu danh sách/báo cáo (Lightweight CQRS). |
| **Frontend Build Tool** | **Vite** | Tốc độ biên dịch và Hot Module Replacement (HMR) tức thì, tối ưu cấu hình build production chuẩn ES Modules. |
| **Giao thức & Đặc tả API** | **REST API + OpenAPI / Swagger** | Chuẩn hóa API theo tài nguyên, sinh tài liệu Swagger UI tự động tại backend và hỗ trợ sinh kiểu (*Typegen*) cho client frontend. |
| **Cơ chế xác thực (Auth)** | **Session phía máy chủ + Cookie HttpOnly** | Cookie `__Host-vcraft-session; Secure; HttpOnly; SameSite=Lax`, kiểm soát thu hồi tức thì và hỗ trợ `auth_version` khi đổi mật khẩu/đăng xuất (SEC-05). Không dùng JWT lưu ở client. |
| **Mật mã & Băm mật khẩu** | **Argon2id** | Cấu hình khởi điểm `m=19 MiB, t=2, p=1`, salt ngẫu nhiên theo khuyến nghị OWASP. Ngăn chặn timing attack bằng băm giả lập. |
| **Bộ nhớ đệm (Caching / Redis)** | **Chưa dùng trong MVP (Tùy chọn)** | Toàn bộ session, rate-limit và idempotency được xử lý trực tiếp trên PostgreSQL với transaction nguyên tử. Redis chỉ là adapter tùy chọn qua interface `SessionStore`/`LoginAttemptStore` khi có nhu cầu đo tải thực tế. |

---

## 2. Thư viện và công cụ đề xuất trong hệ sinh thái

Các công cụ dưới đây nằm trong thiết kế chi tiết nhằm hoàn thiện các use case, đã được định hình trong cấu trúc mã nguồn và chờ hoàn tất chốt phiên bản cụ thể:

### 2.1. Phía Frontend (`frontend/`)

| Thư viện / Công cụ | Mục đích sử dụng | Trạng thái |
|---|---|---|
| **React Router (v6+)** | Quản lý định tuyến trang, phân chia layouts theo 4 vai trò (Public, Buyer, Artisan, Admin). | *Đã định hình trong cấu trúc `app/router/`* |
| **TanStack Query (React Query)** | Quản lý bất đồng bộ, tự động caching, revalidation và optimistic updates cho dữ liệu từ REST API. | *Đã định hình trong `app/providers/`* |
| **React Hook Form + Zod** | Quản lý trạng thái biểu mẫu, validate dữ liệu đầu vào fail-fast phía client khớp với schema backend. | *Đã định hình trong `features/*/schemas/`* |
| **Tailwind CSS + shadcn/ui** | Hệ thống design system tiện ích, dễ tùy biến giao diện gốm sứ Bát Tràng, đảm bảo responsive cho cả desktop và mobile. | *Đề xuất chuẩn hóa* |
| **Leaflet + React Leaflet** | Hiển thị bản đồ xưởng gốm Bát Tràng, ghim tọa độ và popup thông tin đón khách tham quan/trải nghiệm (BR-10, UC-08). | *Đề xuất chuẩn hóa (mã nguồn mở, không tốn phí bản quyền)* |
| **Vitest + React Testing Library** | Kiểm thử đơn vị (Unit Test) cho hooks/components và kiểm thử tích hợp giao diện biểu mẫu. | *Đã định hình trong `frontend/tests/`* |

---

### 2.2. Phía Backend (`backend/`)

| Thư viện / Công cụ | Mục đích sử dụng | Trạng thái |
|---|---|---|
| **Sharp** | Tối ưu hóa ảnh upload: xoay ảnh đúng chiều, loại bỏ metadata/GPS EXIF, kiểm tra kích thước ≤ 25 MP và sinh tự động 2 phiên bản (320px thumbnail và 1600px display) theo SEC-10. | *Đề xuất chuẩn hóa (hiệu năng native C++ vượt trội)* |
| **Zod / class-validator + class-transformer** | Validate dữ liệu DTO đầu vào tại Request Boundary (HTTP Pipes), từ chối ngay lập tức dữ liệu sai/âm/rác (Fail-Fast SEC-07). | *Đề xuất chuẩn hóa* |
| **argon2 (Node.js binding)** | Thư viện băm mật khẩu Argon2id chuyên dụng phục vụ `identity/adapters/crypto`. | *Đã chốt theo SEC-05* |
| **QRCode (hoặc node-qrcode)** | Sinh chuỗi và hình ảnh mã QR công khai ổn định cho từng lô sản phẩm gốm (BR-09, UC-11). | *Đề xuất chuẩn hóa* |

---

### 2.3. Kiểm thử & Vận hành triển khai

| Công cụ | Mục đích sử dụng | Trạng thái |
|---|---|---|
| **Playwright** | Kiểm thử End-to-End (E2E) xuyên suốt frontend và backend cho các luồng nghiệp vụ cốt lõi: đăng ký $\rightarrow$ chào giá $\rightarrow$ chốt đơn $\rightarrow$ bàn giao $\rightarrow$ nhận đủ. | *Đã định hình trong thư mục `tests/e2e/`* |
| **Docker Compose** | Đóng gói môi trường chạy gồm: Backend container, Frontend container, PostgreSQL container và volume lưu ảnh. | *Đã định hình trong `deploy/compose.yaml`* |
| **Reverse Proxy (Nginx hoặc Caddy)** | Đặt trước hệ thống để hợp nhất Frontend và Backend API về **cùng một origin**, xử lý bảo mật cookie `__Host-`, chặn request sai header và giới hạn kích thước body (SEC-14). | *Đã định hình trong `deploy/reverse-proxy/`* |
| **Persistent Volume riêng biệt** | Lưu trữ tệp ảnh vật lý ngoài thư mục mã nguồn máy chủ, tắt quyền thực thi tệp script, truy cập thông qua cổng kiểm tra quyền máy chủ (SEC-10). | *Đã chốt theo SEC-10* |

---

## 3. Các điểm mở kỹ thuật cần chốt khi thiết lập môi trường

Trước khi tiến hành cài đặt package ban đầu, nhóm cần thống nhất các thông số phiên bản cụ thể:

1. **Môi trường Runtime:**
   * Khuyến nghị: **Node.js LTS (v20.x hoặc v22.x)** + trình quản lý gói **pnpm** (hoặc npm).
2. **Phiên bản các framework chính:**
   * React: v18.x hoặc v19.x.
   * NestJS: v10.x.
   * PostgreSQL: v16.x.
   * Prisma: v5.x hoặc v6.x.
3. **Lựa chọn Reverse Proxy cụ thể:**
   * **Nginx:** Phổ biến, tài liệu nhiều, dễ tùy biến cấu hình reverse proxy và giới hạn IP.
   * **Caddy:** Tự động cấu hình HTTPS/TLS cục bộ, cú pháp file cấu hình gọn.
4. **Công cụ kiểm thử Backend:**
   * **Jest** (mặc định đi kèm NestJS CLI) hoặc **Vitest** (đồng bộ với frontend, tốc độ chạy nhanh hơn).

---

*Tài liệu này sẽ tiếp tục được cập nhật phiên bản cụ thể vào file `environment-setup.md` khi nhóm tiến hành khởi tạo mã nguồn và cấu hình `package.json`.*

