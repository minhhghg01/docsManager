const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXT_OFFICE = new Set([
  '.doc',
  '.docx',
  '.odt',
  '.xls',
  '.xlsx',
  '.ods',
  '.ppt',
  '.pptx',
  '.odp'
]);

function getSofficePath() {
  const fromEnv = process.env.LIBREOFFICE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const winDefault = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
  if (process.platform === 'win32' && fs.existsSync(winDefault)) return winDefault;
  const winAlt = 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe';
  if (process.platform === 'win32' && fs.existsSync(winAlt)) return winAlt;
  return 'soffice';
}

/**
 * Chuyển file sang PDF bằng LibreOffice (headless).
 * @returns {Promise<string>} đường dẫn file PDF đã tạo
 */
function convertToPdf(inputPath, outDir) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputPath)) {
      reject(new Error('File nguồn không tồn tại'));
      return;
    }
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    const soffice = getSofficePath();
    const args = [
      '--headless',
      '--nologo',
      '--nofirststartwizard',
      '--convert-to',
      'pdf',
      '--outdir',
      outDir,
      inputPath
    ];
    const child = spawn(soffice, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `LibreOffice thoát với mã ${code}`));
        return;
      }
      const base = path.basename(inputPath, path.extname(inputPath));
      const pdfPath = path.join(outDir, `${base}.pdf`);
      if (fs.existsSync(pdfPath)) {
        resolve(pdfPath);
        return;
      }
      reject(new Error('Không tìm thấy file PDF sau khi chuyển đổi'));
    });
  });
}

function needsOfficeConversion(filename) {
  const ext = path.extname(filename).toLowerCase();
  return EXT_OFFICE.has(ext);
}

function isPdf(filename) {
  return path.extname(filename).toLowerCase() === '.pdf';
}

module.exports = {
  convertToPdf,
  needsOfficeConversion,
  isPdf,
  getSofficePath
};
