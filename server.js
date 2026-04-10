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

  app.listen(PORT, HOST, () => {
    console.log(`Docs Manager: http://localhost:${PORT}`);
    console.log(`Truy cập trên mạng LAN: http://192.168.1.73:${PORT}`);
  });
})();
