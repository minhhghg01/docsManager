const OpenAI = require('openai');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const WordExtractor = require('word-extractor');
const officeParser = require('officeparser');

/* ───── OpenAI-Compatible Client ───── */
let _ai = null;
let _cachedKey = null;
let _cachedBaseUrl = null;

function getAI() {
  try {
    require('dotenv').config();
  } catch (e) {}

  const key = process.env.AI_API_KEY || 'local';
  const baseURL = process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1';

  if (!_ai || _cachedKey !== key || _cachedBaseUrl !== baseURL) {
    _ai = new OpenAI({ apiKey: key, baseURL });
    _cachedKey = key;
    _cachedBaseUrl = baseURL;
  }
  return _ai;
}

let _availableModelsCache = null;
let _lastFetchTime = 0;

/**
 * Lấy danh sách các model THỰC SỰ ĐANG HOẠT ĐỘNG trên tài khoản Groq này
 */
async function getAvailableGroqModels(ai) {
  const now = Date.now();
  if (_availableModelsCache && _availableModelsCache.length > 0 && now - _lastFetchTime < 300000) {
    return _availableModelsCache;
  }
  try {
    const res = await ai.models.list();
    if (res && res.data && Array.isArray(res.data)) {
      // Lọc các model chat (bỏ qua whisper âm thanh và model thuần vision)
      const ids = res.data
        .map((m) => m.id)
        .filter((id) => id && !id.includes('whisper') && !id.includes('vision') && !id.includes('embed'));
      console.log('[Groq Active Models on Key]:', ids);
      _availableModelsCache = ids;
      _lastFetchTime = now;
      return ids;
    }
  } catch (err) {
    console.warn('[AI Warning] Không thể gọi models.list():', err.message);
  }
  return [];
}

/**
 * Gọi API AI chuẩn chung (Groq, OpenRouter).
 */
