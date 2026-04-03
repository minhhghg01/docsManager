const jwt = require('jsonwebtoken');
const db = require('../db');

const COOKIE_NAME = 'auth_token';

function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Thiếu JWT_SECRET trong .env');
  }
  return 'dev-only-khong-dung-cho-production';
}

function signToken(payload) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '480m' });
}

function optionalAuth(req, res, next) {
  req.user = null;
  const token = req.cookies[COOKIE_NAME];
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.role, u.khoa_id, d.name AS khoa_name
         FROM users u
         LEFT JOIN departments d ON d.id = u.khoa_id
         WHERE u.id = ?`
      )
      .get(decoded.sub);
    if (row) req.user = row;
  } catch {
    res.clearCookie(COOKIE_NAME);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.accepts('html')) {
      return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    }
    return res.status(401).json({ error: 'Cần đăng nhập' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    if (req.accepts('html')) {
      return res.status(403).render('error', {
        title: 'Không có quyền',
        message: 'Chỉ quản trị viên được truy cập.'
      });
    }
    return res.status(403).json({ error: 'Không có quyền' });
  }
  next();
}

function setAuthCookie(res, userId) {
  const token = signToken({ sub: userId });
  const maxAgeMs = 480 * 60 * 1000;
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: maxAgeMs,
    secure: process.env.NODE_ENV === 'production'
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

module.exports = {
  COOKIE_NAME,
  optionalAuth,
  requireAuth,
  requireAdmin,
  setAuthCookie,
  clearAuthCookie,
  signToken
};
