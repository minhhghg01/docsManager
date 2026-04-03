# Docs Manager — Hệ thống quản lý tài liệu nội bộ

Ứng dụng web đăng, chia sẻ và xem tài liệu nội bộ giữa các khoa/phòng.  
File Word, Excel, PowerPoint… được chuyển sang PDF bằng **LibreOffice** để xem trực tiếp trên trình duyệt.

## Yêu cầu hệ thống

| Thành phần | Phiên bản tối thiểu |
|---|---|
| **Node.js** | 18+ |
| **npm** | đi kèm Node.js |
| **LibreOffice** *(tùy chọn — cần nếu muốn xem Word/Excel online)* | 26.2.2 (hoặc mới hơn) |

> Dùng `sql.js` (SQLite thuần WASM) và `bcryptjs` (thuần JS) — **không cần Python hay C++ build tools**. Chạy được ngay trên mọi hệ điều hành.

## Cài đặt

### 1. Clone repository

```bash
git clone https://github.com/<username>/docsManager.git
cd docsManager
```

### 2. Cài dependencies

```bash
npm install
```

### 3. Tạo file `.env`

```bash
# Windows (cmd)
copy .env.example .env

# Linux / macOS
cp .env.example .env
```

Mở file `.env` và chỉnh:

```env
PORT=3000
JWT_SECRET=chuoi-bi-mat-dai-va-ngau-nhien-cua-ban
LIBREOFFICE_PATH=C:\Program Files\LibreOffice\program\soffice.exe
```

- **`JWT_SECRET`**: chuỗi bí mật dùng ký JWT — **bắt buộc đổi** khi deploy.
- **`LIBREOFFICE_PATH`**: đường dẫn tới `soffice.exe` (Windows) hoặc `soffice` (Linux).  
  Để trống nếu chưa cài LibreOffice — ứng dụng vẫn chạy, chỉ không xem Word/Excel trực tiếp được.

### 4. Khởi tạo dữ liệu mẫu (seed)

```bash
npm run seed
```

Lệnh này tạo:
- 1 khoa mẫu: **Khoa CNTT**
- 1 tài khoản admin: **`admin` / `admin123`**

> Đổi mật khẩu ngay sau khi đăng nhập qua trang **Quản trị → Tài khoản**.

### 5. Chạy ứng dụng

```bash
# Production
npm start

# Development (tự restart khi sửa code)
npm run dev
```

Mở trình duyệt: **http://localhost:3000**

## Cấu trúc thư mục

```
docsManager/
├── db/               # Schema & kết nối SQLite
├── lib/              # Helpers (access control, PDF convert)
├── middleware/        # JWT auth middleware
├── public/           # Static files, uploads, PDF cache
│   ├── css/
│   ├── uploads/      # File tài liệu gốc
│   └── pdf_cache/    # PDF sau khi chuyển đổi
├── routes/           # Express routes (auth, docs, admin)
├── scripts/          # Seed script
├── src/              # Tailwind CSS source
├── views/            # EJS templates
│   ├── admin/        # Giao diện quản trị
│   ├── docs/         # Danh sách & xem tài liệu
│   └── partials/     # Header, footer
├── server.js         # Entry point
├── tailwind.config.js
├── .env.example
└── package.json
```

## Tính năng chính

| Tính năng | Mô tả |
|---|---|
| **Xem công khai** | Khách (không đăng nhập) xem tài liệu công khai |
| **Xem nội bộ** | Tài khoản khoa xem tài liệu của khoa mình + tài liệu được chia sẻ |
| **Đăng nhập JWT** | Cookie httpOnly, phiên **480 phút**, mật khẩu hash bằng bcrypt |
| **Admin CRUD** | Quản lý khoa/phòng, tài khoản, tài liệu |
| **Upload tài liệu** | Admin upload file, gán nguồn (tên khoa), chọn công khai / chia sẻ |
| **Xem trực tiếp** | PDF hiển thị trong iframe; Word/Excel/PPT chuyển PDF qua LibreOffice |
| **Tải file gốc** | Người dùng có quyền xem có thể tải file gốc |

## Công nghệ

- **Backend:** Node.js, Express
- **Frontend:** EJS, Tailwind CSS (CDN)
- **Database:** SQLite (sql.js — WASM, không cần native build)
- **Auth:** JWT + bcrypt + cookie httpOnly
- **Chuyển đổi PDF:** LibreOffice headless

## Ghi chú

- Mỗi khoa/phòng dùng **1 tài khoản chung**.
- File tải lên lưu tại `public/uploads/`, PDF cache tại `public/pdf_cache/`.
- Khi admin sửa tài liệu và upload file mới, PDF cache cũ sẽ tự xóa.
- Nếu không cài LibreOffice, tài liệu Word/Excel vẫn tải xuống được, chỉ không xem inline.
- Database file lưu tại `data/app.db`, tự động tạo khi khởi động lần đầu.
