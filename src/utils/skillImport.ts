import { Skill, WorkflowCadence, WorkflowOutput, WorkflowRisk, WorkflowScope } from '../types/skill';

const SCOPE_VALUES: WorkflowScope[] = ['current_doc', 'knowledge_base', 'new_page'];
const OUTPUT_VALUES: WorkflowOutput[] = ['plan', 'rewrite', 'translate'];
const CADENCE_VALUES: WorkflowCadence[] = ['manual', 'auto'];
const RISK_VALUES: WorkflowRisk[] = ['low', 'medium', 'high'];

const toStringValue = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const parseEnum = <T extends string>(
  value: unknown,
  fallback: T,
  allowed: readonly T[]
): T => {
  if (typeof value === 'string' && allowed.includes(value as T)) {
    return value as T;
  }
  return fallback;
};

const buildSkillId = (prefix = 'imported') => (
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
);

const parseFrontmatter = (markdown: string): { frontmatter: Record<string, string>; body: string } => {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const frontmatterMatch = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!frontmatterMatch) {
    return { frontmatter: {}, body: normalized.trim() };
  }

  const rawFrontmatter = frontmatterMatch[1];
  const body = normalized.slice(frontmatterMatch[0].length).trim();
  const frontmatter: Record<string, string> = {};

  rawFrontmatter.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex < 0) return;
    const key = trimmed.slice(0, separatorIndex).trim().toLowerCase();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, '');
    if (key) {
      frontmatter[key] = value;
    }
  });

  return { frontmatter, body };
};

const removeLeadingTitle = (markdown: string): string => markdown.replace(/^#\s+.+\n?/, '').trim();

const buildSkillFromObject = (source: Record<string, unknown>, sourceLabel = '导入内容'): Skill => {
  const name = toStringValue(source.name) || toStringValue(source.title);
  const prompt = toStringValue(source.prompt);
  if (!name || !prompt) {
    throw new Error(`${sourceLabel} 缺少 name/title 或 prompt 字段`);
  }

  return {
    id: toStringValue(source.id) || buildSkillId(),
    name,
    description: toStringValue(source.description) || '导入技能',
    prompt,
    scope: parseEnum(source.scope, 'current_doc', SCOPE_VALUES),
    output: parseEnum(source.output, 'plan', OUTPUT_VALUES),
    cadence: parseEnum(source.cadence, 'manual', CADENCE_VALUES),
    risk: parseEnum(source.risk, 'low', RISK_VALUES)
  };
};

export const parseSkillsFromJson = (rawText: string, sourceLabel = 'JSON'): Skill[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`${sourceLabel} 不是合法 JSON`);
  }

  const toSkill = (item: unknown, index: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${sourceLabel} 第 ${index + 1} 项不是对象`);
    }
    return buildSkillFromObject(item as Record<string, unknown>, `${sourceLabel} 第 ${index + 1} 项`);
  };

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new Error(`${sourceLabel} 为空数组`);
    }
    return parsed.map((item, index) => toSkill(item, index));
  }

  if (parsed && typeof parsed === 'object') {
    const payload = parsed as Record<string, unknown>;
    if (Array.isArray(payload.skills)) {
      if (payload.skills.length === 0) {
        throw new Error(`${sourceLabel} 的 skills 为空数组`);
      }
      return payload.skills.map((item, index) => toSkill(item, index));
    }
    return [buildSkillFromObject(payload, sourceLabel)];
  }

  throw new Error(`${sourceLabel} 内容格式不支持`);
};

export const parseSkillFromMarkdown = (rawText: string, sourceLabel = 'Markdown'): Skill => {
  const { frontmatter, body } = parseFrontmatter(rawText);
  const firstTitleMatch = body.match(/^#\s+(.+)$/m);
  const name = (
    frontmatter.name ||
    frontmatter.title ||
    (firstTitleMatch ? firstTitleMatch[1].trim() : '')
  ).trim();
  const description = (frontmatter.description || frontmatter.desc || '').trim();

  const prompt = (
    frontmatter.prompt ||
    removeLeadingTitle(body)
  ).trim();

  if (!name || !prompt) {
    throw new Error(`${sourceLabel} 缺少技能名称或提示词内容`);
  }

  return {
    id: (frontmatter.id || '').trim() || buildSkillId('md'),
    name,
    description: description || 'Markdown 导入技能',
    prompt,
    scope: parseEnum(frontmatter.scope, 'current_doc', SCOPE_VALUES),
    output: parseEnum(frontmatter.output, 'plan', OUTPUT_VALUES),
    cadence: parseEnum(frontmatter.cadence, 'manual', CADENCE_VALUES),
    risk: parseEnum(frontmatter.risk, 'low', RISK_VALUES)
  };
};

export const parseSkillsFromText = (rawText: string): Skill[] => {
  const text = rawText.trim();
  if (!text) {
    throw new Error('导入内容为空');
  }

  if (text.startsWith('{') || text.startsWith('[')) {
    return parseSkillsFromJson(text, '粘贴内容(JSON)');
  }

  return [parseSkillFromMarkdown(text, '粘贴内容(Markdown)')];
};

export const parseSkillsFromFile = async (file: File): Promise<Skill[]> => {
  const rawText = await file.text();
  const fileName = file.name || '未命名文件';
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith('.json')) {
    return parseSkillsFromJson(rawText, `文件 ${fileName}`);
  }

  if (lowerName.endsWith('.md') || lowerName.endsWith('.markdown')) {
    return [parseSkillFromMarkdown(rawText, `文件 ${fileName}`)];
  }

  const text = rawText.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    return parseSkillsFromJson(text, `文件 ${fileName}`);
  }
  return [parseSkillFromMarkdown(text, `文件 ${fileName}`)];
};
