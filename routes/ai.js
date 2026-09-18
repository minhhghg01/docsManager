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
    return 'API key không hợp lệ. Vui lòng kiểm tra lại cấu hình AI_API_KEY trong file .env và khởi động lại server.';
  }
  if (msg.includes('413') || msg.includes('Request too large') || msg.includes('ITPM')) {
    return 'Dữ liệu tài liệu gửi lên AI vượt quá giới hạn token (413). Hệ thống đã tự động cắt gọn, vui lòng thử lại sau vài giây.';
  }
  if (msg.includes('404') || msg.includes('does not exist or you do not have access')) {
    return 'Model AI không khả dụng trên tài khoản Groq này (404). Chi tiết: ' + msg;
  }
  return 'Lỗi AI: ' + (msg.length > 200 ? msg.slice(0, 200) + '...' : msg);
}

/* ───── POST /api/ai/summarize/:id (Chỉ Admin mới có quyền kích hoạt) ───── */
router.post('/summarize/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Tài liệu không tồn tại.' });

    // Kiểm tra quyền xem tài liệu của người dùng
    const docWithShares = documentWithShares(db, row);
    if (!canViewDocument(req.user, docWithShares)) {
      return res.status(403).json({ error: 'Bạn không có quyền xem tài liệu này.' });
    }

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
    if (!text || text.trim().length < 20) {
      return res.status(400).json({
        error: 'Không trích xuất được đủ nội dung văn bản từ tài liệu này để tóm tắt.'
      });
    }

    // Gọi AI tóm tắt
    const summary = await summarizeDocument(text, row.title);

    // Lưu cache vào DB
    db.prepare('UPDATE documents SET ai_summary = ? WHERE id = ?').run(summary, id);
    if (typeof db.saveSync === 'function') db.saveSync();

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

/* ───── Bộ từ dừng tiếng Việt & Xử lý lọc thông minh ───── */
const VIETNAMESE_STOP_WORDS = new Set([
  'là', 'và', 'của', 'có', 'cho', 'về', 'trong', 'khi', 'với', 'này', 'được', 'ở', 'từ', 'làm',
  'hay', 'hoặc', 'như', 'sao', 'thế', 'nào', 'gì', 'ai', 'tôi', 'bạn', 'em', 'mình', 'chúng',
  'hãy', 'giúp', 'hỏi', 'cách', 'để', 'sử', 'dụng', 'hướng', 'dẫn', 'xin', 'cần', 'muốn',
  'biết', 'thì', 'mà', 'những', 'các', 'một', 'ra', 'vào', 'lại', 'qua', 'lên', 'xuống',
  'điều', 'khoản', 'theo', 'nếu', 'đã', 'đang', 'sẽ', 'chưa', 'rồi', 'không', 'chẳng',
  'rất', 'quá', 'nhiều', 'ít', 'rõ', 'chi', 'tiết', 'xem', 'tìm', 'kiếm', 'tra', 'cứu',
  'văn', 'bản', 'tài', 'liệu', 'file', 'đọc', 'viết', 'nói', 'nghe',
  'nhé', 'ạ', 'vâng', 'dạ', 'ơi', 'như_thế_nào'
]);

/**
 * Phát hiện câu hỏi liên quan đến hướng dẫn thao tác hệ thống / website / điều khiển giọng nói / chào hỏi
 */
function isSystemUsageQuestion(question) {
  const lower = (question || '').toLowerCase();
  const patterns = [
    /sử dụng (web|hệ thống|trang web|phần mềm|ứng dụng|docs)/i,
    /điều khiển (bằng )?giọng nói/i,
    /ra lệnh (bằng )?giọng nói/i,
    /nói để (điều khiển|mở|tìm)/i,
    /giọng nói để/i,
    /voice command/i,
    /nút micro/i,
    /bật micro/i,
    /tắt micro/i,
    /đổi mật khẩu/i,
    /đăng nhập/i,
    /đăng xuất/i,
    /giao diện (tối|sáng)/i,
    /dark mode/i,
    /tải (tài liệu|file)/i,
    /upload (tài liệu|file)/i,
    /hướng dẫn (dùng|sử dụng|thao tác)/i,
    /tính năng (của )?(web|hệ thống)/i,
    /web này (có|làm|dùng)/i,
    /bạn là ai/i,
    /bạn có thể làm gì/i,
    /bạn tên là gì/i,
    /xin chào/i,
    /hello/i,
    /chào bạn/i
  ];
  return patterns.some((p) => p.test(lower));
}

