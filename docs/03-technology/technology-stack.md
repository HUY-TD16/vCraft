# Danh mục công nghệ — vCraft

Căn cứ: [phạm vi dự án](../01-project-brief/project-scope.md), [bảo mật & phân quyền](../02-specifications/security-and-access-control.md), [thiết kế dữ liệu](../02-specifications/data-design.md) và [kiến trúc tổng thể](../04-architecture/architecture-overview.md).

Tài liệu này xác định bộ công nghệ, thư viện, công cụ phát triển và **chốt các phiên bản mới nhất ổn định (Latest Stable)** cho toàn bộ nền tảng vCraft (Làng gốm Bát Tràng), nhằm tối ưu hóa hiệu năng, giảm thiểu độ trễ truy vấn và tận dụng các tính năng lập trình hiện đại nhất.

---

## 1. Bộ công nghệ cốt lõi chính thức (Phiên bản mới nhất)

Bộ công nghệ nền tảng của vCraft được nâng cấp và chốt cứng trên các phiên bản mới nhất: **React 19 + TypeScript 5.x + Vite 6** cho Frontend, **NestJS 10.x/11.x + TypeScript 5.x** trên nền **Node.js 22 LTS** cho Backend, và **PostgreSQL 17 + Prisma ORM 6.x** cho Cơ sở dữ liệu.

### 1.1. Lựa chọn nền tảng kiến trúc đã thống nhất

| Nhóm | Lựa chọn chính thức & Phiên bản | Vai trò & Lợi ích hiệu năng từ phiên bản mới nhất |
|---|---|---|
| **Frontend Framework** | **React 19 + TypeScript 5.x** | Xây dựng giao diện Single Page Application (SPA) phản hồi nhanh. Tận dụng `useActionState` và `useOptimistic` để xử lý cập nhật giao diện chào giá (Bidding) tức thì; bỏ boilerplate `forwardRef`; kiểm soát kiểu dữ liệu tĩnh nghiêm ngặt. |
| **Backend Framework** | **NestJS 10.x / 11.x + TypeScript 5.x** | Khung làm việc hướng module (Module, Dependency Injection, Guard, Interceptor) chuẩn hóa cho Modular Monolith. Tích hợp trình biên dịch SWC tăng tốc độ build/start backend lên gấp nhiều lần. |
| **Môi trường Runtime** | **Node.js 22 LTS (Active LTS)** | Động cơ V8 v12.x và trình biên dịch Maglev cải thiện đáng kể tốc độ thực thi JavaScript, tối ưu hóa I/O và quản lý bộ nhớ native khi xử lý upload và nén ảnh. |
| **Trình quản lý gói** | **pnpm (v9.x)** | Tốc độ cài đặt package cực nhanh, tiết kiệm dung lượng ổ cứng nhờ cơ chế Content-addressable storage, loại bỏ triệt để lỗi dependency bóng ma (*phantom dependencies*). |
| **Phong cách kiến trúc** | **Modular Monolith + Clean / Hexagonal "gọn"** | Chia hệ thống thành 7 module nghiệp vụ độc lập, giao tiếp qua Ports & Adapters (`public/`), đảm bảo tính đóng gói nhưng chỉ chạy trong một tiến trình (*single process*). |
| **Tổ chức dự án** | **Monorepo (1 Git repository)** | Tách riêng hai thư mục `frontend/` và `backend/`, chia tính năng theo module/feature dọc (Vertical Slice) cho nhóm 3 người. |
| **Cấu trúc phân tầng backend** | `common/`, `infrastructure/`, `modules/`, `workflows/`, `bootstrap/`, `tests/` | Phân định ranh giới rõ ràng giữa hạ tầng dùng chung, lõi nghiệp vụ từng module và quy trình điều phối giao dịch đa module trong cùng transaction. |

---

### 1.2. Lựa chọn kỹ thuật, dữ liệu và bảo mật đã đưa vào kiến trúc

