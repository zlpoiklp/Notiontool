import express from 'express';
import { createServer as createViteServer } from 'vite';
import { Client } from '@notionhq/client';
import * as cheerio from 'cheerio';

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = 3000;

function parseRichText(node: any, $: cheerio.CheerioAPI): any[] {
  const richTexts: any[] = [];
  
  $(node).contents().each((_, child) => {
    if (child.type === 'text') {
      const text = $(child).text();
      if (text) {
        richTexts.push({
          type: 'text',
          text: { content: text },
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
    } else if (child.type === 'tag') {
      richTexts.push(...parseRichText(child, $));
    }
  });

  // If empty, Notion requires at least one text object with empty content
  if (richTexts.length === 0) {
    richTexts.push({ type: 'text', text: { content: '' } });
  }

  return richTexts;
}

app.post('/api/notion/export', async (req, res) => {
  try {
    const { title, content, notionApiKey, notionPageId } = req.body;
    const apiKey = notionApiKey || process.env.NOTION_API_KEY;
    const pageId = notionPageId || process.env.NOTION_PAGE_ID;

    if (!apiKey || !pageId) {
      return res.status(400).json({ error: '请在设置中配置 Notion API Key 和 Page ID。' });
    }

    const notion = new Client({ auth: apiKey });
    const $ = cheerio.load(content);
    const blocks: any[] = [];

    $('body').children().each((_, el) => {
      const tagName = el.tagName.toLowerCase();
      const rich_text = parseRichText(el, $);
      
      // Notion limits rich text content to 2000 characters per text object, 
      // but we'll assume the chunks are small enough for now, or we can truncate.
      // For a robust implementation, we should split long text chunks.
      
      if (tagName === 'h1') {
        blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text } });
      } else if (tagName === 'h2') {
        blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text } });
      } else if (tagName === 'h3' || tagName === 'h4' || tagName === 'h5' || tagName === 'h6') {
        blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text } });
      } else if (tagName === 'p') {
        blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text } });
      } else if (tagName === 'ul') {
        $(el).children('li').each((_, li) => {
          blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: parseRichText(li, $) } });
        });
      } else if (tagName === 'ol') {
        $(el).children('li').each((_, li) => {
          blocks.push({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: parseRichText(li, $) } });
        });
      } else if (tagName === 'blockquote') {
        blocks.push({ object: 'block', type: 'quote', quote: { rich_text } });
      } else if (tagName === 'hr') {
        blocks.push({ object: 'block', type: 'divider', divider: {} });
      } else if (tagName === 'pre') {
        const codeText = $(el).text();
        blocks.push({ object: 'block', type: 'code', code: { rich_text: [{ type: 'text', text: { content: codeText.substring(0, 2000) } }], language: 'plain text' } });
      } else {
        // Fallback to paragraph
        if ($(el).text().trim()) {
           blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text } });
        }
      }
    });

    let response;
    try {
      response = await notion.pages.create({
        parent: { page_id: pageId },
        properties: {
          title: {
            title: [{ text: { content: title || 'Untitled Document' } }],
          },
        },
        children: blocks.slice(0, 100), // Notion allows max 100 blocks per request
      });
    } catch (err: any) {
      console.log("Failed to create as page child, trying as database child...", err.message);
      try {
        response = await notion.pages.create({
          parent: { database_id: pageId },
          properties: {
            Name: {
              title: [{ text: { content: title || 'Untitled Document' } }],
            },
          },
          children: blocks.slice(0, 100),
        });
      } catch (dbErr: any) {
         throw new Error(`Notion API Error: ${err.message} | DB Error: ${dbErr.message}`);
      }
    }

    res.json({ success: true, url: (response as any).url });
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
