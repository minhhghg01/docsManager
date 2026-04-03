const mammoth = require('mammoth');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const WORD_EXTS = new Set(['.doc', '.docx', '.odt']);
const EXCEL_EXTS = new Set(['.xls', '.xlsx', '.ods', '.csv']);
const PPT_EXTS = new Set(['.ppt', '.pptx', '.odp']);
const VIEWABLE_EXTS = new Set([...WORD_EXTS, ...EXCEL_EXTS, ...PPT_EXTS]);

function isPdf(filename) {
  return path.extname(filename).toLowerCase() === '.pdf';
}

function isViewable(filename) {
  return VIEWABLE_EXTS.has(path.extname(filename).toLowerCase());
}

function isWordFile(filename) {
  return WORD_EXTS.has(path.extname(filename).toLowerCase());
}

function isExcelFile(filename) {
  return EXCEL_EXTS.has(path.extname(filename).toLowerCase());
}

function isPptFile(filename) {
  return PPT_EXTS.has(path.extname(filename).toLowerCase());
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
  .slide{border:1px solid #e2e8f0;border-radius:12px;padding:32px;margin-bottom:24px;background:#fff;
    box-shadow:0 1px 3px rgba(0,0,0,.06);page-break-after:always;min-height:200px}
  .slide-header{display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:12px;
    border-bottom:2px solid #e2e8f0}
  .slide-num{background:#0284c7;color:#fff;width:32px;height:32px;border-radius:50%;
    display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0}
  .slide-title{font-size:18px;font-weight:600;color:#0c4a6e}
  .slide-body{font-size:15px;line-height:1.8}
  .slide-body ul{list-style:disc;margin-left:1.5em}
  .slide-body li{margin-bottom:4px}
  .slide-img{margin:12px 0;text-align:center}
  .slide-img img{max-width:100%;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
</style>
</head>
<body>`;

const HTML_WRAPPER_END = `</body></html>`;

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Extract text runs from PowerPoint XML node content.
 * Handles <a:t> tags inside <a:r> runs.
 */
function extractTextFromXml(xml) {
  const paragraphs = [];
  const pMatches = xml.match(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g) || [];

  for (const pBlock of pMatches) {
    const runs = [];
    const tMatches = pBlock.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g) || [];
    for (const t of tMatches) {
      const text = t.replace(/<[^>]+>/g, '').trim();
      if (text) runs.push(text);
    }
    if (runs.length) {
      paragraphs.push(runs.join(''));
    }
  }
  return paragraphs;
}

/**
 * PPTX → HTML: unzip, parse slide XMLs, extract text + embedded images
 */
function pptxToHtml(filePath) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();

  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
    .sort((a, b) => {
      const na = parseInt(a.entryName.match(/slide(\d+)/)[1], 10);
      const nb = parseInt(b.entryName.match(/slide(\d+)/)[1], 10);
      return na - nb;
    });

  if (!slideEntries.length) {
    return `${HTML_WRAPPER_START}<p>Không tìm thấy slide nào trong file.</p>${HTML_WRAPPER_END}`;
  }

  const imageMap = {};
  entries.forEach((e) => {
    if (/^ppt\/media\//i.test(e.entryName)) {
      const ext = path.extname(e.entryName).toLowerCase();
      const mime =
        ext === '.png' ? 'image/png' :
        ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
        ext === '.gif' ? 'image/gif' :
        ext === '.svg' ? 'image/svg+xml' :
        ext === '.emf' || ext === '.wmf' ? null : 'image/png';
      if (mime) {
        const data = e.getData();
        imageMap[e.entryName] = `data:${mime};base64,${data.toString('base64')}`;
      }
    }
  });

  const relsMap = {};
  entries.forEach((e) => {
    if (/^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/i.test(e.entryName)) {
      const slideNum = e.entryName.match(/slide(\d+)/)[1];
      const xml = e.getData().toString('utf8');
      const relMatches = xml.match(/<Relationship[^>]+>/g) || [];
      relsMap[slideNum] = {};
      for (const rel of relMatches) {
        const idMatch = rel.match(/Id="([^"]+)"/);
        const targetMatch = rel.match(/Target="([^"]+)"/);
        if (idMatch && targetMatch) {
          let target = targetMatch[1];
          if (target.startsWith('..')) {
            target = 'ppt' + target.substring(2);
          }
          relsMap[slideNum][idMatch[1]] = target;
        }
      }
    }
  });

  let slidesHtml = '';

  slideEntries.forEach((entry, idx) => {
    const slideNum = idx + 1;
    const xml = entry.getData().toString('utf8');
    const paragraphs = extractTextFromXml(xml);

    const relIds = xml.match(/r:embed="([^"]+)"/g) || [];
    const images = [];
    const sNum = entry.entryName.match(/slide(\d+)/)[1];
    for (const r of relIds) {
      const rId = r.match(/r:embed="([^"]+)"/)[1];
      const rels = relsMap[sNum] || {};
      const target = rels[rId];
      if (target && imageMap[target]) {
        images.push(imageMap[target]);
      }
    }

    const title = paragraphs.length ? escapeHtml(paragraphs[0]) : `Slide ${slideNum}`;
    const bodyParagraphs = paragraphs.slice(1);

    slidesHtml += `<div class="slide">
      <div class="slide-header">
        <div class="slide-num">${slideNum}</div>
        <div class="slide-title">${title}</div>
      </div>
      <div class="slide-body">`;

    if (bodyParagraphs.length) {
      slidesHtml += '<ul>';
      for (const p of bodyParagraphs) {
        slidesHtml += `<li>${escapeHtml(p)}</li>`;
      }
      slidesHtml += '</ul>';
    }

    for (const src of images) {
      slidesHtml += `<div class="slide-img"><img src="${src}" alt="Slide ${slideNum}"/></div>`;
    }

    slidesHtml += '</div></div>';
  });

  const header = `<div style="margin-bottom:24px;padding-bottom:12px;border-bottom:1px solid #e2e8f0">
    <span style="font-size:13px;color:#64748b">${slideEntries.length} slide</span>
  </div>`;

  return `${HTML_WRAPPER_START}${header}${slidesHtml}${HTML_WRAPPER_END}`;
}

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

async function convertToHtml(filePath, originalFilename) {
  if (isWordFile(originalFilename)) {
    return wordToHtml(filePath);
  }
  if (isExcelFile(originalFilename)) {
    return excelToHtml(filePath);
  }
  if (isPptFile(originalFilename)) {
    return pptxToHtml(filePath);
  }
  throw new Error('Định dạng chưa hỗ trợ xem trực tiếp');
}

module.exports = {
  isPdf,
  isViewable,
  isWordFile,
  isExcelFile,
  isPptFile,
  convertToHtml
};