| Nhóm | Lựa chọn & Phiên bản | Chi tiết áp dụng & Cải tiến phiên bản mới |
|---|---|---|
| **Cơ sở dữ liệu (Database)** | **PostgreSQL 17** *(hoặc 16.x)* | Phiên bản mới nhất với bộ tối ưu hóa truy vấn (*Query Planner*) thông minh hơn cho các lệnh `JOIN` phức tạp (báo giá, nhật ký sản xuất theo lô), cải tiến hiệu năng bộ nhớ và vacuuming, đảm bảo toàn vẹn giao dịch ACID tuyệt đối. |
| **Truy cập dữ liệu (Data Access)** | **Prisma ORM 6.x kết hợp SQL thuần** | **Prisma 6** tối ưu hóa vượt bậc về độ trễ truy vấn (*query latency*), thu nhỏ kích thước engine, cải thiện xử lý quan hệ phức tạp và hỗ trợ type-safe chặt chẽ.<br>- **Ghi (Commands):** Dùng Prisma Client trong Repository bảo đảm quy tắc domain.<br>- **Đọc (Queries):** Cho phép viết SQL thuần trực tiếp tại adapter persistence để tối ưu hiệu năng danh sách/báo cáo. |
| **Frontend Build Tool** | **Vite 6.x** | Thế hệ mới nhất của Vite, mang lại tốc độ khởi động dev server và Hot Module Replacement (HMR) tính bằng mili-giây, tối ưu hóa kích thước bundle xuất xưởng. |
| **Giao thức & Đặc tả API** | **REST API + OpenAPI / Swagger (v3)** | Chuẩn hóa API theo tài nguyên, sinh tài liệu Swagger UI tự động tại backend và hỗ trợ sinh kiểu (*Typegen*) cho client frontend. |
| **Cơ chế xác thực (Auth)** | **Session máy chủ + Cookie HttpOnly** | Cookie `__Host-vcraft-session; Secure; HttpOnly; SameSite=Lax`, kiểm soát thu hồi tức thì và hỗ trợ `auth_version` khi đổi mật khẩu/đăng xuất (SEC-05). Không dùng JWT lưu ở client. |
| **Mật mã & Băm mật khẩu** | **Argon2id (argon2 v0.41+)** | Chuẩn thuật toán băm mật khẩu hiện đại nhất theo khuyến nghị OWASP. Cấu hình khởi điểm `m=19 MiB, t=2, p=1`, salt ngẫu nhiên, cơ chế băm giả lập chống timing attack. |
| **Bộ nhớ đệm (Caching / Redis)** | **Chưa dùng trong MVP (Tùy chọn)** | Toàn bộ session, rate-limit và idempotency được xử lý trực tiếp trên PostgreSQL với transaction nguyên tử. Redis chỉ là adapter tùy chọn khi cần mở rộng quy mô. |

---

## 2. Thư viện và công cụ hệ sinh thái (Chốt phiên bản mới nhất)

Tất cả các thư viện trong hệ sinh thái đều được chỉ định phiên bản mới nhất, tương thích chặt chẽ với React 19 và Node.js 22 LTS:

### 2.1. Phía Frontend (`frontend/`)

| Thư viện / Công cụ | Phiên bản chốt | Mục đích & Lợi ích hiệu năng |
|---|---|---|
| **React Router** | **v7.x** *(hoặc v6.28+)* | Quản lý định tuyến trang, phân chia layouts theo 4 vai trò (Public, Buyer, Artisan, Admin), hỗ trợ data loading và type-safe routes hiện đại. |
| **TanStack Query** | **v5.x** | Quản lý bất đồng bộ, tự động caching, revalidation và optimistic updates. Tương thích hoàn hảo với cơ chế Transition và Suspense của React 19. |
| **React Hook Form + Zod** | **RHF v7.x + Zod v3.23+** | Quản lý form nhẹ, không re-render thừa; validate schema fail-fast phía client đồng bộ 100% với backend. |
| **Tailwind CSS + shadcn/ui** | **Tailwind v3.4+ / v4 + shadcn/ui** | Khai thác các tính năng CSS hiện đại (`:has()`, container queries, subgrid) giúp giao diện làng gốm Bát Tràng responsive mượt mà trên desktop và mobile. |
| **Leaflet + React Leaflet** | **Leaflet v1.9+ & React Leaflet v5+** | Hiển thị bản đồ xưởng gốm Bát Tràng, ghim tọa độ và popup thông tin đón khách tham quan/trải nghiệm (BR-10, UC-08). Mã nguồn mở, nhẹ, tải nhanh, không tốn phí bản quyền. |
| **Vitest + RTL** | **Vitest v2.x+ & React Testing Library v16+** | Kiểm thử đơn vị (Unit Test) cho hooks/components, thực thi cực nhanh nhờ dùng chung pipeline với Vite. |

---

### 2.2. Phía Backend (`backend/`)