async function callOpenAICompatible(prompt) {
  const ai = getAI();
  const available = await getAvailableGroqModels(ai);

  // Danh sách các model chính thức trên Groq (ưu tiên các model thế hệ mới 2026)
  const standard2026Models = [
    process.env.AI_MODEL,
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.8-27b',
    'groq/compound-mini',
    'llama-3.3-70b-versatile'
  ].filter(Boolean);

  let candidateModels = [];

  if (available.length > 0) {
    // Nếu lấy được danh sách động từ Groq: Ưu tiên model người dùng chọn nếu có trong tài khoản
    if (process.env.AI_MODEL && available.includes(process.env.AI_MODEL)) {
      candidateModels.push(process.env.AI_MODEL);
    }
    // Sau đó thêm các model chuẩn 2026 nếu có trong tài khoản
    for (const m of standard2026Models) {
      if (available.includes(m)) candidateModels.push(m);
    }
    // Thêm các model chat còn lại có trong tài khoản
    for (const m of available) {
      candidateModels.push(m);
    }
  } else {
    // Nếu không fetch được danh sách: dùng danh sách chuẩn 2026
    candidateModels = standard2026Models;
  }

  // Loại bỏ trùng lặp và các model đã bị Groq khai tử (mixtral, llama-3.1-8b-instant...)
  const uniqueModels = [...new Set(candidateModels)].filter(
    (m) => m && !m.includes('mixtral') && !m.includes('gemma') && !m.includes('llama-3.1-8b')
  );

  console.log('[AI Info] Danh sách model sẽ thử nghiệm:', uniqueModels);

  let lastError = null;
  for (const model of uniqueModels) {
    try {
      const response = await ai.chat.completions.create({
        model: model,
        messages: [{ role: 'user', content: prompt }],
      });
      return response.choices[0].message.content.trim();
    } catch (err) {
      lastError = err;

      // Nếu gặp lỗi 413 (Request too large / ITPM Limit), tự động thu gọn prompt xuống và thử lại
      if (err.status === 413 || err.message?.includes('Request too large') || err.message?.includes('ITPM')) {
        console.warn(`[AI Warning] Dữ liệu vượt quá giới hạn token (413), tự động thu gọn ngữ cảnh và thử lại với ${model}...`);
        const reducedPrompt = prompt.length > 2500 ? prompt.slice(0, 2500) + '\n...(đã rút gọn ngữ cảnh)' : prompt;
        try {
          const retryRes = await ai.chat.completions.create({
            model: model,
            messages: [{ role: 'user', content: reducedPrompt }],
          });
          return retryRes.choices[0].message.content.trim();
        } catch (retryErr) {
          lastError = retryErr;
        }
      }

      // Nếu model không tồn tại (404) hoặc bị ngừng hỗ trợ (400 decommissioned) → tự động thử model kế tiếp
      const isModelUnavailable =
        err.status === 404 ||
        (err.status === 400 && (err.message?.includes('decommissioned') || err.message?.includes('no longer supported'))) ||
        err.message?.includes('does not exist or you do not have access');

      if (isModelUnavailable) {
        console.warn(`[AI Warning] Model "${model}" không khả dụng (${err.status}), tự động thử model kế tiếp...`);
        if (_availableModelsCache) {
          _availableModelsCache = _availableModelsCache.filter((m) => m !== model);
        }
        continue;
      }

      // Nếu gặp 429 (Rate limit / Quota theo phút)
      if (err.status === 429 || err.message?.includes('Rate limit') || err.message?.includes('TPM')) {
        console.warn(`[AI Warning] Model "${model}" chạm giới hạn rate limit (429), đang thử dự phòng...`);
        // Nếu thông báo yêu cầu chờ ít hơn 5 giây, tự động chờ rồi thử lại
        const waitMatch = err.message?.match(/try again in ([\d\.]+)s/i);
        const waitSec = waitMatch ? parseFloat(waitMatch[1]) : 0;
        if (waitSec > 0 && waitSec <= 5) {
          await new Promise((r) => setTimeout(r, Math.ceil(waitSec * 1000) + 400));
          try {
            const retryRes = await ai.chat.completions.create({
              model: model,
              messages: [{ role: 'user', content: prompt }],
            });
            return retryRes.choices[0].message.content.trim();
          } catch (rErr) {
            lastError = rErr;
          }
        }
        // Chuyển sang model tiếp theo trong danh sách dự phòng
        continue;
      }

      throw lastError;
    }
  }

  if (lastError && (lastError.status === 429 || lastError.message?.includes('Rate limit') || lastError.message?.includes('TPM'))) {
    throw new Error('Dịch vụ AI đang tạm thời chạm hạn mức lượt gọi trong phút này. Vui lòng đợi 5-10 giây rồi thử lại.');
  }

  throw lastError;
}

/* ───── Text extraction: Images & Media (Vision & Whisper) ───── */

/** OCR bằng Vision Model */
async function extractTextFromImage(filePath) {
  const ai = getAI();
  const base64Image = fs.readFileSync(filePath, { encoding: 'base64' });
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;

  try {
    const response = await ai.chat.completions.create({
      model: 'llama-3.2-90b-vision-preview', // Tham số model nhìn ảnh (Groq Vision)
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hãy trích xuất toàn bộ văn bản có trong hình ảnh này. Không bình luận gì thêm, chỉ in ra chính xác các chữ xuất hiện trong hình.' },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
          ],
        }
      ],
      max_tokens: 2000,
    });
    return response.choices[0].message.content.trim();
  } catch (err) {
    console.error('Vision OCR failed:', err.message);
    return '[Không thể nhận dạng chữ trong ảnh. ' + err.message + ']';
  }
}

/** Voice to Text bằng Whisper Model */
async function extractTextFromAudioVideo(filePath) {
  const ai = getAI();
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 25 * 1024 * 1024) {
      return '[File media dung lượng lớn hơn 25MB. API Whisper không nhận, bỏ qua bóc băng.]';
    }

    const transcription = await ai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-large-v3-turbo', 
      language: 'vi'
    });
    
    return transcription.text || '[Không nghe thấy tiếng/văn bản]';
  } catch (err) {
    console.error('Whisper Transcription failed:', err.message);
    return '[Lỗi trích xuất giọng nói audio/video: ' + err.message + ']';
  }
}

/* ───── Text extraction: Documents ───── */

