import { escapeHtml, sanitizeHtml, textToSafeHtml } from './safeHtml';

const MAX_IMPORT_FILE_SIZE = 20 * 1024 * 1024; // 20MB

const TEXT_EXTENSIONS = new Set(['txt']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);
const CSV_EXTENSIONS = new Set(['csv']);
const HTML_EXTENSIONS = new Set(['html', 'htm']);
const PDF_EXTENSIONS = new Set(['pdf']);
const WORD_EXTENSIONS = new Set(['docx']);

const MARKDOWN_MIME_TYPES = new Set(['text/markdown', 'text/x-markdown']);
const CSV_MIME_TYPES = new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel']);
const HTML_MIME_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const PDF_MIME_TYPES = new Set(['application/pdf']);
const DOCX_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

export const SUPPORTED_IMPORT_ACCEPT =
  '.txt,.md,.markdown,.csv,.html,.htm,.pdf,.docx';

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

function getFileExtension(fileName: string): string {
  const parts = fileName.split('.');
  return parts.length > 1 ? (parts.pop() || '').toLowerCase() : '';
}

function toDocumentTitle(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, '').trim() || '导入文档';
}

function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i += 1) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ',') {
      currentRow.push(currentField);
      currentField = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && nextChar === '\n') {
        i += 1;
      }

      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = '';
      continue;
    }

    currentField += char;
  }

  currentRow.push(currentField);
  const hasMeaningfulCell =
    currentRow.length > 1 || currentRow.some((cell) => cell.length > 0);
  if (hasMeaningfulCell) {
    rows.push(currentRow);
  }

  return rows;
}

function csvToHtml(csvText: string): string {
  const rows = parseCsvRows(stripBom(csvText));
  if (rows.length === 0) {
    return '<p>CSV 文件为空。</p>';
  }

  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => {
    if (row.length >= columnCount) return row;
    return [...row, ...Array(columnCount - row.length).fill('')];
  });

  const [headerRow, ...bodyRows] = normalizedRows;
  const headerHtml = headerRow
    .map((cell) => `<th>${escapeHtml(cell || '')}</th>`)
    .join('');
  const bodyHtml = bodyRows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(cell || '')}</td>`).join('')}</tr>`
    )
    .join('');

  return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

async function markdownToHtml(markdownText: string): Promise<string> {
  const normalized = stripBom(markdownText);
  const { marked } = await import('marked');
  marked.setOptions({
    gfm: true,
    breaks: true
  });

  const rendered = await marked.parse(normalized);
  return sanitizeHtml(typeof rendered === 'string' ? rendered : String(rendered || ''));
}

function paragraphizePlainText(text: string): string {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) {
    return '<p>（无可提取文本）</p>';
  }

  return blocks
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

async function pdfToHtml(file: File): Promise<string> {
  const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.mjs?url')
  ]);

  GlobalWorkerOptions.workerSrc = workerModule.default;

  const loadingTask = getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await loadingTask.promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = (textContent.items as Array<{ str?: string; hasEOL?: boolean }>)
      .map((item) => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`)
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    pages.push(pageText);
  }

  if (!pages.some((text) => text.length > 0)) {
    throw new Error('PDF 中没有可提取文本，可能是扫描图片版 PDF。');
  }

  return pages
    .map(
      (pageText, index) =>
        `<h2>第 ${index + 1} 页</h2>${paragraphizePlainText(pageText)}`
    )
    .join('');
}

async function docxToHtml(file: File): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  const html = sanitizeHtml(result.value || '');

  if (!html.trim()) {
    throw new Error('Word 文档中没有可提取内容。');
  }

  return html;
}

type ImportedFileResult = {
  title: string;
  content: string;
};

export async function importFileToDocument(file: File): Promise<ImportedFileResult> {
  if (!file) {
    throw new Error('未检测到文件。');
  }

  if (file.size === 0) {
    throw new Error('文件为空，无法导入。');
  }

  if (file.size > MAX_IMPORT_FILE_SIZE) {
    throw new Error('文件过大（超过 20MB），请拆分后再导入。');
  }

  const extension = getFileExtension(file.name);
  const mimeType = (file.type || '').toLowerCase();
  const title = toDocumentTitle(file.name);

  const isMarkdown = MARKDOWN_EXTENSIONS.has(extension) || MARKDOWN_MIME_TYPES.has(mimeType);
  const isCsv = CSV_EXTENSIONS.has(extension) || CSV_MIME_TYPES.has(mimeType);
  const isHtml = HTML_EXTENSIONS.has(extension) || HTML_MIME_TYPES.has(mimeType);
  const isPlainText =
    TEXT_EXTENSIONS.has(extension) ||
    (mimeType.startsWith('text/') && !isMarkdown && !isCsv && !isHtml);

  if (isPlainText) {
    const text = await file.text();
    return { title, content: textToSafeHtml(stripBom(text)) };
  }

  if (isMarkdown) {
    const markdown = await file.text();
    return { title, content: await markdownToHtml(markdown) };
  }

  if (isCsv) {
    const csv = await file.text();
    return { title, content: csvToHtml(csv) };
  }

  if (isHtml) {
    const html = await file.text();
    return { title, content: sanitizeHtml(html) };
  }

  if (PDF_EXTENSIONS.has(extension) || PDF_MIME_TYPES.has(mimeType)) {
    return { title, content: await pdfToHtml(file) };
  }

  if (WORD_EXTENSIONS.has(extension) || DOCX_MIME_TYPES.has(mimeType)) {
    return { title, content: await docxToHtml(file) };
  }

  throw new Error(
    '当前仅支持 TXT、Markdown、CSV、HTML、PDF、DOCX 导入。'
  );
}
