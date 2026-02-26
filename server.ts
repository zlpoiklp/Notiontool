import express from 'express';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createServer as createViteServer } from 'vite';
import { Client } from '@notionhq/client';
import * as cheerio from 'cheerio';

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = 3000;
const NOTION_TEXT_LIMIT = 2000;
const NOTION_BLOCK_BATCH_SIZE = 100;
const APPEND_RETRY_LIMIT = 3;
const DATA_DIR = path.join(process.cwd(), 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });
const dbPath = path.join(DATA_DIR, 'notion-ai-clone.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const parsePayload = (payload: string) => {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
};

const getKvPayload = (key: string) => {
  const row = db.prepare('SELECT payload FROM kv_store WHERE key = ?').get(key) as { payload?: string } | undefined;
  if (!row?.payload) return null;
  return parsePayload(row.payload);
};

const setKvPayload = (key: string, payload: any) => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO kv_store (key, payload, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(payload ?? null), now);
};

function splitTextByLimit(text: string, limit = NOTION_TEXT_LIMIT): string[] {
  if (!text) return [''];

  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks.length > 0 ? chunks : [''];
}

function parseRichText(node: any, $: cheerio.CheerioAPI): any[] {
  const richTexts: any[] = [];

  $(node).contents().each((_, child) => {
    if (child.type === 'text') {
      const text = $(child).text();
      if (text) {
        const chunks = splitTextByLimit(text);
        for (const chunk of chunks) {
          richTexts.push({
            type: 'text',
            text: { content: chunk },
            annotations: {
              bold: $(child).parent().is('strong, b'),
              italic: $(child).parent().is('em, i'),
              strikethrough: $(child).parent().is('s, strike, del'),
              underline: $(child).parent().is('u'),
              code: $(child).parent().is('code'),
              color: $(child).parent().attr('data-color') || 'default',
            }
          });
        }
      }
    } else if (child.type === 'tag') {
      richTexts.push(...parseRichText(child, $));
    }
  });

  if (richTexts.length === 0) {
    richTexts.push({ type: 'text', text: { content: '' } });
  }

  return richTexts;
}

