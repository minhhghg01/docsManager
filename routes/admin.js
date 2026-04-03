const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { documentWithShares } = require('../lib/access');

const router = express.Router();
router.use(requireAdmin);

const UPLOAD_ROOT = path.join(__dirname, '..', 'public', 'uploads');
const PDF_CACHE = path.join(__dirname, '..', 'public', 'pdf_cache');

function fixOriginalName(file) {
  file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf-8');
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fixOriginalName(file);
    cb(null, UPLOAD_ROOT);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 80 * 1024 * 1024 }
});

function parseKhoaIds(body) {
  const raw = body.shared_khoa_ids;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((x) => parseInt(x, 10))
    .filter((n) => !Number.isNaN(n));
}

function parseTags(body) {
  const raw = (body.tags || '').trim();
  if (!raw) return [];
  return [...new Set(
    raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
  )];
}

function paginate(items, query) {
  const psRaw = query.ps || '10';
  const pageSize = psRaw === 'all' ? 0 : parseInt(psRaw, 10) || 10;
  const page = parseInt(query.page || '1', 10) || 1;
  const totalCount = items.length;
  if (pageSize <= 0) {
    return {
      items,
      pg: { page: 1, totalPages: 1, totalCount, pageSize: 'all', showing: totalCount }
    };
  }
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const p = Math.max(1, Math.min(page, totalPages));
  const start = (p - 1) * pageSize;
  const sliced = items.slice(start, start + pageSize);
  return {
    items: sliced,
    pg: { page: p, totalPages, totalCount, pageSize: psRaw, showing: sliced.length }
  };
}

function saveTags(docId, tags) {
  db.prepare('DELETE FROM document_tags WHERE document_id = ?').run(docId);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO document_tags (document_id, tag) VALUES (?,?)'
  );
  for (const t of tags) {
    ins.run(docId, t);
  }
}

router.get('/', (req, res) => {
  res.redirect('/admin/dashboard');
});

router.get('/dashboard', (req, res) => {
  const docCount = db.prepare('SELECT COUNT(*) AS c FROM documents').get().c;
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const deptCount = db.prepare('SELECT COUNT(*) AS c FROM departments').get().c;
  res.render('admin/dashboard', {
    title: 'Quản trị',
    docCount,
    userCount,
    deptCount
  });
});

/* ——— Khoa phòng ——— */
router.get('/departments', (req, res) => {
  const all = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const { items: departments, pg } = paginate(all, req.query);
  pg.base = '/admin/departments';
  res.render('admin/departments', { title: 'Khoa / phòng', departments, allDepartments: all, pg, error: null });
});

router.post('/departments', express.urlencoded({ extended: true }), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
    return res.render('admin/departments', {
      title: 'Khoa / phòng',
      departments,
      error: 'Tên không được để trống.'
    });
  }
  try {
    db.prepare('INSERT INTO departments (name) VALUES (?)').run(name);
  } catch {
    const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
    return res.render('admin/departments', {
      title: 'Khoa / phòng',
      departments,
      error: 'Tên đã tồn tại.'
    });
  }
  res.redirect('/admin/departments');
});

router.post('/departments/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const inUse =
    db.prepare('SELECT 1 FROM users WHERE khoa_id = ? LIMIT 1').get(id) ||
    db.prepare('SELECT 1 FROM documents WHERE owner_khoa_id = ? LIMIT 1').get(id) ||
    db.prepare('SELECT 1 FROM document_shares WHERE khoa_id = ? LIMIT 1').get(id);
  if (inUse) {
    const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
    return res.render('admin/departments', {
      title: 'Khoa / phòng',
      departments,
      error: 'Không xóa được: còn user hoặc tài liệu gắn khoa này.'
    });
  }
  db.prepare('DELETE FROM departments WHERE id = ?').run(id);
  res.redirect('/admin/departments');
});

router.post('/departments/:id/edit', express.urlencoded({ extended: true }), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/admin/departments');
  try {
    db.prepare('UPDATE departments SET name = ? WHERE id = ?').run(name, id);
  } catch {
    const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
    return res.render('admin/departments', {
      title: 'Khoa / phòng',
      departments,
      error: 'Tên đã tồn tại.'
    });
  }
  res.redirect('/admin/departments');
});