const WORD_EXTS = new Set(['.docx', '.odt']);
const EXCEL_EXTS = new Set(['.xls', '.xlsx', '.ods', '.csv']);
const PPT_EXTS = new Set(['.ppt', '.pptx']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MEDIA_EXTS = new Set(['.mp3', '.mp4', '.wav', '.m4a', '.webm']);
const PLAIN_TEXT_EXTS = new Set(['.txt', '.md', '.log']);

async function extractTextFromWord(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value || '';
}

async function extractTextFromOldDoc(filePath) {
  try {
    const extractor = new WordExtractor();
    const extracted = await extractor.extract(filePath);
    return extracted.getBody();
  } catch (e) {
    console.error('Error reading .doc', e);
    return '[Lỗi hệ thống khi phân tích file .doc cũ]';
  }
}

async function extractTextFromPPT(filePath) {
  return new Promise((resolve) => {
    officeParser.parseOffice(filePath, function(data, err) {
      if (err) {
        console.error('officeParser error:', err);
        return resolve('[Lỗi phân tích file trình chiếu PowerPoint]');
      }
      resolve(data || '');
    });
  });
}

function extractTextFromExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const texts = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(ws);
    if (csv.trim()) {
      texts.push(`[Sheet: ${name}]\n${csv}`);
    }
  }
  return texts.join('\n\n');
}

async function extractTextFromPdf(filePath) {
  const { PDFParse } = require('pdf-parse');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const parser = new PDFParse({ verbosity: 0, data });
  await parser.load();
  const result = await parser.getText();
  parser.destroy();
  return result.text || '';
}

/**
 * Trích xuất text từ file tài liệu (Siêu cảm quan: nhận dạng mọi loại định dạng).
 * @param {string} filePath - đường dẫn tuyệt đối
 * @param {string} originalFilename - tên gốc (để nhận diện extension)
 * @returns {Promise<string>}
 */
async function extractText(filePath, originalFilename) {
  const ext = path.extname(originalFilename).toLowerCase();

  // Text thuần
  if (PLAIN_TEXT_EXTS.has(ext)) {
    return fs.readFileSync(filePath, 'utf8');
  }

  // Tài liệu Office / PDF
  if (WORD_EXTS.has(ext)) return extractTextFromWord(filePath);
  if (ext === '.doc') return extractTextFromOldDoc(filePath);
  if (EXCEL_EXTS.has(ext)) return extractTextFromExcel(filePath);
  if (PPT_EXTS.has(ext)) return extractTextFromPPT(filePath);
  if (ext === '.pdf') return extractTextFromPdf(filePath);

  // Nhúng mô hình Mắt (Thị giác) và Tai (Âm thanh Whisper)
  if (IMAGE_EXTS.has(ext)) return extractTextFromImage(filePath);
  if (MEDIA_EXTS.has(ext)) return extractTextFromAudioVideo(filePath);

  return '';
}

/* ───── AI: Tóm tắt tài liệu ───── */

/**
 * Gọi AI để tóm tắt nội dung tài liệu.
 * @param {string} text - nội dung text của tài liệu
 * @param {string} title - tiêu đề tài liệu
 * @returns {Promise<string>} bản tóm tắt súc tích, chuyên nghiệp
 */
async function summarizeDocument(text, title) {
  // Giới hạn text gửi lên (~3k ký tự ~750 tokens) để không vượt ITPM limit (7000) của Groq
  const trimmed = text.length > 3000 ? text.slice(0, 3000) + '\n...(đã cắt bớt)' : text;

  const prompt = `Bạn là Trợ lý AI chuyên trách phân tích và tóm tắt văn bản của hệ thống Quản lý Tài liệu Nội bộ.

Nhiệm vụ: Hãy tóm tắt tài liệu dưới đây bằng tiếng Việt một cách cô đọng, súc tích, nêu bật các thông tin quan trọng nhất mà cán bộ/nhân viên cần nắm bắt.

YÊU CẦU TRÌNH BÀY:
- Độ dài khoảng 3 - 5 câu hoặc gạch đầu dòng rõ ràng.
- Nêu rõ: Mục đích chính, các nội dung trọng tâm và điều khoản/hành động quan trọng cần lưu ý.
- Văn phong chuẩn mực, chuyên nghiệp, rõ nghĩa.
- Không cần lặp lại tiêu đề văn bản ở đầu.

Tiêu đề tài liệu: ${title}

Nội dung trích xuất:
${trimmed}`;

  return callOpenAICompatible(prompt);
}

