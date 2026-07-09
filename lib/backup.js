const fs = require('fs');
const path = require('path');
const db = require('../db');

function runBackup() {
  const dbPath = db.dbPath;
  const backupDir = path.join(path.dirname(dbPath), 'backups');

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  try {
    // Lưu các thay đổi trong bộ nhớ xuống đĩa trước khi copy
    db.saveSync();

    if (!fs.existsSync(dbPath)) {
      console.warn('[Backup] File database.sqlite không tồn tại trên đĩa.');
      return;
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const backupPath = path.join(backupDir, `database_backup_${dateStr}.sqlite`);
    
    fs.copyFileSync(dbPath, backupPath);
    console.log(`[Backup] Tự động sao lưu database thành công tại: ${backupPath}`);
    
    // Giới hạn số lượng bản backup (giữ tối đa 30 bản gần nhất)
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('database_backup_'))
      .map(f => ({ name: f, time: fs.statSync(path.join(backupDir, f)).mtime.getTime() }))
      .sort((a, b) => a.time - b.time);

    while (files.length > 30) {
      const oldest = files.shift();
      fs.unlinkSync(path.join(backupDir, oldest.name));
      console.log(`[Backup] Đã xóa bản sao lưu cũ để giải phóng dung lượng: ${oldest.name}`);
    }
  } catch (err) {
    console.error('[Backup] Lỗi trong quá trình tự động sao lưu:', err);
  }
}

function scheduleDailyBackup() {
  // Tính toán số mili-giây cho đến 12h đêm tiếp theo (00:00:00)
  function getMsUntilMidnight() {
    const now = new Date();
    const midnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1, // Ngày mai
      0, 0, 0, 0         // Đúng 12h đêm
    );
    return midnight.getTime() - now.getTime();
  }

  function startTimer() {
    const msUntilMidnight = getMsUntilMidnight();
    console.log(`[Backup] Tiến trình sao lưu tự động định kỳ đã được kích hoạt.`);
    console.log(`[Backup] Lịch sao lưu tiếp theo dự kiến sau ${(msUntilMidnight / 1000 / 3600).toFixed(2)} giờ.`);

    setTimeout(() => {
      runBackup();
      // Chạy lặp lại sau mỗi 24 giờ
      setInterval(runBackup, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
  }

  startTimer();
}

module.exports = {
  runBackup,
  scheduleDailyBackup
};
