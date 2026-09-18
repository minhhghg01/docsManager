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
  const key = process.env.AI_API_KEY || 'local';
  const baseURL = process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1';

  if (!_ai || _cachedKey !== key || _cachedBaseUrl !== baseURL) {
    _ai = new OpenAI({ apiKey: key, baseURL });
    _cachedKey = key;
    _cachedBaseUrl = baseURL;
  }
  return _ai;
}

/**
 * Gọi API AI chuẩn chung (Groq, OpenRouter).
 */
async function callOpenAICompatible(prompt) {
  const ai = getAI();
  const preferredModel = process.env.AI_MODEL || 'qwen/qwen3.8-27b';

  // Danh sách các model tương thích khả dụng trên Groq (tự động thử lần lượt)
  const modelsToTry = [
    preferredModel,
    'llama-3.1-8b-instant',
    'qwen/qwen3.8-27b',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'groq/compound-mini',
    'allam-2-7b'
  ];
  const uniqueModels = [...new Set(modelsToTry)];

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
        const reducedPrompt = prompt.length > 3500 ? prompt.slice(0, 3500) + '\n...(đã rút gọn ngữ cảnh)' : prompt;
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

      // Nếu model không tồn tại (404) → tự động thử model kế tiếp
      if (err.status === 404 || err.message?.includes('does not exist or you do not have access')) {
        console.warn(`[AI Warning] Model "${model}" không khả dụng (404), tự động thử model kế tiếp...`);
        continue;
      }

      // Nếu gặp 429 (Rate limit / Quota theo phút)
      if (err.status === 429 || err.message?.includes('Rate limit') || err.message?.includes('TPM')) {
        console.warn(`[AI Warning] Model "${model}" chạm giới hạn rate limit (429), đang thử dự phòng...`);
        // Nếu thông báo yêu cầu chờ ít hơn 3 giây, tự động chờ rồi thử lại
        const waitMatch = err.message?.match(/try again in ([\d\.]+)s/i);
        const waitSec = waitMatch ? parseFloat(waitMatch[1]) : 0;
        if (waitSec > 0 && waitSec <= 3) {
          await new Promise(r => setTimeout(r, Math.ceil(waitSec * 1000) + 300));
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
    throw new Error('Đã tạm thời chạm hạn mức lượt gọi của nhà cung cấp AI trong phút này. Vui lòng đợi 5-10 giây rồi thử lại.');
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
    for (const doc of docs) {
      const trimmed = doc.text.length > 1200
        ? doc.text.slice(0, 1200) + '\n...(đã cắt bớt)'
        : doc.text;
      context += `\n\n--- TÀI LIỆU NỘI BỘ [ID: ${doc.id}] "${doc.title}" ---\n${trimmed}`;
    }

    // Giới hạn toàn bộ context tối đa 3000 ký tự (~750 tokens) để bảo đảm không chạm trần TPM
    if (context.length > 3000) {
      context = context.slice(0, 3000) + '\n...(đã cắt bớt)';
    }
  }

  const systemKnowledge = `
BẠN LÀ TRỢ LÝ AI ĐẮC LỰC CỦA HỆ THỐNG: "Docs Manager — Quản lý Tài liệu Nội bộ".
Phong cách của bạn: Nhiệt tình, thân thiện, thông minh, ân cần và chuyên nghiệp. Xưng "tôi" (hoặc "em"), gọi người dùng là "bạn" (hoặc "anh/chị", "quý cán bộ").
Trình bày: Sử dụng Markdown sinh động, dùng **in đậm** để làm nổi bật từ khóa/nút bấm, dùng gạch đầu dòng (-) hoặc đánh số (1, 2, 3) cho các bước, kèm emoji phù hợp.

BẠN CÓ 2 NĂNG LỰC CỐT LÕI:

1. TRẢ LỜI & TRA CỨU TÀI LIỆU NỘI BỘ:
- Khi câu hỏi liên quan đến tài liệu có trong phần "TÀI LIỆU NỘI BỘ", hãy phân tích cặn kẽ, giải thích rõ ràng và trích dẫn nguồn: [Tài liệu: "tên tài liệu" (ID: số)].
- YÊU CẦU CĂN CỨ TRÍCH DẪN: Ở cuối câu trả lời, hãy kèm theo một dòng riêng biệt ghi câu văn nguyên văn từ tài liệu làm bằng chứng trả lời:
[TRÍCH DẪN: "chép lại nguyên văn câu văn quan trọng nhất trong tài liệu chứa thông tin trực tiếp giải đáp câu hỏi"]
(Ví dụ: [TRÍCH DẪN: "Mức tạm ứng viện phí đối với người bệnh điều trị nội trú là 2.000.000 đồng"])
Lưu ý: Chỉ trích dẫn đúng câu chứa số liệu/nội dung mấu chốt giải đáp câu hỏi, tuyệt đối không trích dẫn lời mở đầu, căn cứ văn bản hay điều khoản chung chung.
- Nếu câu hỏi KHÔNG liên quan đến các tài liệu nội bộ (ví dụ hỏi về cách dùng web, giọng nói, chào hỏi...): TUYỆT ĐỐI KHÔNG trích dẫn hoặc nhắc đến tên các tài liệu đó. Hãy trả lời thẳng vào nội dung câu hỏi của người dùng.
- Nếu câu hỏi không có trong tài liệu nội bộ: ĐỪNG TỪ CHỐI CỤT LỦN. Hãy giải đáp bằng kiến thức tổng quát hữu ích (ghi chú nhẹ rằng đây là thông tin tham khảo ngoài kho tài liệu lưu trữ), đồng thời gợi ý từ khóa phù hợp để người dùng tìm kiếm thêm trong hệ thống.
- Với các câu hỏi chào hỏi, hỏi thăm hoặc hỏi chung: Hãy niềm nở chào đón, tự giới thiệu và sẵn lòng hỗ trợ.

2. HƯỚNG DẪN THAO TÁC SỬ DỤNG HỆ THỐNG WEBSITE "DOCS MANAGER":
Bạn nắm rõ 100% tính năng của website để chỉ dẫn người dùng từng bước:
- 🔍 **Tìm kiếm tài liệu**: Nhập từ khóa vào ô tìm kiếm ở đầu trang "/docs". Có thể kết hợp bấm chọn Khoa/Phòng ở thanh bên trái hoặc bấm chọn Thẻ nhãn (Tags).
- 📄 **Xem & Tải tài liệu**: Bấm vào bất kỳ thẻ tài liệu nào để mở trang xem. Web hỗ trợ xem trực tiếp Word, Excel (có nút chuyển sheet), PDF, hình ảnh, âm thanh, video, YouTube, Google Drive. Bấm nút **"Tải file gốc"** ở góc trên bên phải để tải file về máy.
- ✨ **Tóm tắt AI & Chat với tài liệu**: Trong trang chi tiết tài liệu, chọn tab **"✨ Tóm tắt AI"** để đọc tóm tắt ngắn, hoặc tab **"💬 Hỏi đáp AI"** để trò chuyện chuyên sâu về chính tài liệu đó.
- 🔊 **Đọc giọng nói (TTS)**: Bôi đen bất kỳ đoạn văn bản nào trên trang xem tài liệu sẽ xuất hiện nút **"🔊 Đọc"**, hoặc bấm **"Nghe đáp án"** dưới câu trả lời của bạn để nghe phát âm tiếng Việt.
- 🎙️ **Ra lệnh bằng giọng nói (Voice Command)**: Bấm nút Micro tròn màu đen ở góc dưới bên trái màn hình và nói lệnh bằng tiếng Việt (ví dụ: *"Mở tài liệu quy trình tiếp nhận"*, *"Về trang chủ"*, *"Đăng nhập"*, *"Đăng xuất"*, *"Tắt mic"*).
- 🌓 **Đổi giao diện Tối / Sáng**: Bấm biểu tượng Mặt trời / Mặt trăng ở thanh menu góc trên bên phải header.
- 🗂️ **Đổi kiểu hiển thị**: Bấm 2 nút biểu tượng cạnh tiêu đề "Tài liệu" để đổi giữa **Dạng lưới thẻ (Grid)** và **Dạng danh sách (List)**.
- ⚙️ **Quản trị (Admin / Trưởng khoa)**: Vào mục **"Quản trị"** trên menu để:
  + Upload tài liệu mới (hỗ trợ kéo thả nhiều file cùng lúc, phân quyền Công khai hoặc Chia sẻ riêng từng khoa phòng).
  + Quản lý Khoa / Phòng (thêm, sửa, xóa).
  + Quản lý Người dùng & Đổi mật khẩu.
  + Xem Nhật ký hoạt động (Audit log) nhận diện thiết bị truy cập.
`;

  const prompt = `${systemKnowledge}

${context ? `CÁC TÀI LIỆU NỘI BỘ LIÊN QUAN TRONG HỆ THỐNG:\n${context}\n` : 'HIỆN TẠI KHÔNG CÓ TÀI LIỆU NỘI BỘ NÀO CỤ THỂ ĐÍNH KÈM CHO CÂU HỎI NÀY (HÃY HƯỚNG DẪN HOẶC TRẢ LỜI BẰNG KIẾN THỨC CHUYÊN MÔN/THAO TÁC HỆ THỐNG).\n'}

CÂU HỎI CỦA NGƯỜI DÙNG:
${question}

HÃY TRẢ LỜI NGƯỜI DÙNG BẰNG TIẾNG VIỆT THÂN THIỆN, RÕ RÀNG, ĐẦY ĐỦ VÀ ĐẸP MẮT:`;

  return callOpenAICompatible(prompt);
}

module.exports = {
  extractText,
  summarizeDocument,
  chatWithDocs,
};
