/**
 * Quyền xem tài liệu:
 * - Khách: chỉ is_public
 * - Admin: tất cả
 * - Khoa: public + thuộc khoa + được chia sẻ
 */
function canViewDocument(user, doc) {
  if (doc.is_public) return true;
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'khoa' && user.khoa_id) {
    if (doc.owner_khoa_id === user.khoa_id) return true;
    if (doc.shared_khoa_ids && doc.shared_khoa_ids.includes(user.khoa_id)) return true;
  }
  return false;
}

function documentWithShares(db, row) {
  if (!row) return null;
  const shares = db
    .prepare('SELECT khoa_id FROM document_shares WHERE document_id = ?')
    .all(row.id)
    .map((s) => s.khoa_id);
  const tags = db
    .prepare('SELECT tag FROM document_tags WHERE document_id = ? ORDER BY tag')
    .all(row.id)
    .map((t) => t.tag);
  return {
    ...row,
    is_public: Boolean(row.is_public),
    shared_khoa_ids: shares,
    tags
  };
}

module.exports = { canViewDocument, documentWithShares };