/**
 * Trích xuất ngữ cảnh thông minh dựa trên câu hỏi người dùng:
 * Quét toàn bộ tài liệu (kể cả file dài hàng chục trang hoặc bảng Excel lớn),
 * ưu tiên cụm từ nguyên văn (n-grams), thông số kỹ thuật và các điều khoản liên quan,
 * giữ trọn vẹn cả tiêu đề điều khoản lẫn các điểm chi tiết (a, b, c...) mà không bị cắt xén.
 */
function extractRelevantContext(docText, question, maxChars = 6500) {
  if (!docText) return '';
  const cleanDoc = docText.replace(/\r\n/g, '\n');
  if (cleanDoc.length <= maxChars) return cleanDoc;

  const lines = cleanDoc.split('\n');

  // Lọc từ dừng tiếng Việt
  const stopWords = new Set([
    'là', 'và', 'của', 'có', 'cho', 'về', 'trong', 'khi', 'với', 'này', 'được', 'ở', 'từ', 'làm',
    'hay', 'hoặc', 'như', 'sao', 'thế', 'nào', 'gì', 'ai', 'tôi', 'bạn', 'em', 'mình', 'chúng',
    'hãy', 'giúp', 'hỏi', 'cách', 'để', 'sử', 'dụng', 'hướng', 'dẫn', 'xin', 'cần', 'muốn',
    'biết', 'thì', 'mà', 'những', 'các', 'một', 'ra', 'vào', 'lại', 'qua', 'lên', 'xuống',
    'theo', 'nếu', 'đã', 'đang', 'sẽ', 'chưa', 'rồi', 'không', 'chẳng',
    'rất', 'quá', 'nhiều', 'ít', 'rõ', 'chi', 'tiết', 'xem', 'tìm', 'kiếm', 'tra', 'cứu'
  ]);

  const cleanQ = (question || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const wordsInQ = cleanQ.split(' ').filter(Boolean);
  const qWords = wordsInQ.filter((w) => w.length >= 2 && !stopWords.has(w));
  const uniqueKeywords = [...new Set(qWords)];

  // Tạo các cụm 2 - 4 từ liên tiếp từ câu hỏi (ngrams)
  const phrases = [];
  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i <= wordsInQ.length - len; i++) {
      const phrase = wordsInQ.slice(i, i + len).join(' ');
      if (phrase.length >= 4) {
        phrases.push(phrase);
      }
    }
  }

  // Nhận diện các con số / thông số kỹ thuật đặc thù trong câu hỏi (ví dụ: 15 cm, 15cm, 30cm, 50%, 80%)
  const rawQ = question || '';
  const specTokens = rawQ.match(/\b\d+(?:[.,]\d+)?\s*(?:cm|mm|m|g|kg|l|ml|%|đ|đồng|nghìn|triệu)?\b/gi) || [];

  // Chấm điểm từng dòng
  const scoredLines = lines.map((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return { idx, score: -1, line };

    const lower = trimmed.toLowerCase();
    let score = 0;

    // Khớp cụm từ nhiều chữ (rất quan trọng: "thay băng vết thương", "vết mổ chiều dài", "15 cm"...)
    for (const ph of phrases) {
      if (lower.includes(ph)) {
        score += ph.split(' ').length >= 3 ? 90 : 45;
      }
    }

    // Khớp con số / thông số kỹ thuật từ câu hỏi
    for (const st of specTokens) {
      const stClean = st.toLowerCase().trim();
      if (stClean.length >= 2 && lower.includes(stClean)) {
        score += 40;
      }
    }

    // Khớp từ khóa đơn lẻ
    let matchCount = 0;
    for (const kw of uniqueKeywords) {
      if (lower.includes(kw)) {
        score += 8;
        matchCount++;
      }
    }

    // Thưởng cho mật độ từ khóa cao trong cùng một dòng
    if (matchCount >= 3) score += 30;
    if (matchCount >= 5) score += 50;

    // Nhận diện dòng tiêu đề điều khoản (ví dụ: Điều 4d, 3. Đối với dịch vụ..., Mục II...)
    const isHeading = /^(?:điều\s+\d+|khoản\s+\d+|\d+\.\s+đối với|\d+\.\s+dịch vụ|chương\s+[ivxlcdm]+|phụ lục)/i.test(trimmed);
    if (isHeading && score > 0) {
      score += 40;
    }

    // Giảm điểm các dòng thủ tục hành chính mở đầu (boilerplate)
    if (/^(?:cộng hòa xã hội|độc lập - tự do|căn cứ luật|căn cứ nghị định|nơi nhận:|kính gửi:)/i.test(trimmed)) {
      score = Math.min(score, 5);
    }

    return { idx, score, line };
  });

  const matched = scoredLines.filter((item) => item.score > 0);
  if (matched.length === 0) {
    return cleanDoc.slice(0, maxChars) + '\n...(đã rút gọn)';
  }

  // Sắp xếp các dòng khớp theo điểm số GIẢM DẦN (khối chuẩn nhất được ưu tiên hàng đầu)
  matched.sort((a, b) => b.score - a.score);

  // Chọn các khối ngữ cảnh tốt nhất theo ngân sách maxChars
  const selectedIndices = new Set();

  // Giữ lại 2 dòng đầu văn bản (tiêu đề văn bản)
  for (let i = 0; i < Math.min(2, lines.length); i++) {
    selectedIndices.add(i);
  }

  let totalChars = 0;
  for (const idx of selectedIndices) {
    totalChars += lines[idx].length + 1;
  }

  for (const m of matched) {
    // Mở rộng ngữ cảnh xung quanh dòng khớp: 3 dòng trước (để lấy tiêu đề điều khoản) và 6 dòng sau (để lấy trọn vẹn điểm a, b, c...)
    const start = Math.max(0, m.idx - 3);
    const end = Math.min(lines.length - 1, m.idx + 6);

    let newChars = 0;
    for (let i = start; i <= end; i++) {
      if (!selectedIndices.has(i)) {
        newChars += lines[i].length + 1;
      }
    }

    if (totalChars + newChars <= maxChars) {
      for (let i = start; i <= end; i++) {
        selectedIndices.add(i);
      }
      totalChars += newChars;
    } else if (selectedIndices.size <= 2) {
      // Nếu là khối quan trọng nhất mà vượt ngân sách, nạp từng dòng cho đến khi vừa khít maxChars
      for (let i = start; i <= end; i++) {
        if (!selectedIndices.has(i)) {
          if (totalChars + lines[i].length + 1 > maxChars) break;
          selectedIndices.add(i);
          totalChars += lines[i].length + 1;
        }
      }
      break;
    }
  }

  // Sắp xếp lại các dòng ĐÃ ĐƯỢC CHỌN theo đúng thứ tự tự nhiên trong văn bản
  const sorted = Array.from(selectedIndices).sort((a, b) => a - b);
  let result = '';
  let lastIdx = -1;

  for (const idx of sorted) {
    if (lastIdx !== -1 && idx > lastIdx + 1) {
      result += '\n...\n';
    }
    result += lines[idx] + '\n';
    lastIdx = idx;
  }

  return result.trim();
}

