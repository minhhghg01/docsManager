const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { canViewDocument, documentWithShares } = require('../lib/access');
const { isPdf, isImage, isMedia, isPlainText, isViewable, convertToHtml } = require('../lib/docPreview');
const { logActivity } = require('../lib/logger');

const router = express.Router();

const UPLOAD_ROOT = path.join(__dirname, '..', 'public', 'uploads');

function simpleMsg(msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#334155}
.box{text-align:center;padding:40px 24px}.box p{font-size:14px;color:#64748b}</style>
</head><body><div class="box"><p>${msg}</p></div></body></html>`;
}

function getDocById(id) {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  return documentWithShares(db, row);
}

function buildVisibilityClause(user) {
  const params = [];
  let where;
  let needJoin = false;
  if (user && user.role === 'admin') {
    where = 'WHERE 1=1';
  } else if (!user) {
    where = 'WHERE d.is_public = 1';
  } else {
    const orParts = ['d.is_public = 1', 'd.uploaded_by = ?'];
    params.push(user.id);
    if (user.khoa_id) {
      orParts.push('d.owner_khoa_id = ?', 's.khoa_id = ?');
      params.push(user.khoa_id, user.khoa_id);
      needJoin = true;
    }
    where = `WHERE (${orParts.join(' OR ')})`;
  }
  return { where, params, needJoin };
}

function listVisibleDocs(user, { search, tags, deptId, pub } = {}) {
  const { where, params, needJoin } = buildVisibilityClause(user);
  let baseWhere = where;
  const p = [...params];

  if (search) {
    baseWhere += ' AND (d.title LIKE ? OR d.source_label LIKE ?)';
    const q = `%${search}%`;
    p.push(q, q);
  }

  if (tags && tags.length) {
    const ph = tags.map(() => '?').join(',');
    baseWhere += ` AND EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id AND dt.tag IN (${ph}))`;
    p.push(...tags);
  }

  if (deptId) {
    baseWhere += ' AND d.owner_khoa_id = ?';
    p.push(parseInt(deptId, 10));
  }

  if (pub === '1') {
    baseWhere += ' AND d.is_public = 1';
  } else if (pub === '0') {
    baseWhere += ' AND d.is_public = 0';
  }

  const joinClause = needJoin
    ? 'LEFT JOIN document_shares s ON s.document_id = d.id'
    : '';
  const sql = `SELECT DISTINCT d.* FROM documents d ${joinClause} ${baseWhere} ORDER BY d.created_at DESC`;
  const rows = db.prepare(sql).all(...p);
  return rows.map((r) => documentWithShares(db, r));
}

function getTagCounts(user) {
  const { where, params, needJoin } = buildVisibilityClause(user);
  const joinClause = needJoin
    ? 'LEFT JOIN document_shares s ON s.document_id = d.id'
    : '';
  const sql = `SELECT dt.tag, COUNT(DISTINCT d.id) AS cnt
    FROM documents d ${joinClause}
    JOIN document_tags dt ON dt.document_id = d.id
    ${where}
    GROUP BY dt.tag ORDER BY dt.tag`;
  const rows = db.prepare(sql).all(...params);
  const counts = {};
  rows.forEach((r) => { counts[r.tag] = r.cnt; });
  return counts;
}

function getDeptCounts(user) {
  const { where, params, needJoin } = buildVisibilityClause(user);
  const joinClause = needJoin
    ? 'LEFT JOIN document_shares s ON s.document_id = d.id'
    : '';
  const sql = `SELECT d.owner_khoa_id AS kid, COUNT(DISTINCT d.id) AS cnt
    FROM documents d ${joinClause}
    ${where} AND d.owner_khoa_id IS NOT NULL
    GROUP BY d.owner_khoa_id`;
  const rows = db.prepare(sql).all(...params);
  const counts = {};
  rows.forEach((r) => { counts[r.kid] = r.cnt; });
  return counts;
}

function getAllTags() {
  return db
    .prepare('SELECT DISTINCT tag FROM document_tags ORDER BY tag')
    .all()
    .map((r) => r.tag);
}

function getAllDepartments() {
  return db.prepare('SELECT * FROM departments ORDER BY name').all();
}

router.get('/', (req, res) => {
  const search = (req.query.q || '').trim();
  const tagsParam = (req.query.tags || '').trim();
  const selectedTags = tagsParam
    ? tagsParam.split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  const deptId = req.query.dept || '';
  const pub = req.query.pub || '';
  const psRaw = req.query.ps || '6';
  const pageSize = psRaw === 'all' ? 0 : parseInt(psRaw, 10) || 6;
  const page = parseInt(req.query.page || '1', 10) || 1;

  const allDocs = listVisibleDocs(req.user, {
    search,
    tags: selectedTags,
    deptId,
    pub
  });
  const totalCount = allDocs.length;

  let docs, totalPages, currentPage;
  if (pageSize > 0) {
    totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    currentPage = Math.max(1, Math.min(page, totalPages));
    const start = (currentPage - 1) * pageSize;
    docs = allDocs.slice(start, start + pageSize);
  } else {
    totalPages = 1;
    currentPage = 1;
    docs = allDocs;
  }

  const allTags = getAllTags();
  const departments = getAllDepartments();
  const tagCounts = getTagCounts(req.user);
  const deptCounts = getDeptCounts(req.user);

  const qp = new URLSearchParams();
  if (search) qp.set('q', search);
  if (selectedTags.length) qp.set('tags', selectedTags.join(','));
  if (deptId) qp.set('dept', deptId);
  if (pub) qp.set('pub', pub);
  const qs = qp.toString();
  const paginationBase = '/docs' + (qs ? '?' + qs : '');

  res.render('docs/list', {
    title: 'Tài liệu',
    docs,
    isAdmin: req.user?.role === 'admin',
    allTags,
    departments,
    tagCounts,
    deptCounts,
    filters: { search, tags: selectedTags, deptId, pub },
    pagination: {
      page: currentPage,
      totalPages,
      totalCount,
      pageSize: psRaw,
      showing: docs.length,
      base: paginationBase
    }
  });
});

// API hỗ trợ tìm kiếm ngầm cho Tính năng Voice Command
router.get('/api/search', (req, res) => {
  const search = (req.query.q || '').trim();
  const idParam = req.query.id;

  if (idParam) {
    const doc = getDocById(idParam);
    if (doc && canViewDocument(req.user, doc)) {
      return res.json([{ id: doc.id, title: doc.title, source_label: doc.source_label }]);
    }
    return res.json([]);
  }

  if (!search) return res.json([]);
  
  // Sử dụng lại hàm rà soát quyền hạn (chỉ lấy tài liệu có thể xem)
  const allDocs = listVisibleDocs(req.user, { search });
  
  // Fixes: mapping the docs to ensure safe delivery and limiting results to top 5
  const results = allDocs.slice(0, 5).map(d => ({
     id: d.id,
     title: d.title,
     source_label: d.source_label
  }));
  res.json(results);
});

router.get('/:id/view', async (req, res, next) => {
  const doc = getDocById(req.params.id);
  if (!doc) return next();
  if (!canViewDocument(req.user, doc)) {
    if (!req.user) {
      return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    }
    return res.type('html').status(403).send(simpleMsg('Bạn không có quyền xem tài liệu này.'));
  }

  if (doc.stored_filename.startsWith('http://') || doc.stored_filename.startsWith('https://')) {
    return res.redirect(doc.stored_filename);
  }

  const filePath = path.join(UPLOAD_ROOT, doc.stored_filename);
  if (!fs.existsSync(filePath)) {
    return res.type('html').status(404).send(simpleMsg('File không còn trên máy chủ.'));
  }

  if (isPdf(doc.original_filename) || isImage(doc.original_filename) || isMedia(doc.original_filename)) {
    // Trình duyệt hỗ trợ native các đuôi này
    res.type(path.extname(doc.original_filename));
    return res.sendFile(filePath);
  }

  if (!isViewable(doc.original_filename)) {
    return res.type('html').send(
      simpleMsg('Định dạng này chưa hỗ trợ xem trong trình duyệt. Vui lòng tải xuống.')
    );
  }

  try {
    const html = await convertToHtml(filePath, doc.original_filename);
    res.type('html').send(html);
  } catch (e) {
    console.error('Preview error:', e.message);
    return res.type('html').status(500).send(
      simpleMsg('Không thể hiển thị file. Vui lòng tải file gốc để xem.')
    );
  }
});

router.get('/:id/download', (req, res, next) => {
  const doc = getDocById(req.params.id);
  if (!doc) return next();
  if (!canViewDocument(req.user, doc)) {
    if (!req.user) {
      return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    }
    return res.status(403).send('Forbidden');
  }

  if (doc.stored_filename.startsWith('http://') || doc.stored_filename.startsWith('https://')) {
    return res.redirect(doc.stored_filename);
  }

  const filePath = path.join(UPLOAD_ROOT, doc.stored_filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.download(filePath, doc.original_filename);
});

const { requireAuth } = require('../middleware/auth');

router.get('/:id', (req, res, next) => {
  const doc = getDocById(req.params.id);
  if (!doc) return next();
  if (!canViewDocument(req.user, doc)) {
    if (!req.user) {
      return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    }
    return res.status(403).render('error', {
      title: 'Không có quyền',
      message: 'Bạn không được xem tài liệu này.'
    });
  }
  
  logActivity(req, 'VIEW_DOC', doc.id, doc.title);

  const highlight = (req.query.highlight || '').trim();

  // Lấy danh sách bình luận kèm thông tin người dùng và khoa phòng
  const comments = db.prepare(`
    SELECT c.*, u.username, u.role, d.name AS khoa_name, d.name AS department_name
    FROM document_comments c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN departments d ON d.id = u.khoa_id
    WHERE c.document_id = ?
    ORDER BY c.created_at ASC
  `).all(doc.id);

  res.render('docs/view', {
    title: doc.title,
    doc,
    comments: comments || [],
    highlight,
    viewMode: null,
    viewError: null
  });
});

/* ───── Thêm bình luận cho tài liệu ───── */
router.post('/:id/comments', requireAuth, (req, res) => {
  const isAjax = req.xhr || req.headers['accept']?.includes('application/json') || req.is('json');
  const doc = getDocById(req.params.id);
  if (!doc) {
    if (isAjax) return res.status(404).json({ error: 'Tài liệu không tồn tại.' });
    return res.status(404).render('error', { title: 'Không tìm thấy', message: 'Tài liệu không tồn tại.' });
  }
  if (!canViewDocument(req.user, doc)) {
    if (isAjax) return res.status(403).json({ error: 'Bạn không có quyền truy cập tài liệu này.' });
    return res.status(403).render('error', { title: 'Không có quyền', message: 'Bạn không có quyền truy cập tài liệu này.' });
  }

  const content = (req.body.content || '').trim();
  if (!content) {
    if (isAjax) return res.status(400).json({ error: 'Nội dung bình luận không được để trống.' });
    return res.redirect(`/docs/${doc.id}?error=${encodeURIComponent('Nội dung bình luận không được để trống.')}#comments`);
  }

  const info = db.prepare(`
    INSERT INTO document_comments (document_id, user_id, content)
    VALUES (?, ?, ?)
  `).run(doc.id, req.user.id, content);

  if (typeof db.saveSync === 'function') db.saveSync();
  logActivity(req, 'COMMENT_DOC', doc.id, doc.title);

  if (isAjax) {
    const newComment = db.prepare(`
      SELECT c.*, u.username, u.role, d.name AS khoa_name, d.name AS department_name
      FROM document_comments c
      JOIN users u ON u.id = c.user_id
      LEFT JOIN departments d ON d.id = u.khoa_id
      WHERE c.id = ?
    `).get(info.lastInsertRowid);
    return res.json({ ok: true, comment: newComment, currentUserId: req.user.id, currentUserRole: req.user.role });
  }

  res.redirect(`/docs/${doc.id}?success=${encodeURIComponent('Đã gửi bình luận thành công.')}#comments`);
});