/**
 * Tách các từ khóa có nghĩa từ câu hỏi (bỏ qua từ dừng)
 */
function extractMeaningfulKeywords(text) {
  if (!text) return [];
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !VIETNAMESE_STOP_WORDS.has(w));
  return Array.from(new Set(words));
}

/**
 * Chấm điểm độ liên quan của tài liệu với câu hỏi
 */
function scoreDocument(doc, keywords, fullQuestion, tagMap) {
  const title = (doc.title || '').toLowerCase();
  const sourceLabel = (doc.source_label || '').toLowerCase();
  const tags = (tagMap[doc.id] || []).map((t) => t.toLowerCase());

  let score = 0;

  // Khớp cụm từ nguyên văn trong câu hỏi với tiêu đề
  const cleanQ = fullQuestion.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (cleanQ.length >= 4 && title.includes(cleanQ)) {
    score += 50;
  }

  for (const kw of keywords) {
    const regex = new RegExp(`(?:^|[^\\p{L}\\p{N}])${kw}(?:[^\\p{L}\\p{N}]|$)`, 'u');
    if (regex.test(title)) {
      score += 10;
    }
    if (tags.some((t) => regex.test(t))) {
      score += 6;
    }
    if (regex.test(sourceLabel)) {
      score += 4;
    }
  }

  return score;
}

const BOILERPLATE_PATTERNS = [
  /căn cứ luật/i,
  /căn cứ nghị định/i,
  /căn cứ quyết định/i,
  /căn cứ thông tư/i,
  /xét đề nghị của/i,
  /ban hành kèm theo/i,
  /cộng hòa xã hội chủ nghĩa/i,
  /độc lập - tự do/i,
  /nơi nhận:/i,
  /kính gửi:/i,
  /thay mặt/i,
  /quyết định này có hiệu lực/i,
  /theo quy định tại/i
];

function isBoilerplate(sentence) {
  return BOILERPLATE_PATTERNS.some((p) => p.test(sentence));
}

/**
 * Tìm đoạn trích thực tế từ tài liệu có xuất hiện trực tiếp trong câu trả lời
 */
