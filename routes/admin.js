const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { documentWithShares } = require('../lib/access');
const { extractText, summarizeDocument } = require('../lib/ai');

const router = express.Router();
router.use(requireAdmin);

const UPLOAD_ROOT = path.join(__dirname, '..', 'public', 'uploads');
const PDF_CACHE = path.join(__dirname, '..', 'public', 'pdf_cache');

/**
 * Hàm tự động tóm tắt tài liệu chạy ngầm không block ứng dụng
 */
function autoSummarizeInBackground(docId, storedFilename, originalFilename, title) {
  setTimeout(async () => {
    try {
      const filePath = path.join(UPLOAD_ROOT, storedFilename);
      if (!fs.existsSync(filePath)) return;
      
      const text = await extractText(filePath, originalFilename);
      if (!text || text.trim().length < 50) return;

      const summary = await summarizeDocument(text, title);
      db.prepare('UPDATE documents SET ai_summary = ? WHERE id = ?').run(summary, docId);
      console.log(`[AI] Đã tóm tắt tự động xong cho tài liệu ID ${docId}`);
    } catch (err) {
      console.error(`[AI Auto-Summarize] Lỗi tài liệu ID ${docId}:`, err.message);
    }
  }, 2000); // Đợi 2s để file ổn định
}

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
  const psRaw = query.ps || '6';
  const pageSize = psRaw === 'all' ? 0 : parseInt(psRaw, 10) || 6;
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
      pg: { page: 1, totalPages: 1, totalCount: users.length, pageSize: '6', showing: users.length, base: '/admin/users' },
      error: 'Cần username và mật khẩu.'
    });
  }
  if (!PW_REGEX.test(password)) {
    return res.render('admin/users', {
      title: 'Tài khoản',
      users,
      departments,
      pg: { page: 1, totalPages: 1, totalCount: users.length, pageSize: '6', showing: users.length, base: '/admin/users' },
      error: PW_MSG
    });
  }
  if (role === 'khoa' && !khoa_id) {
    return res.render('admin/users', {
      title: 'Tài khoản',
      users,
      departments,
      pg: { page: 1, totalPages: 1, totalCount: users.length, pageSize: '6', showing: users.length, base: '/admin/users' },
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
      pg: { page: 1, totalPages: 1, totalCount: users.length, pageSize: '6', showing: users.length, base: '/admin/users' },
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
  const tags = db.prepare('SELECT DISTINCT tag FROM document_tags ORDER BY tag').all().map(t => t.tag);
  res.render('admin/document-form', {
    title: 'Thêm tài liệu',
    doc: null,
    departments,
    tags,
    error: null
  });
});

const uploadFields = upload.fields([
  { name: 'file', maxCount: 100 },
  { name: 'banner', maxCount: 1 }
]);

router.post('/documents', uploadFields, (req, res) => {
    const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
    const tags = db.prepare('SELECT DISTINCT tag FROM document_tags ORDER BY tag').all().map(t => t.tag);
    const { title, source_label, is_public, owner_khoa_id, source_type, file_url } = req.body;
    const mainFiles = req.files?.file || [];
    const bannerFile = req.files?.banner?.[0];

    const isLinkType = source_type === 'link';

    // Hàm tiện ích để xóa tất cả file tạm khi có lỗi
    const cleanupUploadedFiles = () => {
      mainFiles.forEach(f => {
        if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
      });
      if (bannerFile && fs.existsSync(bannerFile.path)) {
        fs.unlinkSync(bannerFile.path);
      }
    };

    if (!isLinkType && mainFiles.length === 0) {
      cleanupUploadedFiles();
      return res.render('admin/document-form', {
        title: 'Thêm tài liệu',
        doc: null,
        departments,
        tags,
        error: 'Cần chọn ít nhất một file.'
      });
    }

    if (isLinkType && !file_url?.trim()) {
      cleanupUploadedFiles();
      return res.render('admin/document-form', {
        title: 'Thêm tài liệu',
        doc: null,
        departments,
        tags,
        error: 'Cần nhập đường dẫn liên kết (URL).'
      });
    }

    // Nếu là dạng tệp tin hàng loạt, chúng ta không yêu cầu Tiêu đề bắt buộc từ form
    // vì tiêu đề sẽ được lấy theo tên file. Nhưng nếu chỉ có 1 file hoặc là Link, Tiêu đề vẫn bắt buộc.
    const isSingleDoc = isLinkType || mainFiles.length === 1;
    if (isSingleDoc && (!title?.trim() || !source_label?.trim())) {
      cleanupUploadedFiles();
      return res.render('admin/document-form', {
        title: 'Thêm tài liệu',
        doc: null,
        departments,
        tags,
        error: 'Tiêu đề và nguồn không được để trống.'
      });
    } else if (!isSingleDoc && !source_label?.trim()) {
      cleanupUploadedFiles();
      return res.render('admin/document-form', {
        title: 'Thêm tài liệu',
        doc: null,
        departments,
        tags,
        error: 'Nguồn tài liệu không được để trống.'
      });
    }

    const pub = is_public === '1' || is_public === 'on' ? 1 : 0;
    const owner =
      owner_khoa_id && String(owner_khoa_id).trim()
        ? parseInt(owner_khoa_id, 10)
        : null;
    const bannerFn = bannerFile ? bannerFile.filename : null;

    const docsToCreate = [];
    if (isLinkType) {
      docsToCreate.push({
        title: title.trim(),
        storedFilename: file_url.trim(),
        originalFilename: file_url.trim(),
        mimeType: 'text/html',
        isLocalFile: false
      });
    } else {
      mainFiles.forEach(file => {
        // Tên file bỏ extension
        const parsedName = path.parse(file.originalname).name;
        // Nếu upload 1 file duy nhất, sử dụng tiêu đề từ form, ngược lại lấy tên file làm tiêu đề
        const docTitle = mainFiles.length === 1 ? title.trim() : parsedName;
        docsToCreate.push({
          title: docTitle,
          storedFilename: file.filename,
          originalFilename: file.originalname,
          mimeType: file.mimetype || null,
          isLocalFile: true
        });
      });
    }

    const insDoc = db.prepare(
      `INSERT INTO documents (
        title, source_label, stored_filename, original_filename, mime_type,
        is_public, owner_khoa_id, uploaded_by, updated_at, banner_filename
      ) VALUES (?,?,?,?,?,?,?,?, datetime('now'), ?)`
    );

    const insShare = db.prepare(
      'INSERT OR IGNORE INTO document_shares (document_id, khoa_id) VALUES (?,?)'
    );

    for (const docInfo of docsToCreate) {
      const info = insDoc.run(
        docInfo.title,
        source_label.trim(),
        docInfo.storedFilename,
        docInfo.originalFilename,
        docInfo.mimeType,
        pub,
        owner,
        req.user.id,
        bannerFn
      );
      const docId = info.lastInsertRowid;
      
      const shares = parseKhoaIds(req.body);
      for (const k of shares) {
        if (k !== owner) insShare.run(docId, k);
      }
      saveTags(docId, parseTags(req.body));
      
      // Chạy ngầm AI tóm tắt cho từng tệp cục bộ
      if (docInfo.isLocalFile) {
        autoSummarizeInBackground(docId, docInfo.storedFilename, docInfo.originalFilename, docInfo.title);
      }
    }

    res.redirect('/admin/documents');
  }
);

router.get('/documents/:id/edit', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!row) return res.redirect('/admin/documents');
  const doc = documentWithShares(db, row);
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const tags = db.prepare('SELECT DISTINCT tag FROM document_tags ORDER BY tag').all().map(t => t.tag);
  res.render('admin/document-form', {
    title: 'Sửa tài liệu',
    doc,
    departments,
    tags,
    error: null
  });
});