/* ───── Xóa bình luận (Admin hoặc chính chủ) ───── */
router.post('/:id/comments/:commentId/delete', requireAuth, (req, res) => {
  const isAjax = req.xhr || req.headers['accept']?.includes('application/json') || req.is('json');
  const doc = getDocById(req.params.id);
  if (!doc) {
    if (isAjax) return res.status(404).json({ error: 'Tài liệu không tồn tại.' });
    return res.status(404).render('error', { title: 'Không tìm thấy', message: 'Tài liệu không tồn tại.' });
  }

  const commentId = parseInt(req.params.commentId, 10);
  const comment = db.prepare('SELECT * FROM document_comments WHERE id = ? AND document_id = ?').get(commentId, doc.id);
  if (!comment) {
    if (isAjax) return res.status(404).json({ error: 'Bình luận không tồn tại hoặc đã bị xóa.' });
    return res.redirect(`/docs/${doc.id}#comments`);
  }

  // Chỉ Admin hoặc chính người tạo bình luận mới có quyền xóa
  if (req.user.role !== 'admin' && req.user.id !== comment.user_id) {
    if (isAjax) return res.status(403).json({ error: 'Bạn không có quyền xóa bình luận này.' });
    return res.status(403).render('error', { title: 'Không có quyền', message: 'Bạn không có quyền xóa bình luận này.' });
  }

  db.prepare('DELETE FROM document_comments WHERE id = ?').run(commentId);
  if (typeof db.saveSync === 'function') db.saveSync();
  logActivity(req, 'DELETE_COMMENT', doc.id, doc.title);

  if (isAjax) {
    return res.json({ ok: true, commentId });
  }

  res.redirect(`/docs/${doc.id}?success=${encodeURIComponent('Đã xóa bình luận.')}#comments`);
});

module.exports = router;
