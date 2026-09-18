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

  // Người dùng tự tải lên tài liệu này
  if (doc.uploaded_by && Number(doc.uploaded_by) === Number(user.id)) return true;

  // Người dùng thuộc khoa/phòng (cả role 'khoa' và 'department_head')
  if (user.khoa_id) {
    const userKid = Number(user.khoa_id);
    // Thuộc khoa phòng sở hữu tài liệu
    if (doc.owner_khoa_id && Number(doc.owner_khoa_id) === userKid) return true;
    // Nằm trong danh sách khoa được chia sẻ
    if (Array.isArray(doc.shared_khoa_ids) && doc.shared_khoa_ids.some((id) => Number(id) === userKid)) {
      return true;
    }
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
