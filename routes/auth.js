const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { setAuthCookie, clearAuthCookie } = require('../middleware/auth');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.user) {
    return res.redirect(req.query.next && req.query.next.startsWith('/') ? req.query.next : '/');
  }
  res.render('login', {
    title: 'Đăng nhập',
    error: null,
    next: req.query.next || ''
  });
});

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const { username, password, next } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username?.trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).render('login', {
      title: 'Đăng nhập',
      error: 'Sai tên đăng nhập hoặc mật khẩu.',
      next: next || ''
    });
  }
  setAuthCookie(res, user.id);
  const redirectTo =
    next && typeof next === 'string' && next.startsWith('/') ? next : '/';
  res.redirect(redirectTo);
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.redirect('/');
});

module.exports = router;