function titleToRichText(title: string): any[] {
  const safeTitle = title.trim() || 'Untitled Document';
  return splitTextByLimit(safeTitle).map((chunk) => ({
    type: 'text',
    text: { content: chunk }
  }));
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function appendChildrenWithRetry(notion: Client, blockId: string, children: any[]) {
  for (let attempt = 1; attempt <= APPEND_RETRY_LIMIT; attempt += 1) {
    try {
      await notion.blocks.children.append({
        block_id: blockId,
        children
      });
      return;
    } catch (error) {
      if (attempt === APPEND_RETRY_LIMIT) {
        throw error;
      }
      await delay(400 * attempt);
    }
  }
}

app.get('/api/documents', (req, res) => {
  const rows = db.prepare('SELECT payload FROM documents ORDER BY updated_at DESC').all();
  const documents = rows.map((row: any) => parsePayload(row.payload)).filter(Boolean);
  res.json({ documents });
});

app.post('/api/documents/bulk', (req, res) => {
  const incoming = Array.isArray(req.body?.documents) ? req.body.documents : null;
  if (!incoming) {
    res.status(400).json({ error: 'documents 必须是数组' });
    return;
  }

  const now = new Date().toISOString();
  const normalized = incoming.map((doc: any) => ({
    ...doc,
    id: typeof doc.id === 'string' && doc.id ? doc.id : crypto.randomUUID(),
    updatedAt: doc.updatedAt || now
  }));

  const upsert = db.prepare(`
    INSERT INTO documents (id, payload, updated_at)
    VALUES (@id, @payload, @updated_at)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `);
  const transaction = db.transaction((items: any[]) => {
    for (const item of items) {
      upsert.run({
        id: item.id,
        payload: JSON.stringify(item),
        updated_at: item.updatedAt
      });
    }
    if (items.length === 0) {
      db.prepare('DELETE FROM documents').run();
      return;
    }
    const ids = items.map(item => item.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM documents WHERE id NOT IN (${placeholders})`).run(...ids);
  });
  transaction(normalized);

  res.json({ success: true, count: normalized.length });
});

app.delete('/api/documents/:id', (req, res) => {
  const id = req.params.id;
  db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  res.json({ success: true });
});

app.get('/api/skills', (req, res) => {
  const rows = db.prepare('SELECT payload FROM skills ORDER BY updated_at DESC').all();
  const skills = rows.map((row: any) => parsePayload(row.payload)).filter(Boolean);
  res.json({ skills });
});

app.post('/api/skills/bulk', (req, res) => {
  const incoming = Array.isArray(req.body?.skills) ? req.body.skills : null;
  if (!incoming) {
    res.status(400).json({ error: 'skills 必须是数组' });
    return;
  }

  const now = new Date().toISOString();
  const normalized = incoming.map((skill: any) => ({
    ...skill,
    id: typeof skill.id === 'string' && skill.id ? skill.id : crypto.randomUUID(),
    updatedAt: skill.updatedAt || now
  }));

  const upsert = db.prepare(`
    INSERT INTO skills (id, payload, updated_at)
    VALUES (@id, @payload, @updated_at)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `);
  const transaction = db.transaction((items: any[]) => {
    for (const item of items) {
      upsert.run({
        id: item.id,
        payload: JSON.stringify(item),
        updated_at: item.updatedAt
      });
    }
    if (items.length === 0) {
      db.prepare('DELETE FROM skills').run();
      return;
    }
    const ids = items.map(item => item.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM skills WHERE id NOT IN (${placeholders})`).run(...ids);
  });
  transaction(normalized);

  res.json({ success: true, count: normalized.length });
});

app.delete('/api/skills/:id', (req, res) => {
  const id = req.params.id;
  db.prepare('DELETE FROM skills WHERE id = ?').run(id);
  res.json({ success: true });
});

app.get('/api/settings', (req, res) => {
  const settings = getKvPayload('settings');
  res.json({ settings });
});

app.post('/api/settings', (req, res) => {
  const settings = req.body?.settings ?? null;
  setKvPayload('settings', settings);
  res.json({ success: true });
});

app.get('/api/snapshots', (req, res) => {
  const snapshots = getKvPayload('snapshots') || {};
  res.json({ snapshots });
});

app.post('/api/snapshots', (req, res) => {
  const snapshots = req.body?.snapshots ?? {};
  setKvPayload('snapshots', snapshots);
  res.json({ success: true });
});

app.get('/api/backups', (req, res) => {
  const backups = getKvPayload('backups') || [];
  res.json({ backups });
});

app.post('/api/backups', (req, res) => {
  const backups = req.body?.backups ?? [];
  setKvPayload('backups', backups);
  res.json({ success: true });
});

app.post('/api/notion/export', async (req, res) => {
  try {
    const { title, content, notionApiKey, notionPageId } = req.body;
    const apiKey = notionApiKey || process.env.NOTION_API_KEY;
    const pageId = notionPageId || process.env.NOTION_PAGE_ID;

    if (!apiKey || !pageId) {
      return res.status(400).json({ error: '请在设置中配置 Notion API Key 和 Page ID。' });
    }

    const notion = new Client({ auth: apiKey });
    const $ = cheerio.load(content || '');
    const blocks: any[] = [];

    $('body').children().each((_, el) => {
      const tagName = el.tagName.toLowerCase();
      const richText = parseRichText(el, $);

      if (tagName === 'h1') {
        blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: richText } });
      } else if (tagName === 'h2') {
        blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: richText } });
      } else if (tagName === 'h3' || tagName === 'h4' || tagName === 'h5' || tagName === 'h6') {
        blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: richText } });
      } else if (tagName === 'p') {
        blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: richText } });
      } else if (tagName === 'ul') {
        $(el).children('li').each((_, li) => {
          blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: parseRichText(li, $) } });
        });
      } else if (tagName === 'ol') {
        $(el).children('li').each((_, li) => {
          blocks.push({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: parseRichText(li, $) } });
        });
      } else if (tagName === 'blockquote') {
        blocks.push({ object: 'block', type: 'quote', quote: { rich_text: richText } });
      } else if (tagName === 'hr') {
        blocks.push({ object: 'block', type: 'divider', divider: {} });
      } else if (tagName === 'pre') {
        const codeText = $(el).text();
        const codeRichText = splitTextByLimit(codeText).map((chunk) => ({ type: 'text', text: { content: chunk } }));
        blocks.push({ object: 'block', type: 'code', code: { rich_text: codeRichText, language: 'plain text' } });
      } else if ($(el).text().trim()) {
        blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: richText } });
      }
    });

    const titleRichText = titleToRichText(title || 'Untitled Document');
    const initialChildren = blocks.slice(0, NOTION_BLOCK_BATCH_SIZE);
    const remainingChildren = blocks.slice(NOTION_BLOCK_BATCH_SIZE);

    let response;
    try {
      const payload: any = {
        parent: { page_id: pageId },
        properties: {
          title: {
            title: titleRichText,
          },
        },
      };
      if (initialChildren.length > 0) {
        payload.children = initialChildren;
      }
      response = await notion.pages.create(payload);
    } catch (err: any) {
      console.log('Failed to create as page child, trying as database child...', err.message);
      try {
        const payload: any = {
          parent: { database_id: pageId },
          properties: {
            Name: {
              title: titleRichText,
            },
          },
        };
        if (initialChildren.length > 0) {
          payload.children = initialChildren;
        }
        response = await notion.pages.create(payload);
      } catch (dbErr: any) {
        throw new Error(`Notion API Error: ${err.message} | DB Error: ${dbErr.message}`);
      }
    }

    if (remainingChildren.length > 0) {
      const batches = chunkArray(remainingChildren, NOTION_BLOCK_BATCH_SIZE);
      for (const batch of batches) {
        await appendChildrenWithRetry(notion, (response as any).id, batch);
      }
    }

    res.json({ success: true, url: (response as any).url, exportedBlocks: blocks.length });
  } catch (error: any) {
    console.error('Notion export error:', error);
    res.status(500).json({ error: error.message || 'Failed to export to Notion' });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