| Thư viện / Công cụ | Phiên bản chốt | Mục đích & Lợi ích hiệu năng |
|---|---|---|
| **Sharp** | **v0.33+** | Xử lý ảnh đa luồng native C++ (libvips): tự động xoay ảnh theo EXIF, xóa metadata/GPS nhạy cảm, nén ảnh WebP/JPEG và sinh tự động 2 phiên bản (320px thumbnail và 1600px display) chuẩn SEC-10 với tốc độ cao. |
| **Zod / class-validator** | **Zod v3.23+ / class-validator v0.14+** | Validate dữ liệu DTO đầu vào tại Request Boundary (HTTP Pipes), từ chối ngay lập tức dữ liệu sai/âm/rác (Fail-Fast SEC-07). |
| **argon2** | **v0.41+** | Node.js native binding với cấu hình Argon2id chuyên dụng phục vụ `identity/adapters/crypto`. |
| **qrcode** | **v1.5+** | Sinh chuỗi và hình ảnh mã QR công khai ổn định cho từng lô sản phẩm gốm (BR-09, UC-11). |
| **Vitest (Backend)** | **v2.x+** | Thống nhất công cụ kiểm thử backend sang Vitest thay vì Jest cũ, giúp chạy test use case và repository nhanh hơn gấp 3–5 lần và dùng chung định dạng cấu hình. |

---

### 2.3. Kiểm thử & Vận hành triển khai

| Công cụ | Phiên bản chốt | Mục đích sử dụng |
|---|---|---|
| **Playwright** | **v1.49+** | Kiểm thử End-to-End (E2E) xuyên suốt frontend và backend cho các luồng nghiệp vụ cốt lõi: đăng ký $\rightarrow$ chào giá $\rightarrow$ chốt đơn $\rightarrow$ bàn giao $\rightarrow$ nhận đủ. |
| **Docker Compose** | **Compose v2.x+ (Docker Engine 27+)** | Đóng gói môi trường chạy gồm: Backend container, Frontend container, PostgreSQL container và volume lưu ảnh vật lý qua file `deploy/compose.yaml`. |
| **Reverse Proxy** | **Nginx v1.26+ (hoặc Caddy v2.8+)** | Đặt trước hệ thống để hợp nhất Frontend và Backend API về **cùng một origin**, xử lý bảo mật cookie `__Host-`, chặn request sai header và giới hạn kích thước body (SEC-14). |
| **Persistent Volume** | **Volume riêng biệt** | Lưu trữ tệp ảnh vật lý ngoài thư mục mã nguồn máy chủ, tắt quyền thực thi tệp script, truy cập thông qua cổng kiểm tra quyền máy chủ (SEC-10). |

---

## 3. Bảng tổng hợp phiên bản chính thức (Official Latest Stable Stack)

Khi tiến hành khởi tạo dự án và thiết lập môi trường (`package.json`), toàn bộ nhóm 3 thành viên thống nhất chốt cứng cấu hình phiên bản sau:

```yaml
Runtime & Package Management:
  Node.js: ">=22.11.0 LTS (Jod)"
  pnpm: ">=9.12.0"
  TypeScript: "^5.6.0"

Frontend (frontend/package.json):
  react: "^19.0.0"
  react-dom: "^19.0.0"
  vite: "^6.0.0"
  react-router: "^7.0.0"
  @tanstack/react-query: "^5.60.0"
  react-hook-form: "^7.53.0"
  zod: "^3.23.8"
  tailwindcss: "^3.4.15"   # Hoặc ^4.0 khi setup UI components
  leaflet: "^1.9.4"
  react-leaflet: "^5.0.0"
  vitest: "^2.1.0"
  @testing-library/react: "^16.0.0"

Backend (backend/package.json):
  @nestjs/core: "^10.4.0"   # Hoặc ^11.0
  @nestjs/common: "^10.4.0"
  @nestjs/swagger: "^8.0.0"
  @prisma/client: "^6.0.0"
  prisma: "^6.0.0"
  sharp: "^0.33.5"
  argon2: "^0.41.1"
  qrcode: "^1.5.4"
  zod: "^3.23.8"
  vitest: "^2.1.0"

Database & Infrastructure:
  PostgreSQL: "17-alpine"   # Chạy qua Docker Compose
  Reverse Proxy: "nginx:1.26-alpine" (hoặc "caddy:2.8-alpine")
  Playwright: "^1.49.0"
```

---

*Tài liệu này là căn cứ kỹ thuật chính thức để cấu hình mã nguồn và khởi tạo `environment-setup.md` cho toàn bộ dự án vCraft.*