/* ───── AI: Chat hỏi đáp & Hướng dẫn sử dụng ───── */

/**
 * Hỏi đáp AI dựa trên nội dung tài liệu và hướng dẫn sử dụng hệ thống Docs Manager.
 * @param {string} question - câu hỏi của người dùng
 * @param {Array<{id:number, title:string, text:string}>} docs - danh sách tài liệu context (có thể rỗng)
 * @returns {Promise<string>} câu trả lời
 */
async function chatWithDocs(question, docs) {
  let context = '';
  if (docs && docs.length > 0) {
    // Rút gọn ngân sách context để luôn nằm an toàn dưới giới hạn 6.000 TPM của Groq
    // docs.length === 1 -> 3200 ký tự (chứa trọn vẹn cả Điều 4d và các tiểu mục a, b)
    // docs.length > 1 -> 1600 ký tự mỗi tài liệu, tổng ngữ cảnh tối đa 3500 ký tự
    const perDocChars = docs.length === 1 ? 3200 : 1600;

    for (const doc of docs) {
      const relevantText = extractRelevantContext(doc.text, question, perDocChars);
      context += `\n\n--- TÀI LIỆU NỘI BỘ [ID: ${doc.id}] "${doc.title}" ---\n${relevantText}`;
    }

    if (context.length > 3600) {
      context = context.slice(0, 3600) + '\n...(đã rút gọn)';
    }
  }

  const systemKnowledge = `
BẠN LÀ TRỢ LÝ AI CHUYÊN NGHIỆP CỦA HỆ THỐNG: "Docs Manager — Quản lý Tài liệu Nội bộ".

QUY TẮC TRẢ LỜI QUAN TRỌNG:
1. TRẢ LỜI TRỰC DIỆN, NGẮN GỌN, ĐÚNG NỘI DUNG VĂN BẢN:
- Đi thẳng vào câu trả lời ngay từ câu đầu tiên. TUYỆT ĐỐI KHÔNG mở bài dài dòng, không chào hỏi lê thê ("Chào bạn...", "Dựa trên tài liệu...").
- ĐỐI VỚI CÂU HỎI VỀ MỨC THANH TOÁN, ĐIỀU KIỆN, CHI PHÍ, GIÁ DỊCH VỤ, QUY ĐỊNH KỸ THUẬT:
  + Hãy đọc kỹ các điều khoản trong văn bản. Nếu tài liệu quy định ĐIỀU KIỆN ÁP DỤNG, CÁC TRƯỜNG HỢP ĐƯỢC THANH TOÁN, TRƯỜNG HỢP KHÔNG ĐƯỢC ÁP DỤNG, TỶ LỆ THANH TOÁN HOẶC MỨC GIÁ: Hãy trình bày ĐẦY ĐỦ, RÕ RÀNG VÀ CHÍNH XÁC các trường hợp và điều kiện đó (dùng gạch đầu dòng ngắn gọn, súc tích).
  + TUYỆT ĐỐI KHÔNG từ chối trả lời nếu trong văn bản đã có quy định về điều kiện, mức thanh toán cho dịch vụ đó!
- Trả lời cô đọng, rõ ràng, gạch đầu dòng rõ các ý chính.

2. CĂN CỨ TRÍCH DẪN (BẮT BUỘC KHI CÓ THÔNG TIN TRONG TÀI LIỆU):
- Ở cuối câu trả lời, hãy đính kèm nguyên văn 1 câu/đoạn trích dẫn cốt lõi nhất từ tài liệu làm bằng chứng:
[TRÍCH DẪN: "nguyên văn câu mấu chốt chứa quy định/điều kiện thanh toán trong tài liệu"]
- Chỉ trích dẫn đúng câu trực tiếp giải đáp câu hỏi, tuyệt đối không trích dẫn phần căn cứ pháp lý chung chung ở đầu văn bản.

3. KHI KHÔNG CÓ TÀI LIỆU HOẶC CÂU HỎI THAO TÁC WEB:
- Nếu hỏi về cách dùng web (giọng nói, tìm kiếm, tải tài liệu, đổi mật khẩu...): Hướng dẫn nhanh gọn theo các bước 1, 2, 3.
- Nếu các tài liệu được cung cấp hoàn toàn không nhắc đến nội dung được hỏi: Nêu ngắn gọn là không tìm thấy thông tin trong các tài liệu hiện có, và gợi ý từ khóa tìm kiếm.
`;

  const prompt = `${systemKnowledge}

${context ? `CÁC TÀI LIỆU NỘI BỘ LIÊN QUAN TRONG HỆ THỐNG:\n${context}\n` : 'HIỆN TẠI KHÔNG CÓ TÀI LIỆU NỘI BỘ NÀO CỤ THỂ ĐÍNH KÈM CHO CÂU HỎI NÀY (HÃY HƯỚNG DẪN HOẶC TRẢ LỜI BẰNG KIẾN THỨC CHUYÊN MÔN/THAO TÁC HỆ THỐNG).\n'}

CÂU HỎI CỦA NGƯỜI DÙNG:
${question}

HÃY TRẢ LỜI NGẮN GỌN, ĐÚNG TRỌNG TÂM, ĐẦY ĐỦ THÔNG TIN CỐT LÕI:`;

  return callOpenAICompatible(prompt);
}

module.exports = {
  extractText,
  summarizeDocument,
  chatWithDocs,
};
