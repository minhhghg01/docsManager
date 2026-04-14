const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { extractText, summarizeDocument, chatWithDocs } = require('../lib/ai');
const { canViewDocument, documentWithShares } = require('../lib/access');

const router = express.Router();
// Bỏ giới hạn admin toàn Router để mọi user đăng nhập đều được chat AI
// Nếu hệ thống chỉ định user đăng nhập mới vào phần này, ta đã chặn ngoài server.js


const UPLOAD_ROOT = path.join(__dirname, '..', 'public', 'uploads');

/**
 * Chuyển lỗi API thành message thân thiện
 */
function friendlyError(err) {
  const msg = err.message || '';
  if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
    return 'Dịch vụ AI đã hết hạn mức (quota). Vui lòng đợi vài phút hoặc nạp thêm giới hạn.';
  }
  if (msg.includes('503') || msg.includes('UNAVAILABLE')) {
    return 'Máy chủ AI đang quá tải. Vui lòng thử lại sau vài giây.';
  }
  if (msg.includes('401') || msg.includes('UNAUTHENTICATED')) {
    return 'API key không hợp lệ. Vui lòng kiểm tra lại cấu hình AI_API_KEY trong file .env.';
  }
  return 'Lỗi AI: ' + (msg.length > 200 ? msg.slice(0, 200) + '...' : msg);
}

/* ───── POST /api/ai/summarize/:id ───── */
router.post('/summarize/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Tài liệu không tồn tại.' });

    // Nếu đã có tóm tắt cached → trả về ngay
    if (row.ai_summary) {
      return res.json({ summary: row.ai_summary, cached: true });
    }

    // Trích xuất text
    const filePath = path.join(UPLOAD_ROOT, row.stored_filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File không còn trên máy chủ.' });
    }

    const text = await extractText(filePath, row.original_filename);
    if (!text || text.trim().length < 50) {
      return res.status(400).json({
        error: 'Không trích xuất được nội dung đủ dài từ tài liệu này.'
      });
    }

    // Gọi Gemini tóm tắt
    const summary = await summarizeDocument(text, row.title);

    // Lưu cache vào DB
    db.prepare('UPDATE documents SET ai_summary = ? WHERE id = ?').run(summary, id);

    return res.json({ summary, cached: false });
  } catch (err) {
    console.error('AI summarize error:', err.message);
    return res.status(500).json({
      error: friendlyError(err)
    });
  }
});

/* ───── DELETE /api/ai/summarize/:id ───── */
router.delete('/summarize/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('UPDATE documents SET ai_summary = NULL WHERE id = ?').run(id);
  res.json({ ok: true });
});

/* ───── POST /api/ai/chat ───── */
router.post('/chat', async (req, res) => {
  try {
    const { question, docId } = req.body;
    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'Vui lòng nhập câu hỏi.' });
    }

    // Nếu hỏi trực tiếp một tài liệu cụ thể (NotebookLM style)
    if (docId) {
      const doc = db.prepare('SELECT id, title, source_label, stored_filename, original_filename FROM documents WHERE id = ?').get(docId);
      if (!doc) return res.status(404).json({ error: 'Tài liệu không tồn tại' });
      
      const filePath = path.join(UPLOAD_ROOT, doc.stored_filename);
      if (!fs.existsSync(filePath)) {
        return res.json({ answer: 'Không tìm thấy nội dung file văn bản thực tế để trả lời.', sources: [] });
      }
      const text = await extractText(filePath, doc.original_filename);
      if (!text || text.trim().length < 20) {
        return res.json({ answer: 'Tài liệu này không có chữ hoặc quá ngắn.', sources: [] });
      }

      const answer = await chatWithDocs(question, [{ id: doc.id, title: doc.title, text }]);
      return res.json({ answer, sources: [{ id: doc.id, title: doc.title }] });
    }


    // Tìm tài liệu liên quan bằng keyword matching
    const keywords = question
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .filter((w) => w.length >= 2);

    // Lấy tất cả tài liệu (admin có quyền xem hết)
    const allDocs = db
      .prepare('SELECT id, title, source_label, stored_filename, original_filename FROM documents ORDER BY created_at DESC')
      .all();

    // Lấy tags cho mỗi tài liệu
    const allTags = db.prepare('SELECT document_id, tag FROM document_tags').all();
    const tagMap = {};
    for (const t of allTags) {
      if (!tagMap[t.document_id]) tagMap[t.document_id] = [];
      tagMap[t.document_id].push(t.tag);
    }

    // Scoring: đếm số keyword match trong title + source_label + tags
    const scored = allDocs.map((doc) => {
      const searchText = [
        doc.title,
        doc.source_label,
        ...(tagMap[doc.id] || [])
      ]
        .join(' ')
        .toLowerCase();

      let score = 0;
      for (const kw of keywords) {
        if (searchText.includes(kw)) score++;
      }
      return { ...doc, score };
    });

    // Sắp xếp theo score giảm dần, lấy top 5
    scored.sort((a, b) => b.score - a.score);
    const topDocs = scored.slice(0, 5);

    // Nếu không keyword nào match → vẫn lấy 3 tài liệu mới nhất làm context
    const contextDocs =
      topDocs[0]?.score > 0
        ? topDocs.filter((d) => d.score > 0)
        : allDocs.slice(0, 3);

    // Trích xuất text từ các tài liệu context
    const docsWithText = [];
    for (const doc of contextDocs.slice(0, 5)) {
      const filePath = path.join(UPLOAD_ROOT, doc.stored_filename);
      if (!fs.existsSync(filePath)) continue;
      try {
        const text = await extractText(filePath, doc.original_filename);
        if (text && text.trim().length > 20) {
          docsWithText.push({ id: doc.id, title: doc.title, text });
        }
      } catch {
        // Bỏ qua file lỗi
      }
    }

    if (docsWithText.length === 0) {
      return res.json({
        answer: 'Không tìm thấy tài liệu nào có nội dung phù hợp để trả lời câu hỏi.',
        sources: []
      });
    }

    // Gọi Gemini
    const answer = await chatWithDocs(question, docsWithText);

    // Trả về kèm danh sách tài liệu nguồn
    const sources = docsWithText.map((d) => ({ id: d.id, title: d.title }));

    return res.json({ answer, sources });
  } catch (err) {
    console.error('AI chat error:', err.message);
    return res.status(500).json({
      error: friendlyError(err)
    });
  }
});

module.exports = router;
