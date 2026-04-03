require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../db');

const adminUser = process.env.SEED_ADMIN_USER || 'admin';
const adminPass = process.env.SEED_ADMIN_PASS || 'admin123';

(async () => {
  await db.initDb();

  db.prepare(
    `INSERT OR IGNORE INTO departments (id, name) VALUES (1, 'Khoa CNTT')`
  ).run();

  const hash = bcrypt.hashSync(adminPass, 10);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUser);
  if (!existing) {
    db.prepare(
      `INSERT INTO users (username, password_hash, role, khoa_id) VALUES (?,?, 'admin', NULL)`
    ).run(adminUser, hash);
    console.log(`Đã tạo admin: ${adminUser} / ${adminPass}`);
  } else {
    console.log('Admin đã tồn tại, bỏ qua tạo user.');
  }

  console.log('Seed xong.');
})();