/* ——— Users ——— */
router.get('/users', (req, res) => {
  const all = db
    .prepare(
      `SELECT u.*, d.name AS khoa_name FROM users u
       LEFT JOIN departments d ON d.id = u.khoa_id
       ORDER BY u.role DESC, u.username`
    )
    .all();
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const { items: users, pg } = paginate(all, req.query);
  pg.base = '/admin/users';
  res.render('admin/users', {
    title: 'Tài khoản',
    users,
    departments,
    pg,
    error: null
  });
});

const PW_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{8,}$/;
const PW_MSG = 'Mật khẩu tối thiểu 8 ký tự, gồm chữ hoa, chữ thường, số và ký tự đặc biệt.';

router.post('/users', express.urlencoded({ extended: true }), (req, res) => {
  const { username, password, role, khoa_id } = req.body;
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const users = db
    .prepare(
      `SELECT u.*, d.name AS khoa_name FROM users u
       LEFT JOIN departments d ON d.id = u.khoa_id
       ORDER BY u.role DESC, u.username`
    )
    .all();
  if (!username?.trim() || !password) {
    return res.render('admin/users', {
      title: 'Tài khoản',
      users,
      departments,
      pg: { page: 1, totalPages: 1, totalCount: users.length, pageSize: '10', showing: users.length, base: '/admin/users' },
      error: 'Cần username và mật khẩu.'
    });
  }
  if (!PW_REGEX.test(password)) {
    return res.render('admin/users', {
      title: 'Tài khoản',
      users,
      departments,
      pg: { page: 1, totalPages: 1, totalCount: users.length, pageSize: '10', showing: users.length, base: '/admin/users' },
      error: PW_MSG
    });
  }
  if (role === 'khoa' && !khoa_id) {
    return res.render('admin/users', {
      title: 'Tài khoản',
      users,
      departments,
      pg: { page: 1, totalPages: 1, totalCount: users.length, pageSize: '10', showing: users.length, base: '/admin/users' },
      error: 'Tài khoản khoa cần chọn khoa/phòng.'
    });
  }
  const hash = bcrypt.hashSync(password, 10);
  const kid = role === 'admin' ? null : parseInt(khoa_id, 10);
  try {
    db.prepare(
      `INSERT INTO users (username, password_hash, role, khoa_id) VALUES (?,?,?,?)`
    ).run(username.trim(), hash, role === 'admin' ? 'admin' : 'khoa', kid);
  } catch {
    return res.render('admin/users', {
      title: 'Tài khoản',
      users,
      departments,
      pg: { page: 1, totalPages: 1, totalCount: users.length, pageSize: '10', showing: users.length, base: '/admin/users' },
      error: 'Username đã tồn tại.'
    });
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) {
    return res.redirect('/admin/users');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.redirect('/admin/users');
});

router.post('/users/:id/password', express.urlencoded({ extended: true }), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const password = req.body.password;
  if (!password) return res.redirect('/admin/users');
  if (!PW_REGEX.test(password)) {
    const all = db.prepare(`SELECT u.*, d.name AS khoa_name FROM users u LEFT JOIN departments d ON d.id = u.khoa_id ORDER BY u.role DESC, u.username`).all();
    const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
    const { items: users, pg } = paginate(all, req.query);
    pg.base = '/admin/users';
    return res.render('admin/users', { title: 'Tài khoản', users, departments, pg, error: PW_MSG });
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  res.redirect('/admin/users');
});

/* ——— Documents ——— */
router.get('/documents', (req, res) => {
  const rows = db.prepare(`SELECT * FROM documents ORDER BY created_at DESC`).all();
  const allDocs = rows.map((r) => documentWithShares(db, r));
  const { items: docs, pg } = paginate(allDocs, req.query);
  pg.base = '/admin/documents';
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  res.render('admin/documents', { title: 'Tài liệu (quản trị)', docs, pg, departments });
});

router.get('/documents/new', (req, res) => {
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  res.render('admin/document-form', {
    title: 'Thêm tài liệu',
    doc: null,
    departments,
    error: null
  });
});

router.post('/documents', upload.single('file'), (req, res) => {
    const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
    const { title, source_label, is_public, owner_khoa_id } = req.body;
    if (!req.file) {
      return res.render('admin/document-form', {
        title: 'Thêm tài liệu',
        doc: null,
        departments,
        error: 'Cần chọn file.'
      });
    }
    if (!title?.trim() || !source_label?.trim()) {
      fs.unlinkSync(req.file.path);
      return res.render('admin/document-form', {
        title: 'Thêm tài liệu',
        doc: null,
        departments,
        error: 'Tiêu đề và nguồn không được để trống.'
      });
    }
    const pub = is_public === '1' || is_public === 'on' ? 1 : 0;
    const owner =
      owner_khoa_id && String(owner_khoa_id).trim()
        ? parseInt(owner_khoa_id, 10)
        : null;
    const info = db
      .prepare(
        `INSERT INTO documents (
          title, source_label, stored_filename, original_filename, mime_type,
          is_public, owner_khoa_id, uploaded_by, updated_at
        ) VALUES (?,?,?,?,?,?,?,?, datetime('now'))`
      )
      .run(
        title.trim(),
        source_label.trim(),
        req.file.filename,
        req.file.originalname,
        req.file.mimetype || null,
        pub,
        owner,
        req.user.id
      );
    const docId = info.lastInsertRowid;
    const shares = parseKhoaIds(req.body);
    const insShare = db.prepare(
      'INSERT OR IGNORE INTO document_shares (document_id, khoa_id) VALUES (?,?)'
    );
    for (const k of shares) {
      if (k !== owner) insShare.run(docId, k);
    }
    saveTags(docId, parseTags(req.body));
    res.redirect('/admin/documents');
  }
);

router.get('/documents/:id/edit', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!row) return res.redirect('/admin/documents');
  const doc = documentWithShares(db, row);
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  res.render('admin/document-form', {
    title: 'Sửa tài liệu',
    doc,
    departments,
    error: null
  });
});

