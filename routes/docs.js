const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { canViewDocument, documentWithShares } = require('../lib/access');
const { isPdf, isViewable, convertToHtml } = require('../lib/docPreview');

const router = express.Router();

const UPLOAD_ROOT = path.join(__dirname, '..', 'public', 'uploads');

function getDocById(id) {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  return documentWithShares(db, row);
}

function listVisibleDocs(user, { search, tag, deptId } = {}) {
  let baseWhere = '';
  const params = [];

  if (user && user.role === 'admin') {
    baseWhere = 'WHERE 1=1';
  } else if (!user) {
    baseWhere = 'WHERE d.is_public = 1';
  } else {
    const kid = user.khoa_id;
    baseWhere = `WHERE (d.is_public = 1 OR d.owner_khoa_id = ? OR s.khoa_id = ?)`;
    params.push(kid, kid);
  }

  if (search) {
    baseWhere += ` AND (d.title LIKE ? OR d.source_label LIKE ?)`;
    const q = `%${search}%`;
    params.push(q, q);
  }

  if (tag) {
    baseWhere += ` AND EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id AND dt.tag = ?)`;
    params.push(tag);
  }

  if (deptId) {
    baseWhere += ` AND d.owner_khoa_id = ?`;
    params.push(parseInt(deptId, 10));
  }

  const needJoin = (!user || (user && user.role !== 'admin'));
  const joinClause = needJoin
    ? 'LEFT JOIN document_shares s ON s.document_id = d.id'
    : '';

  const sql = `SELECT DISTINCT d.* FROM documents d ${joinClause} ${baseWhere} ORDER BY d.created_at DESC`;
  const rows = db.prepare(sql).all(...params);
  return rows.map((r) => documentWithShares(db, r));
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
  const tag = (req.query.tag || '').trim();
  const deptId = req.query.dept || '';

  const docs = listVisibleDocs(req.user, { search, tag, deptId });
  const allTags = getAllTags();
  const departments = getAllDepartments();

  res.render('docs/list', {
    title: 'Tài liệu',
    docs,
    isAdmin: req.user?.role === 'admin',
    allTags,
    departments,
    filters: { search, tag, deptId }
  });
});

function inlineMsg(title, msg, docId) {
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"/>
<style>*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8fafc;color:#334155}
.box{text-align:center;padding:40px 24px}
.box h2{font-size:18px;margin-bottom:8px}
.box p{font-size:14px;color:#64748b;margin-bottom:16px}
.box a{display:inline-block;padding:8px 20px;background:#0284c7;color:#fff;border-radius:6px;text-decoration:none;font-size:14px}
.box a:hover{background:#0369a1}
</style></head><body><div class="box">
<h2>${title}</h2><p>${msg}</p>
<a href="/docs/${docId}/download">Tải file gốc</a>
</div></body></html>`;
}

router.get('/:id/view', async (req, res, next) => {
  const doc = getDocById(req.params.id);
  if (!doc) return next();
  if (!canViewDocument(req.user, doc)) {
    if (!req.user) {
      return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    }
    return res.type('html').status(403).send(
      inlineMsg('Không có quyền', 'Bạn không được xem tài liệu này.', req.params.id)
    );
  }

  const filePath = path.join(UPLOAD_ROOT, doc.stored_filename);
  if (!fs.existsSync(filePath)) {
    return res.type('html').status(404).send(
      inlineMsg('Không tìm thấy', 'File không còn trên máy chủ.', doc.id)
    );
  }

  if (isPdf(doc.original_filename)) {
    res.type('pdf');
    return res.sendFile(filePath);
  }

  if (!isViewable(doc.original_filename)) {
    return res.type('html').send(
      inlineMsg(
        'Chưa hỗ trợ xem trực tiếp',
        `Định dạng ${path.extname(doc.original_filename)} chưa hỗ trợ xem trong trình duyệt.`,
        doc.id
      )
    );
  }

  try {
    const html = await convertToHtml(filePath, doc.original_filename);
    res.type('html').send(html);
  } catch (e) {
    console.error('Preview error:', e.message);
    return res.type('html').status(500).send(
      inlineMsg('Lỗi xem tài liệu', 'Không thể hiển thị file.', doc.id)
    );
  }
});

/** Serve raw PDF binary cho PDF.js viewer */
router.get('/:id/view/raw', (req, res, next) => {
  const doc = getDocById(req.params.id);
  if (!doc) return next();
  if (!canViewDocument(req.user, doc)) {
    return res.status(403).send('Forbidden');
  }
  const filePath = path.join(UPLOAD_ROOT, doc.stored_filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.type('pdf');
  res.sendFile(filePath);
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
  const filePath = path.join(UPLOAD_ROOT, doc.stored_filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.download(filePath, doc.original_filename);
});

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
  res.render('docs/view', {
    title: doc.title,
    doc,
    viewMode: null,
    viewError: null
  });
});

module.exports = router;
