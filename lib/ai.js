const OpenAI = require('openai');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

/* ───── OpenAI-Compatible Client (Groq, OpenRouter, Local Ollama,...) ───── */
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
 * Gọi API AI chuẩn chung (Groq, OpenRouter, thay vì chỉ Gemini).
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

/* ───── Text extraction ───── */

const WORD_EXTS = new Set(['.doc', '.docx', '.odt']);
const EXCEL_EXTS = new Set(['.xls', '.xlsx', '.ods', '.csv']);

async function extractTextFromWord(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.doc') return '[Định dạng .doc cũ — không trích xuất được text]';
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value || '';
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
 * Trích xuất text từ file tài liệu.
 * @param {string} filePath - đường dẫn tuyệt đối
 * @param {string} originalFilename - tên gốc (để nhận diện extension)
 * @returns {Promise<string>}
 */
async function extractText(filePath, originalFilename) {
  const ext = path.extname(originalFilename).toLowerCase();

  if (WORD_EXTS.has(ext)) return extractTextFromWord(filePath);
  if (EXCEL_EXTS.has(ext)) return extractTextFromExcel(filePath);
  if (ext === '.pdf') return extractTextFromPdf(filePath);

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

Hãy tóm tắt tài liệu sau bằng tiếng Việt trong 3-5 câu ngắn gọn, súc tích.
Tập trung vào ý chính, thông tin quan trọng nhất mà cán bộ cần biết.
Không cần lặp lại tiêu đề. Trả về ĐÚNG NỘI DUNG TÓM TẮT, không cần thêm tiêu đề hay định dạng đặc biệt.

Tiêu đề tài liệu: ${title}

Nội dung:
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
  // Xây dựng context từ các tài liệu
  let context = '';
  for (const doc of docs) {
    const trimmed = doc.text.length > 8000
      ? doc.text.slice(0, 8000) + '\n...(đã cắt bớt)'
      : doc.text;
    context += `\n\n--- TÀI LIỆU [ID: ${doc.id}] "${doc.title}" ---\n${trimmed}`;
  }

  // Giới hạn tổng context
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
