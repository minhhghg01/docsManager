const OpenAI = require('openai');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const WordExtractor = require('word-extractor');
const officeParser = require('officeparser');

/* ───── OpenAI-Compatible Client ───── */
let _ai = null;

function getAI() {
  if (_ai) return _ai;
  const key = process.env.AI_API_KEY || 'local';
  
  _ai = new OpenAI({ 
    apiKey: key,
    baseURL: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
  });
  return _ai;
}

/**
 * Gọi API AI chuẩn chung (Groq, OpenRouter).
 */
async function callOpenAICompatible(prompt) {
  const ai = getAI();
  const modelToUse = process.env.AI_MODEL || 'llama-3.3-70b-versatile';
  
  try {
    const response = await ai.chat.completions.create({
      model: modelToUse,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.choices[0].message.content.trim();
  } catch (err) {
    if (err.status === 429) {
      throw new Error('Đã hết hạn mức (Quota) của dịch vụ AI hiện tại, vui lòng thử lại sau vài phút hoặc cung cấp thêm key.');
    }
    throw err;
  }
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
 * @returns {Promise<string>} bản tóm tắt 3-5 câu
 */
async function summarizeDocument(text, title) {
  // Giới hạn text gửi lên (~30k ký tự) để tránh vượt token limit
  const trimmed = text.length > 30000 ? text.slice(0, 30000) + '\n...(đã cắt bớt)' : text;

  const prompt = `Bạn là trợ lý AI chuyên tóm tắt tài liệu cho hệ thống quản lý tài liệu nội bộ của một bệnh viện/cơ quan.

Hãy tóm tắt tài liệu (hoặc hình ảnh/video transcript) sau bằng tiếng Việt trong 3-5 câu ngắn gọn, súc tích.
Tập trung vào ý chính, thông tin quan trọng nhất mà cán bộ cần biết.
Không cần lặp lại tiêu đề. Trả về ĐÚNG NỘI DUNG TÓM TẮT, không cần thêm tiêu đề hay định dạng đặc biệt.

Tiêu đề tài liệu: ${title}

Nội dung trích xuất:
${trimmed}`;

  return callOpenAICompatible(prompt);
}

/* ───── AI: Chat hỏi đáp ───── */

/**
 * Hỏi đáp AI dựa trên nội dung tài liệu.
 * @param {string} question - câu hỏi của người dùng
 * @param {Array<{id:number, title:string, text:string}>} docs - danh sách tài liệu context
 * @returns {Promise<string>} câu trả lời
 */
async function chatWithDocs(question, docs) {
  let context = '';
  for (const doc of docs) {
    const trimmed = doc.text.length > 8000
      ? doc.text.slice(0, 8000) + '\n...(đã cắt bớt)'
      : doc.text;
    context += `\n\n--- TÀI LIỆU [ID: ${doc.id}] "${doc.title}" ---\n${trimmed}`;
  }

  if (context.length > 50000) {
    context = context.slice(0, 50000) + '\n...(đã cắt bớt)';
  }

  const prompt = `Bạn là trợ lý AI thông minh của hệ thống quản lý tài liệu nội bộ.
Nhiệm vụ: trả lời câu hỏi của cán bộ dựa trên nội dung các tài liệu được cung cấp bên dưới.

QUY TẮC:
1. Trả lời bằng tiếng Việt, ngắn gọn, chính xác.
2. Khi trích dẫn thông tin, ghi rõ nguồn bằng cách ghi [Tài liệu: "tên tài liệu" (ID: số)].
3. Nếu không tìm thấy thông tin liên quan trong tài liệu, hãy nói rõ "Không tìm thấy thông tin liên quan trong các tài liệu hiện có."
4. Không bịa thông tin ngoài nội dung tài liệu.
5. Trả lời ở dạng plain text, có thể dùng dấu xuống dòng. Không dùng markdown.

CÁC TÀI LIỆU:
${context}

CÂU HỎI: ${question}`;

  return callOpenAICompatible(prompt);
}

module.exports = {
  extractText,
  summarizeDocument,
  chatWithDocs,
};
