const db = require('../db');

/**
 * Ghi nhận nhật ký lịch sử hoạt động của người dùng
 * @param {object} req - Đối tượng Request của Express
 * @param {string} actionType - Loại hành động: 'LOGIN', 'LOGOUT', 'VIEW_DOC', 'CREATE_DOC', 'EDIT_DOC', 'DELETE_DOC'
 * @param {number|null} documentId - ID của tài liệu liên quan
 * @param {string|null} documentTitle - Tiêu đề của tài liệu liên quan
 */
function logActivity(req, actionType, documentId = null, documentTitle = null) {
  try {
    const userId = req.user ? req.user.id : null;
    const username = req.user ? req.user.username : 'GUEST';
    
    // Thu thập địa chỉ IP
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    
    // Thu thập User-Agent (Thiết bị/Trình duyệt)
    const userAgent = req.headers['user-agent'] || '';

    db.prepare(`
      INSERT INTO activity_logs (
        user_id, username, action_type, document_id, document_title, ip_address, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, username, actionType, documentId, documentTitle, ipAddress, userAgent);
  } catch (err) {
    console.error('[Logger] Lỗi ghi nhận nhật ký hoạt động:', err);
  }
}

module.exports = {
  logActivity
};