router.post('/documents/:id', uploadFields, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (!row) return res.redirect('/admin/documents');

    const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
    const tags = db.prepare('SELECT DISTINCT tag FROM document_tags ORDER BY tag').all().map(t => t.tag);
    const { title, source_label, is_public, owner_khoa_id, source_type, file_url } = req.body;
    const mainFile = req.files?.file?.[0];
    const bannerFile = req.files?.banner?.[0];

    const isLinkType = source_type === 'link';

    if (!title?.trim() || !source_label?.trim()) {
      if (mainFile) fs.unlinkSync(mainFile.path);
      if (bannerFile) fs.unlinkSync(bannerFile.path);
      const doc = documentWithShares(db, row);
      return res.render('admin/document-form', {
        title: 'Sửa tài liệu',
        doc,
        departments,
        tags,
        error: 'Tiêu đề và nguồn không được để trống.'
      });
    }

    if (isLinkType && !file_url?.trim()) {
      if (mainFile) fs.unlinkSync(mainFile.path);
      if (bannerFile) fs.unlinkSync(bannerFile.path);
      const doc = documentWithShares(db, row);
      return res.render('admin/document-form', {
        title: 'Sửa tài liệu',
        doc,
        departments,
        tags,
        error: 'Cần nhập đường dẫn liên kết (URL).'
      });
    }

    // Nếu chọn kiểu File nhưng lại không upload file mới, và file cũ lại là dạng Link (bắt buộc phải tải file mới)
    const prevIsLink = row.stored_filename.startsWith('http');
    if (!isLinkType && !mainFile && prevIsLink) {
      if (bannerFile) fs.unlinkSync(bannerFile.path);
      const doc = documentWithShares(db, row);
      return res.render('admin/document-form', {
        title: 'Sửa tài liệu',
        doc,
        departments,
        tags,
        error: 'Bạn đã chuyển sang chế độ tải tệp tin, cần chọn file tải lên.'
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
    let bannerFn = row.banner_filename || null;

    if (isLinkType) {
      const newUrl = file_url.trim();
      if (newUrl !== row.stored_filename) {
        // Nếu trước đó là tệp tin cục bộ, xóa tệp tin cục bộ và cache
        if (!prevIsLink) {
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
        }
        stored = newUrl;
        original = newUrl;
        mime = 'text/html';
        clearPdf = true;
      }
    } else if (mainFile) {
      // Nếu trước đó là tệp tin cục bộ, xóa tệp tin cũ
      if (!prevIsLink) {
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
      }
      stored = mainFile.filename;
      original = mainFile.originalname;
      mime = mainFile.mimetype || null;
      clearPdf = true;
    }

    if (bannerFile) {
      if (row.banner_filename) {
        const oldBanner = path.join(UPLOAD_ROOT, row.banner_filename);
        if (fs.existsSync(oldBanner)) fs.unlinkSync(oldBanner);
      }
      bannerFn = bannerFile.filename;
    }

    if (clearPdf) {
      db.prepare(
        `UPDATE documents SET
          title = ?, source_label = ?, stored_filename = ?, original_filename = ?,
          mime_type = ?, is_public = ?, owner_khoa_id = ?, pdf_cache_filename = NULL,
          ai_summary = NULL,
          updated_at = datetime('now'), banner_filename = ?
        WHERE id = ?`
      ).run(title.trim(), source_label.trim(), stored, original, mime, pub, owner, bannerFn, id);
      
      // Chạy ngầm AI tóm tắt lại vì file mới đã được thay thế (chỉ cho file cục bộ)
      if (!isLinkType && mainFile) {
        autoSummarizeInBackground(id, stored, original, title.trim());
      }
    } else {
      db.prepare(
        `UPDATE documents SET
          title = ?, source_label = ?, stored_filename = ?, original_filename = ?,
          mime_type = ?, is_public = ?, owner_khoa_id = ?,
          updated_at = datetime('now'), banner_filename = ?
        WHERE id = ?`
      ).run(title.trim(), source_label.trim(), stored, original, mime, pub, owner, bannerFn, id);
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