router.post('/documents/:id', upload.single('file'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (!row) return res.redirect('/admin/documents');

    const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
    const { title, source_label, is_public, owner_khoa_id } = req.body;
    if (!title?.trim() || !source_label?.trim()) {
      const doc = documentWithShares(db, row);
      return res.render('admin/document-form', {
        title: 'Sửa tài liệu',
        doc,
        departments,
        error: 'Tiêu đề và nguồn không được để trống.'
      });
    }
    const pub = is_public === '1' || is_public === 'on' ? 1 : 0;
    const owner =
      owner_khoa_id && String(owner_khoa_id).trim()
        ? parseInt(owner_khoa_id, 10)
        : null;

    let stored = row.stored_filename;
    let original = row.original_filename;
    let mime = row.mime_type;
    let clearPdf = false;

    if (req.file) {
      const oldPath = path.join(UPLOAD_ROOT, row.stored_filename);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      if (row.pdf_cache_filename) {
        const cachePath = path.join(PDF_CACHE, row.pdf_cache_filename);
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
        const cacheDir = path.join(PDF_CACHE, String(id));
        if (fs.existsSync(cacheDir)) {
          fs.rmSync(cacheDir, { recursive: true, force: true });
        }
      }
      stored = req.file.filename;
      original = req.file.originalname;
      mime = req.file.mimetype || null;
      clearPdf = true;
    }

    if (clearPdf) {
      db.prepare(
        `UPDATE documents SET
          title = ?, source_label = ?, stored_filename = ?, original_filename = ?,
          mime_type = ?, is_public = ?, owner_khoa_id = ?, pdf_cache_filename = NULL,
          updated_at = datetime('now')
        WHERE id = ?`
      ).run(title.trim(), source_label.trim(), stored, original, mime, pub, owner, id);
    } else {
      db.prepare(
        `UPDATE documents SET
          title = ?, source_label = ?, stored_filename = ?, original_filename = ?,
          mime_type = ?, is_public = ?, owner_khoa_id = ?,
          updated_at = datetime('now')
        WHERE id = ?`
      ).run(title.trim(), source_label.trim(), stored, original, mime, pub, owner, id);
    }

    db.prepare('DELETE FROM document_shares WHERE document_id = ?').run(id);
    const shares = parseKhoaIds(req.body);
    const insShare = db.prepare(
      'INSERT OR IGNORE INTO document_shares (document_id, khoa_id) VALUES (?,?)'
    );
    for (const k of shares) {
      if (k !== owner) insShare.run(id, k);
    }
    saveTags(id, parseTags(req.body));

    res.redirect('/admin/documents');
  }
);

router.post('/documents/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (row) {
    const fp = path.join(UPLOAD_ROOT, row.stored_filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    if (row.pdf_cache_filename) {
      const cp = path.join(PDF_CACHE, row.pdf_cache_filename);
      if (fs.existsSync(cp)) fs.unlinkSync(cp);
    }
    const cacheDir = path.join(PDF_CACHE, String(id));
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
    db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  }
  res.redirect('/admin/documents');
});

module.exports = router;
