const mammoth = require('mammoth');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const WORD_EXTS = new Set(['.doc', '.docx', '.odt']);
const EXCEL_EXTS = new Set(['.xls', '.xlsx', '.ods', '.csv']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MEDIA_EXTS = new Set(['.mp3', '.mp4', '.wav', '.m4a', '.webm']);
const PLAIN_TEXT_EXTS = new Set(['.txt', '.md', '.log']);

const VIEWABLE_EXTS = new Set([...WORD_EXTS, ...EXCEL_EXTS, ...IMAGE_EXTS, ...MEDIA_EXTS, ...PLAIN_TEXT_EXTS]);

function isPdf(filename) {
  return path.extname(filename).toLowerCase() === '.pdf';
}

function isImage(filename) {
  return IMAGE_EXTS.has(path.extname(filename).toLowerCase());
}

function isMedia(filename) {
  return MEDIA_EXTS.has(path.extname(filename).toLowerCase());
}

function isPlainText(filename) {
  return PLAIN_TEXT_EXTS.has(path.extname(filename).toLowerCase());
}

function isViewable(filename) {
  const ext = path.extname(filename).toLowerCase();
  return VIEWABLE_EXTS.has(ext);
}

function isWordFile(filename) {
  return WORD_EXTS.has(path.extname(filename).toLowerCase());
}

function isExcelFile(filename) {
  return EXCEL_EXTS.has(path.extname(filename).toLowerCase());
}

const HTML_WRAPPER_START = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    color:#1e293b;padding:24px 32px;line-height:1.7;max-width:900px;margin:0 auto;background:#fff}
  h1,h2,h3,h4,h5,h6{margin-top:1em;margin-bottom:.4em;font-weight:600}
  p{margin-bottom:.6em}
  ul,ol{margin:0 0 .6em 1.6em}
  table{border-collapse:collapse;width:100%;margin-bottom:1em;font-size:14px}
  th,td{border:1px solid #cbd5e1;padding:6px 10px;text-align:left}
  th{background:#f1f5f9;font-weight:600;position:sticky;top:0}
  tr:nth-child(even){background:#f8fafc}
  tr:hover{background:#e2e8f0}
  img{max-width:100%;height:auto}
  .sheet-tabs{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap}
  .sheet-tabs button{padding:6px 14px;border:1px solid #cbd5e1;border-radius:6px;background:#f1f5f9;
    cursor:pointer;font-size:13px;font-weight:500}
  .sheet-tabs button.active{background:#0284c7;color:#fff;border-color:#0284c7}
  .sheet-section{display:none}
  .sheet-section.active{display:block}
</style>
</head>
<body>`;

const HTML_WRAPPER_END = `
<script>
// --- Khối Text-to-Speech (TTS) cho nội dung Iframe ---
const ttsFloatBtn = document.createElement('button');
ttsFloatBtn.innerHTML = '<span style="font-size:16px;">🔊</span> Đọc';
ttsFloatBtn.style.cssText = 'position:fixed;z-index:99999;background:#0ea5e9;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-weight:600;cursor:pointer;box-shadow:0 4px 10px rgba(0,0,0,0.15);display:none;font-family:sans-serif;font-size:13px;align-items:center;gap:4px;transition:all 0.1s;';
// Hover effect
ttsFloatBtn.onmouseover = function() { this.style.backgroundColor = '#0284c7'; };
ttsFloatBtn.onmouseout = function() { this.style.backgroundColor = '#0ea5e9'; };

document.body.appendChild(ttsFloatBtn);

let selectedText = '';
document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  selectedText = selection.toString().trim();
  if (selectedText.length > 0) {
    try {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      ttsFloatBtn.style.top = (rect.top - 35) + 'px';
      ttsFloatBtn.style.left = (rect.left + (rect.width / 2) - 30) + 'px';
      ttsFloatBtn.style.display = 'flex';
    } catch(e) {}
  } else {
    ttsFloatBtn.style.display = 'none';
  }
});

ttsFloatBtn.addEventListener('mousedown', (e) => {
  e.preventDefault(); // prevent selection from disappearing
  if (selectedText) {
    if (window.parent && typeof window.parent.speakText === 'function') {
      window.parent.speakText(selectedText);
    } else {
      // Fallback cục bộ
      const synth = window.speechSynthesis;
      if (synth) {
        if (synth.speaking) synth.cancel();
        let utt = new SpeechSynthesisUtterance(selectedText);
        utt.lang = 'vi-VN';
        synth.speak(utt);
      }
    }
  }
});

// Warmup voices
if(window.speechSynthesis) window.speechSynthesis.getVoices();
</script>
</body></html>`;

/**
 * Word (.docx/.doc) → HTML via mammoth
 */
async function wordToHtml(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.doc') {
    return `${HTML_WRAPPER_START}
      <div style="text-align:center;padding:40px;color:#64748b">
        <p>Định dạng <strong>.doc</strong> (Word cũ) chỉ hỗ trợ xem hạn chế.</p>
        <p>Vui lòng tải file gốc để xem đầy đủ.</p>
      </div>
    ${HTML_WRAPPER_END}`;
  }
  const result = await mammoth.convertToHtml(
    { path: filePath },
    {
      styleMap: [
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh"
      ]
    }
  );
  return `${HTML_WRAPPER_START}${result.value}${HTML_WRAPPER_END}`;
}

/**
 * Excel (.xlsx/.xls/.ods/.csv) → HTML table
 */
function excelToHtml(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheetNames = wb.SheetNames;

  if (sheetNames.length === 0) {
    return `${HTML_WRAPPER_START}<p>File không có sheet nào.</p>${HTML_WRAPPER_END}`;
  }

  let tabsHtml = '';
  let sheetsHtml = '';

  if (sheetNames.length > 1) {
    tabsHtml = '<div class="sheet-tabs">';
    sheetNames.forEach((name, i) => {
      tabsHtml += `<button onclick="switchSheet(${i})" class="${i === 0 ? 'active' : ''}" id="tab-${i}">${escapeHtml(name)}</button>`;
    });
    tabsHtml += '</div>';
  }

  sheetNames.forEach((name, i) => {
    const ws = wb.Sheets[name];
    const html = XLSX.utils.sheet_to_html(ws, { id: `sheet-${i}` });
    sheetsHtml += `<div class="sheet-section ${i === 0 ? 'active' : ''}" id="section-${i}">
      ${sheetNames.length > 1 ? `<h3 style="margin-bottom:8px">${escapeHtml(name)}</h3>` : ''}
      ${html}
    </div>`;
  });

  const script = sheetNames.length > 1
    ? `<script>
function switchSheet(idx){
  document.querySelectorAll('.sheet-section').forEach(function(el){el.classList.remove('active')});
  document.querySelectorAll('.sheet-tabs button').forEach(function(el){el.classList.remove('active')});
  document.getElementById('section-'+idx).classList.add('active');
  document.getElementById('tab-'+idx).classList.add('active');
}
</script>`
    : '';

  return `${HTML_WRAPPER_START}${tabsHtml}${sheetsHtml}${script}${HTML_WRAPPER_END}`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Chuyển file thành HTML để hiển thị inline.
 * @returns {Promise<string>} chuỗi HTML hoàn chỉnh
 */
async function convertToHtml(filePath, originalFilename) {
  if (isWordFile(originalFilename)) {
    return wordToHtml(filePath);
  }
  if (isExcelFile(originalFilename)) {
    return excelToHtml(filePath);
  }
  throw new Error('Định dạng chưa hỗ trợ xem trực tiếp');
}

module.exports = {
  isPdf,
  isImage,
  isMedia,
  isPlainText,
  isViewable,
  isWordFile,
  isExcelFile,
  convertToHtml
};
