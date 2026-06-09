require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("./db");
const { optionalAuth } = require("./middleware/auth");
const authRoutes = require("./routes/auth");
const docsRoutes = require("./routes/docs");
const adminRoutes = require("./routes/admin");
const aiRoutes = require("./routes/ai");

const app = express();
const PORT = process.env.PORT || 3000;

const dirs = [
  path.join(__dirname, "public", "uploads"),
  path.join(__dirname, "public", "pdf_cache"),
  path.join(__dirname, "public", "css"),
];
for (const d of dirs) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(optionalAuth);

app.use((req, res, next) => {
  res.locals.user = req.user || null;
  next();
});

app.get("/", (req, res) => res.redirect("/docs"));

app.use("/", authRoutes);
app.use("/docs", docsRoutes);
app.use("/admin", adminRoutes);
app.use("/api/ai", aiRoutes);

app.use((req, res) => {
  res.status(404).render("error", {
    title: "Không tìm thấy",
    message: "Trang không tồn tại.",
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render("error", {
    title: "Lỗi máy chủ",
    message: "Đã xảy ra lỗi. Vui lòng thử lại sau.",
  });
});

if (!process.env.JWT_SECRET) {
  console.warn(
    "[cảnh báo] Chưa có JWT_SECRET trong .env — tạo file .env từ .env.example",
  );
}

(async () => {
  await db.initDb();
  console.log("SQLite đã sẵn sàng");

  const HOST = "0.0.0.0"; // Cho phép tất cả các thiết bị trong cùng mạng LAN truy cập

  // Server HTTP thông thường 
  app.listen(PORT, HOST, () => {
    console.log(`[HTTP] Docs Manager: http://localhost:${PORT}`);
  });

  // Server HTTPS bảo mật với chứng chỉ tự cấp
  try {
    const https = require("https");
    const selfsigned = require("selfsigned");
    const sslDir = path.join(__dirname, "ssl");
    const keyPath = path.join(sslDir, "key.pem");
    const certPath = path.join(sslDir, "cert.pem");

    if (!fs.existsSync(sslDir)) {
      fs.mkdirSync(sslDir);
    }

    let pems;
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      pems = {
        private: fs.readFileSync(keyPath, "utf-8"),
        cert: fs.readFileSync(certPath, "utf-8"),
      };
    } else {
      console.log("Đang khởi tạo chứng chỉ SSL mới cho cấu hình LAN...");
      const attrs = [{ name: "commonName", value: "192.168.10.8" }];
      pems = await selfsigned.generate(attrs, { days: 365, keySize: 2048 });
      fs.writeFileSync(keyPath, pems.private);
      fs.writeFileSync(certPath, pems.cert);
    }

    const httpsServer = https.createServer(
      {
        key: pems.private,
        cert: pems.cert,
      },
      app
    );

    const PORT_HTTPS = 3443;
    httpsServer.listen(PORT_HTTPS, HOST, () => {
      console.log(`[HTTPS] Truy cập nội bộ cho Mobile (yêu cầu cấp quyền Mic): https://192.168.10.8:${PORT_HTTPS}`);
    });
  } catch (err) {
    console.error("Lỗi khởi chạy server HTTPS:", err);
  }
})();