function findDirectQuoteSnippet(docText, answer) {
  if (!docText || !answer) return '';
  const cleanDoc = docText.replace(/\r\n/g, '\n');
  const cleanDocLower = cleanDoc.toLowerCase();

  const clauses = answer
    .split(/[\n.!?•\-\*:]+/)
    .map((s) => s.replace(/[*#_`]/g, '').trim())
    .filter((s) => s.length >= 18 && s.length <= 200);

  for (const clause of clauses) {
    if (isBoilerplate(clause)) continue;
    const words = clause.split(/\s+/).filter(Boolean);
    for (let len = Math.min(8, words.length); len >= 4; len--) {
      for (let i = 0; i <= words.length - len; i++) {
        const phrase = words.slice(i, i + len).join(' ').replace(/[^\p{L}\p{N}\s]/gu, '').trim();
        if (phrase.length >= 18 && cleanDocLower.includes(phrase.toLowerCase())) {
          const idx = cleanDocLower.indexOf(phrase.toLowerCase());
          return cleanDoc.substring(idx, idx + phrase.length);
        }
      }
    }
  }
  return '';
}

/**
 * Thuật toán quét câu sâu: Chấm điểm từng câu trong tài liệu theo số liệu, tiền tệ, thời hạn và từ khóa
 */
function findBestCitationSentence(docText, question, answer) {
  if (!docText) return '';

  const rawSentences = docText
    .split(/[\r\n]+|(?<=[.?!:])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 300);

  if (rawSentences.length === 0) return '';

  const combinedText = `${question || ''} ${answer || ''}`;
  // Bắt các token đặc biệt: con số, tiền, ngày tháng, phần trăm
  const specialTokens = combinedText.match(/\b\d+(?:[.,/]\d+)*\b%?|\b\d+\s*(?:ngày|tháng|năm|đồng|đ|triệu|nghìn|giờ|tuần|tháng|năm)\b/gi) || [];
  const contentWords = extractMeaningfulKeywords(combinedText);
  const qWords = extractMeaningfulKeywords(question);

  let bestSentence = '';
  let highestScore = -999;

  for (const sentence of rawSentences) {
    if (isBoilerplate(sentence)) continue;

    const lowerSentence = sentence.toLowerCase();
    let score = 0;

    // Con số và thông số kỹ thuật là bằng chứng đắt giá nhất
    for (const st of specialTokens) {
      if (lowerSentence.includes(st.toLowerCase())) {
        score += 25;
      }
    }

    // Từ khóa thực tế xuất hiện trong câu hỏi hoặc câu trả lời
    for (const word of contentWords) {
      const regex = new RegExp(`(?:^|[^\\p{L}\\p{N}])${word}(?:[^\\p{L}\\p{N}]|$)`, 'u');
      if (regex.test(lowerSentence)) {
        score += 6;
      }
    }

    // Ưu tiên câu chứa từ khóa trực tiếp từ câu hỏi người dùng
    for (const qw of qWords) {
      const regex = new RegExp(`(?:^|[^\\p{L}\\p{N}])${qw}(?:[^\\p{L}\\p{N}]|$)`, 'u');
      if (regex.test(lowerSentence)) {
        score += 10;
      }
    }

    if (score > highestScore) {
      highestScore = score;
      bestSentence = sentence;
    }
  }

  if (highestScore >= 16 && bestSentence) {
    return bestSentence.replace(/[#*`_]/g, '').trim();
  }

  return '';
}

/**
 * Trích xuất căn cứ câu trả lời chính xác nhất:
 * 1. Ưu tiên lấy [TRÍCH DẪN: ...] do AI cung cấp
 * 2. Tìm trích dẫn nguyên văn từ AI vào văn bản
 * 3. Chấm điểm câu thông minh theo số liệu và từ khóa cốt lõi
 */
function extractExactCitation(docText, question, answer, explicitQuote) {
  if (!docText) return '';

  if (explicitQuote && explicitQuote.length >= 15) {
    const cleanDoc = docText.toLowerCase().replace(/\s+/g, ' ');
    const cleanQuote = explicitQuote.toLowerCase().replace(/\s+/g, ' ');
    if (cleanDoc.includes(cleanQuote)) {
      return explicitQuote;
    }
    const matched = findBestCitationSentence(docText, explicitQuote, explicitQuote);
    if (matched) return matched;
    return explicitQuote;
  }

  const bestSentence = findBestCitationSentence(docText, question, answer);
  if (bestSentence) return bestSentence;

  const quote = findDirectQuoteSnippet(docText, answer);
  if (quote && !isBoilerplate(quote)) return quote;

  return '';
}

/**
 * Kiểm tra xem AI có thực sự trích dẫn hoặc nhắc đến tài liệu trong câu trả lời không
 */
function isDocCitedInAnswer(answer, doc) {
  if (!answer || !doc) return false;
  const lowerAns = answer.toLowerCase();

  // Kiểm tra ID
  if (lowerAns.includes(`id: ${doc.id}`) || lowerAns.includes(`id:${doc.id}`) || lowerAns.includes(`id ${doc.id}`)) {
    return true;
  }

  // Kiểm tra tiêu đề chính (bỏ phần mở rộng)
  const cleanTitle = doc.title.replace(/\.[a-z0-9]+$/i, '').trim().toLowerCase();
  if (cleanTitle.length >= 6 && lowerAns.includes(cleanTitle)) {
    return true;
  }

  // Kiểm tra các phân đoạn của tiêu đề
  const titleParts = cleanTitle.split(/[-–—:]/).map((p) => p.trim()).filter((p) => p.length >= 8);
  for (const part of titleParts) {
    if (lowerAns.includes(part)) {
      return true;
    }
  }

  return false;
}

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

      const rawAnswer = await chatWithDocs(question, [{ id: doc.id, title: doc.title, text }]);

      let finalAnswer = rawAnswer;
      let aiQuote = '';
      const quoteMatch = rawAnswer.match(/\[TRÍCH DẪN:\s*["“']?(.+?)["”']?\]/i);
      if (quoteMatch) {
        aiQuote = quoteMatch[1].trim();
        finalAnswer = rawAnswer.replace(/\[TRÍCH DẪN:\s*["“']?.+?["”']?\]/gi, '').trim();
      }

      const highlight = extractExactCitation(text, question, finalAnswer, aiQuote);
      return res.json({ answer: finalAnswer, sources: [{ id: doc.id, title: doc.title, highlight }] });
    }

    // Với khung chat toàn cục:
    const isSysQ = isSystemUsageQuestion(question);
    const keywords = extractMeaningfulKeywords(question);

    let docsWithText = [];

    // Chỉ truy vấn tài liệu khi KHÔNG phải câu hỏi thao tác web và có từ khóa nội dung
    if (!isSysQ && keywords.length > 0) {
      const allDocs = db
        .prepare('SELECT id, title, source_label, stored_filename, original_filename FROM documents ORDER BY created_at DESC')
        .all();

      const allTags = db.prepare('SELECT document_id, tag FROM document_tags').all();
      const tagMap = {};
      for (const t of allTags) {
        if (!tagMap[t.document_id]) tagMap[t.document_id] = [];
        tagMap[t.document_id].push(t.tag);
      }

      // Lọc và chỉ giữ các tài liệu đạt ngưỡng điểm tối thiểu (>= 10)
      const scored = allDocs
        .map((doc) => ({
          ...doc,
          score: scoreDocument(doc, keywords, question, tagMap)
        }))
        .filter((d) => d.score >= 10);

      scored.sort((a, b) => b.score - a.score);
      const topDocs = scored.slice(0, 3);

      for (const doc of topDocs) {
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
    }

    // Nếu không có tài liệu nào liên quan (hoặc câu hỏi về thao tác web / chào hỏi):
    // Trả lời bằng hướng dẫn hệ thống, tuyệt đối KHÔNG đính kèm tài liệu rác
    if (docsWithText.length === 0) {
      const answer = await chatWithDocs(question, []);
      return res.json({ answer, sources: [] });
    }

    // Gọi AI trả lời với các tài liệu phù hợp
    const rawAnswer = await chatWithDocs(question, docsWithText);

    let finalAnswer = rawAnswer;
    let aiQuote = '';
    const quoteMatch = rawAnswer.match(/\[TRÍCH DẪN:\s*["“']?(.+?)["”']?\]/i);
    if (quoteMatch) {
      aiQuote = quoteMatch[1].trim();
      finalAnswer = rawAnswer.replace(/\[TRÍCH DẪN:\s*["“']?.+?["”']?\]/gi, '').trim();
    }

    // Hậu kiểm trích dẫn: CHỈ trả về tài liệu thực sự được AI trích dẫn hoặc nhắc đến trong câu trả lời
    const sources = [];
    for (const d of docsWithText) {
      const highlight = extractExactCitation(d.text, question, finalAnswer, aiQuote);
      const isCited = isDocCitedInAnswer(finalAnswer, d) || (highlight && highlight.length >= 20);

      if (isCited) {
        sources.push({
          id: d.id,
          title: d.title,
          highlight: highlight || ''
        });
      }
    }

    return res.json({ answer: finalAnswer, sources });
  } catch (err) {
    console.error('AI chat error:', err.message);
    return res.status(500).json({
      error: friendlyError(err)
    });
  }
});

/* ───── POST /api/ai/tts ───── */
const googleTTS = require('google-tts-api');

router.post('/tts', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Missing text' });
    }
    
    // Thu thập tất cả các chunk âm thanh một lúc để trả về nguyên cục, bảo đảm đọc liền mạch không vấp
    const results = await googleTTS.getAllAudioBase64(text, {
      lang: 'vi',
      slow: false,
      host: 'https://translate.google.com',
      splitPunct: ',.?:',
    });
    
    const audioData = results.map(r => r.base64);
    
    return res.json({ chunks: audioData });
  } catch (err) {
    console.error('TTS error:', err.message);
    return res.status(500).json({ error: 'Không thể tổng hợp giọng nói từ server.' });
  }
});

module.exports = router;
