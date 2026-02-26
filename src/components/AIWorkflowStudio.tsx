import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  CheckCircle2,
  Clock3,
  Folder,
  FolderSync,
  Globe2,
  GripVertical,
  Library,
  Link2,
  Loader2,
  ListTree,
  Plus,
  RotateCcw,
  Settings2,
  Send,
  Square,
  Trash2,
  X,
  Brain
} from 'lucide-react';
import { GoogleGenerativeAI } from '@google/generative-ai';
import ReactMarkdown from 'react-markdown';
import { useDebounce } from '../hooks/useDebounce';
import { AutomationStrategy, Document, Settings } from '../App';
import { Skill as InspirationSkill, WorkflowScope, WorkflowOutput, WorkflowCadence, WorkflowRisk } from '../types/skill';
import SkillsManager from './SkillsManager';

type WorkflowStep = { id: string; title: string; detail: string };
type WorkflowDraft = {
  id: string;
  goal: string;
  summary: string;
  scope: WorkflowScope;
  output: WorkflowOutput;
  cadence: WorkflowCadence;
  risk: WorkflowRisk;
  targetDocId: string | null;
  steps: WorkflowStep[];
  runCount: number;
  lastRunAt?: string;
};

type SkillLearningMode = 'confirm' | 'auto' | 'off';

type ProposedSkillDraft = {
  name: string;
  description: string;
  prompt: string;
  scope: WorkflowScope;
  output: WorkflowOutput;
  cadence: WorkflowCadence;
  risk: WorkflowRisk;
  confidence?: number;
  rationale?: string;
};

type SkillMessageMeta = {
  usedSkillIds?: string[];
  usedSkillNames?: string[];
  proposedSkill?: ProposedSkillDraft;
  learningStatus?: 'suggested' | 'created' | 'skipped' | 'error';
  learningNote?: string;
};

type ReplySkillContext = {
  baseMessage: string;
  invokedSkills?: InspirationSkill[];
};

type SkillRoutingResult = {
  skills: InspirationSkill[];
  autoSearch: boolean;
};

const GOAL_BREAKDOWN_SKILL_ID = 'goal_breakdown';

type StudioMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  skillMeta?: SkillMessageMeta;
};
type ChatAttachedFile = {
  id: string;
  name: string;
  type: 'file' | 'folder';
  content?: string;
  files?: Array<{ name: string; content: string }>;
};
type ChatAttachedLink = {
  url: string;
  content?: string;
  title?: string;
  error?: string;
  status: 'loading' | 'done' | 'error';
};

type DraftUndoSnapshot = {
  draft: WorkflowDraft;
  selectedStepIds: string[];
  deletedCount: number;
};

type StepRunStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed' | 'skipped';
type StepRunState = {
  status: StepRunStatus;
  output: string;
  error: string | null;
  attempts: number;
  startedAt?: string;
  endedAt?: string;
};

type WorkflowRunPhase = 'idle' | 'running' | 'completed' | 'failed' | 'stopped';

type DocRunBackup = {
  docId: string;
  content: string;
  aiSummary?: string;
  aiActionItems?: string[];
  autoInsightsUpdatedAt?: string;
  goalSource?: Document['goalSource'];
  automationStrategy?: AutomationStrategy;
};

type PersistedStudioSession = {
  messages?: StudioMessage[];
  input?: string;
  scope?: WorkflowScope;
  output?: WorkflowOutput;
  cadence?: WorkflowCadence;
  risk?: WorkflowRisk;
  targetDocId?: string | null;
  isSearchEnabled?: boolean;
  referencedPageIds?: string[];
  attachedLinks?: ChatAttachedLink[];
  draft?: WorkflowDraft | null;
  selectedDraftStepIds?: string[];
  stepRunState?: Record<string, StepRunState>;
  runPhase?: WorkflowRunPhase;
  runLogs?: string[];
  skillLearningMode?: SkillLearningMode;
  isSkillEnabled?: boolean;
  selectedComposerSkillIds?: string[];
};

const STUDIO_SESSION_STORAGE_KEY = 'inspriation_ai_session_v1';

const SKILL_OPS_TAG_REGEX = /<skill_ops>([\s\S]*?)<\/skill_ops>/i;
const SKILL_ROUTER_TIMEOUT_MS = 1800;

const SKILL_SCOPE_VALUES: WorkflowScope[] = ['current_doc', 'knowledge_base', 'new_page'];
const SKILL_OUTPUT_VALUES: WorkflowOutput[] = ['plan', 'rewrite', 'translate'];
const SKILL_CADENCE_VALUES: WorkflowCadence[] = ['manual', 'auto'];
const SKILL_RISK_VALUES: WorkflowRisk[] = ['low', 'medium', 'high'];

const toTrimmedString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const normalizeSignature = (name: string, prompt: string) => `${name.trim().toLowerCase()}::${prompt.trim()}`;
const createLearnedSkillId = () => `learned_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const parseEnum = <T extends string>(value: unknown, fallback: T, allowed: readonly T[]): T => {
  if (typeof value === 'string' && allowed.includes(value as T)) {
    return value as T;
  }
  return fallback;
};

const parseJsonObject = (rawText: string): Record<string, unknown> | null => {
  const safeTry = (candidate: string) => {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const trimmed = rawText.trim();
  if (!trimmed) return null;

  const direct = safeTry(trimmed);
  if (direct) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    const fromFence = safeTry(fenced.trim());
    if (fromFence) return fromFence;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return safeTry(trimmed.slice(start, end + 1));
  }

  return null;
};

const toHintValue = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const obj = value as Record<string, unknown>;
  return (
    toTrimmedString(obj.id) ||
    toTrimmedString(obj.name) ||
    toTrimmedString(obj.skill_id) ||
    toTrimmedString(obj.skillId) ||
    toTrimmedString(obj.skill_name) ||
    toTrimmedString(obj.skillName)
  );
};

const toHintList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map(item => toHintValue(item)).filter(Boolean);
  }
  const single = toHintValue(value);
  return single ? [single] : [];
};

const normalizeHint = (value: string) => value.trim().toLowerCase();
const normalizeCompactHint = (value: string) => normalizeHint(value).replace(/[\s_-]+/g, '');

const resolveSkillsByHints = (hints: string[], catalog: InspirationSkill[]): InspirationSkill[] => {
  const selected = new Map<string, InspirationSkill>();
  for (const hint of hints) {
    const normalized = normalizeHint(hint);
    const compact = normalizeCompactHint(hint);
    if (!normalized && !compact) continue;
    const matched = catalog.find(skill => {
      const id = normalizeHint(skill.id);
      const name = normalizeHint(skill.name);
      const compactId = normalizeCompactHint(skill.id);
      const compactName = normalizeCompactHint(skill.name);
      return (
        id === normalized ||
        name === normalized ||
        compactId === compact ||
        compactName === compact ||
        id.includes(normalized) ||
        name.includes(normalized) ||
        normalized.includes(id) ||
        normalized.includes(name)
      );
    });
    if (matched) selected.set(matched.id, matched);
  }
  return Array.from(selected.values());
};

const parseBooleanLike = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'on'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0', 'off'].includes(normalized)) return false;
  return null;
};

const toBigrams = (text: string): Set<string> => {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
  const grams = new Set<string>();
  if (!normalized) return grams;
  if (normalized.length === 1) {
    grams.add(normalized);
    return grams;
  }
  for (let i = 0; i < normalized.length - 1; i += 1) {
    grams.add(normalized.slice(i, i + 2));
  }
  return grams;
};

const scoreTextSimilarity = (left: string, right: string): number => {
  const leftGrams = toBigrams(left);
  const rightGrams = toBigrams(right);
  if (leftGrams.size === 0 || rightGrams.size === 0) return 0;
  let overlap = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) overlap += 1;
  }
  const denominator = Math.max(leftGrams.size, rightGrams.size);
  return denominator > 0 ? overlap / denominator : 0;
};

const isGoalBreakdownSkill = (skill: InspirationSkill) => (
  skill.id === GOAL_BREAKDOWN_SKILL_ID || /目标拆解|goal\s*breakdown/i.test(`${skill.id} ${skill.name}`)
);

const REFERENCE_SECTION_REGEX = /((?:##|###)\s*参考来源[^\n]*\n)([\s\S]*?)(?=\n(?:##|###)\s|\n#\s|$)/i;
const URL_IN_TEXT_REGEX = /https?:\/\/[^\s)]+/i;

const splitReferenceEntries = (rawBody: string): string[] => {
  const body = rawBody.replace(/\r/g, '').trim();
  if (!body) return [];

  const markers = Array.from(body.matchAll(/\[S\d+\]/g))
    .map(match => match.index)
    .filter((index): index is number => typeof index === 'number' && index >= 0);

  if (markers.length === 0) {
    return body
      .split('\n')
      .map(line => line.replace(/^\s*[-*]\s*/, '').trim())
      .filter(Boolean);
  }

  const entries: string[] = [];
  for (let i = 0; i < markers.length; i += 1) {
    const start = markers[i];
    const end = i + 1 < markers.length ? markers[i + 1] : body.length;
    const entry = body
      .slice(start, end)
      .replace(/\n+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (entry) entries.push(entry);
  }
  return entries;
};

const normalizeReferenceEntry = (entry: string): string => {
  const compact = entry
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[-–—]\s*$/, '')
    .trim();
  if (!compact) return '';
  if (/\[[^\]]+\]\(https?:\/\/[^)]+\)/i.test(compact)) return compact;

  const matched = compact.match(URL_IN_TEXT_REGEX);
  if (!matched) return compact;

  const rawUrl = matched[0].replace(/[),.;!?。！？、]+$/, '');
  const titlePart = compact
    .slice(0, matched.index)
    .replace(/\s*[|｜]\s*$/, '')
    .trim();

  if (!rawUrl) return compact;
  return titlePart ? `${titlePart} | [${rawUrl}](${rawUrl})` : `[${rawUrl}](${rawUrl})`;
};

const normalizeReferenceSection = (markdown: string): string => (
  markdown.replace(REFERENCE_SECTION_REGEX, (_full, heading: string, body: string) => {
    const entries = splitReferenceEntries(body);
    if (entries.length === 0) return `${heading}${body}`;
    const normalizedBody = entries
      .map(entry => normalizeReferenceEntry(entry))
      .filter(Boolean)
      .map(entry => `- ${entry}`)
      .join('\n');
    return `${heading}${normalizedBody}\n`;
  })
);

const extractSkillOps = (rawText: string): { cleanText: string; payload: Record<string, unknown> | null } => {
  const match = rawText.match(SKILL_OPS_TAG_REGEX);
  if (!match) {
    return { cleanText: rawText.trim(), payload: null };
  }

  const cleanText = rawText.replace(SKILL_OPS_TAG_REGEX, '').trim();
  const payloadText = match[1]?.trim();
  if (!payloadText) {
    return { cleanText, payload: null };
  }

  try {
    const parsed = JSON.parse(payloadText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { cleanText, payload: null };
    }
    return { cleanText, payload: parsed as Record<string, unknown> };
  } catch {
    return { cleanText, payload: null };
  }
};

const normalizeProposedSkill = (raw: unknown, fallbackPrompt: string): ProposedSkillDraft | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const name = toTrimmedString(candidate.name);
  const prompt = toTrimmedString(candidate.prompt) || fallbackPrompt.trim();
  if (!name || !prompt) return null;

  const description = toTrimmedString(candidate.description) || 'AI 学习生成技能';
  const confidenceRaw = Number(candidate.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : undefined;

  return {
    name,
    description,
    prompt,
    scope: parseEnum(candidate.scope, 'current_doc', SKILL_SCOPE_VALUES),
    output: parseEnum(candidate.output, 'plan', SKILL_OUTPUT_VALUES),
    cadence: parseEnum(candidate.cadence, 'manual', SKILL_CADENCE_VALUES),
    risk: parseEnum(candidate.risk, 'low', SKILL_RISK_VALUES),
    confidence,
    rationale: toTrimmedString(candidate.rationale)
  };
};

const toSafeSkillMeta = (value: unknown): SkillMessageMeta | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const meta = value as Record<string, unknown>;
  const usedSkillIds = Array.isArray(meta.usedSkillIds)
    ? meta.usedSkillIds.filter(item => typeof item === 'string' && item.trim().length > 0)
    : [];
  const usedSkillNames = Array.isArray(meta.usedSkillNames)
    ? meta.usedSkillNames.filter(item => typeof item === 'string' && item.trim().length > 0)
    : [];
  const proposedSkill = normalizeProposedSkill(meta.proposedSkill, '');
  const learningStatusRaw = toTrimmedString(meta.learningStatus);
  const learningStatus =
    learningStatusRaw === 'suggested' ||
    learningStatusRaw === 'created' ||
    learningStatusRaw === 'skipped' ||
    learningStatusRaw === 'error'
      ? learningStatusRaw
      : undefined;
  const learningNote = toTrimmedString(meta.learningNote) || undefined;

  if (usedSkillIds.length === 0 && usedSkillNames.length === 0 && !proposedSkill && !learningStatus && !learningNote) {
    return undefined;
  }

  return {
    usedSkillIds: usedSkillIds.length > 0 ? usedSkillIds : undefined,
    usedSkillNames: usedSkillNames.length > 0 ? usedSkillNames : undefined,
    proposedSkill: proposedSkill || undefined,
    learningStatus,
    learningNote
  };
};

type AIWorkflowStudioProps = {
  documents: Document[];
  activeDocId: string | null;
  onSelectDoc: (id: string) => void;
  onCreateDoc: (parentId?: string | null, initialData?: { title?: string; content?: string }) => void;
  onUpdateDoc: (id: string, updates: Partial<Document>) => void;
  onOpenDocumentArea: () => void;
  settings: Settings;
  skills: InspirationSkill[];
  onAddSkill: (skill: InspirationSkill) => void;
  onDeleteSkill: (id: string) => void;
};

const getScopeLabel = (scope: WorkflowScope) => (
  scope === 'knowledge_base' ? '知识库' : scope === 'new_page' ? '新页面' : '当前页面'
);
const getOutputLabel = (output: WorkflowOutput) => (
  output === 'rewrite' ? '内容重写' : output === 'translate' ? '双语翻译' : '目标拆解'
);
const getCadenceLabel = (cadence: WorkflowCadence) => (cadence === 'auto' ? '自动推进' : '手动执行');
const getRiskLabel = (risk: WorkflowRisk) => (risk === 'low' ? '低风险' : risk === 'high' ? '高灵活' : '平衡');

const detectOutput = (text: string): WorkflowOutput => {
  const lower = text.toLowerCase();
  if (/翻译|译文|双语|translate/.test(lower)) return 'translate';
  if (/改写|重写|润色|rewrite/.test(lower)) return 'rewrite';
  return 'plan';
};

const toPlainText = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const escapeHtml = (text: string) => (
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
);
const createDefaultStepRunState = (): StepRunState => ({
  status: 'idle',
  output: '',
  error: null,
  attempts: 0
});
const getStepRunStatusLabel = (status: StepRunStatus) => {
  if (status === 'queued') return '排队中';
  if (status === 'running') return '执行中';
  if (status === 'done') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'skipped') return '已跳过';
  return '未执行';
};

const createWelcomeMessage = (): StudioMessage => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content: '我是 Inspriation AI。你直接说目标和现状，我会帮你规划执行。'
});

type AIBurstIconProps = {
  size?: 'sm' | 'md' | 'lg' | 'xl';
};

function AIBurstIcon({ size = 'sm' }: AIBurstIconProps) {
  const sizeClass =
    size === 'xl'
      ? 'ai-burst-xl'
      : size === 'lg'
        ? 'ai-burst-lg'
        : size === 'md'
          ? 'ai-burst-md'
          : 'ai-burst-sm';
  return (
    <span className={`ai-burst-icon ${sizeClass}`} aria-hidden="true">
      <span className="ai-burst-crack ai-burst-crack1" />
      <span className="ai-burst-crack ai-burst-crack2" />
      <span className="ai-burst-crack ai-burst-crack3" />
      <span className="ai-burst-crack ai-burst-crack4" />
      <span className="ai-burst-crack ai-burst-crack5" />
    </span>
  );
}

export default function AIWorkflowStudio({
  documents,
  activeDocId,
  onSelectDoc,
  onCreateDoc,
  onUpdateDoc,
  onOpenDocumentArea,
  settings,
  skills,
  onAddSkill,
  onDeleteSkill
}: AIWorkflowStudioProps) {
  const availableDocs = useMemo(() => documents.filter(doc => !doc.isDeleted), [documents]);
  const knowledgeBaseDocs = useMemo(
    () => documents.filter(doc => !doc.isDeleted && doc.isInKnowledgeBase),
    [documents]
  );

  const [messages, setMessages] = useState<StudioMessage[]>([createWelcomeMessage()]);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);

  const [scope, setScope] = useState<WorkflowScope>('current_doc');
  const [output, setOutput] = useState<WorkflowOutput>('plan');
  const [cadence, setCadence] = useState<WorkflowCadence>('auto');
  const [risk, setRisk] = useState<WorkflowRisk>('medium');
  const [targetDocId, setTargetDocId] = useState<string | null>(activeDocId);

  const [showSettings, setShowSettings] = useState(false);
  const [showSkillsManager, setShowSkillsManager] = useState(false);
  const [showDraftPanel, setShowDraftPanel] = useState(false);
  const [showChatDocSelector, setShowChatDocSelector] = useState(false);
  const [chatDocFilter, setChatDocFilter] = useState<'kb' | 'all'>('kb');
  const [showUploadMenu, setShowUploadMenu] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<ChatAttachedFile[]>([]);
  const [attachedLinks, setAttachedLinks] = useState<ChatAttachedLink[]>([]);
  const [referencedPageIds, setReferencedPageIds] = useState<string[]>([]);
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [newLinkUrl, setNewLinkUrl] = useState('');
  const [isSearchEnabled, setIsSearchEnabled] = useState(false);
  const [tavilyApiKey, setTavilyApiKey] = useState(() => localStorage.getItem('tavily_api_key') || '');
  const [showApiSettings, setShowApiSettings] = useState(false);
  const [skillLearningMode, setSkillLearningMode] = useState<SkillLearningMode>('confirm');
  const [isSkillEnabled, setIsSkillEnabled] = useState(true);
  const [selectedComposerSkillIds, setSelectedComposerSkillIds] = useState<string[]>([]);

  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [selectedDraftStepIds, setSelectedDraftStepIds] = useState<string[]>([]);
  const [draggingDraftStepId, setDraggingDraftStepId] = useState<string | null>(null);
  const [stepRunState, setStepRunState] = useState<Record<string, StepRunState>>({});
  const [runPhase, setRunPhase] = useState<WorkflowRunPhase>('idle');
  const [lastRunBackup, setLastRunBackup] = useState<DocRunBackup | null>(null);
  const [draftUndoSnapshot, setDraftUndoSnapshot] = useState<DraftUndoSnapshot | null>(null);
  const [isGeneratingDraft, setIsGeneratingDraft] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [canRetryLastRequest, setCanRetryLastRequest] = useState(false);
  const [hasRestoredSession, setHasRestoredSession] = useState(false);
  const [runLogs, setRunLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatFilesInputRef = useRef<HTMLInputElement>(null);
  const chatFolderInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const workflowAbortRef = useRef<AbortController | null>(null);
  const activeAssistantMessageIdRef = useRef<string | null>(null);
  const lastRequestPayloadRef = useRef<{
    systemInstruction: string;
    prompt: string;
    replyContext?: ReplySkillContext;
  } | null>(null);
  const stopStreamingRef = useRef(false);
  const skillsRef = useRef<InspirationSkill[]>(skills);
  const hasUserMessages = useMemo(() => messages.some(m => m.role === 'user'), [messages]);

  useEffect(() => {
    if (activeDocId) setTargetDocId(activeDocId);
  }, [activeDocId]);

  useEffect(() => {
    localStorage.setItem('tavily_api_key', tavilyApiKey);
  }, [tavilyApiKey]);

  useEffect(() => {
    skillsRef.current = skills;
  }, [skills]);

  useEffect(() => {
    setSelectedComposerSkillIds(prev => prev.filter(id => skills.some(skill => skill.id === id)));
  }, [skills]);

  useEffect(() => {
    setReferencedPageIds(prev => prev.filter(id => documents.some(doc => doc.id === id && !doc.isDeleted)));
  }, [documents]);

  useEffect(() => {
    if (!draft) {
      setSelectedDraftStepIds([]);
      setStepRunState({});
      setRunPhase('idle');
      return;
    }
    const stepIds = new Set(draft.steps.map(step => step.id));
    setSelectedDraftStepIds(prev => prev.filter(id => stepIds.has(id)));
    setStepRunState(prev => {
      const next: Record<string, StepRunState> = {};
      for (const step of draft.steps) {
        next[step.id] = prev[step.id] || createDefaultStepRunState();
      }
      return next;
    });
  }, [draft]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isThinking]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STUDIO_SESSION_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PersistedStudioSession;
      const safeMessages = Array.isArray(parsed.messages)
        ? parsed.messages
            .filter(
              item =>
                item &&
                typeof item.id === 'string' &&
                typeof item.content === 'string' &&
                (item.role === 'user' || item.role === 'assistant')
            )
            .map(item => ({
              id: item.id,
              role: item.role,
              content: item.content,
              skillMeta: toSafeSkillMeta(item.skillMeta)
            }))
        : [];
      if (safeMessages.length > 0) {
        setMessages(safeMessages);
      }
      if (typeof parsed.input === 'string') setInput(parsed.input);
      if (parsed.scope) setScope(parsed.scope);
      if (parsed.output) setOutput(parsed.output);
      if (parsed.cadence) setCadence(parsed.cadence);
      if (parsed.risk) setRisk(parsed.risk);
      if (typeof parsed.targetDocId === 'string' || parsed.targetDocId === null) setTargetDocId(parsed.targetDocId);
      if (typeof parsed.isSearchEnabled === 'boolean') setIsSearchEnabled(parsed.isSearchEnabled);
      if (Array.isArray(parsed.referencedPageIds)) setReferencedPageIds(parsed.referencedPageIds);
      if (Array.isArray(parsed.attachedLinks)) setAttachedLinks(parsed.attachedLinks);
      if (parsed.draft && Array.isArray(parsed.draft.steps)) setDraft(parsed.draft);
      if (Array.isArray(parsed.selectedDraftStepIds)) setSelectedDraftStepIds(parsed.selectedDraftStepIds);
      if (parsed.stepRunState && typeof parsed.stepRunState === 'object') setStepRunState(parsed.stepRunState);
      if (parsed.runPhase) setRunPhase(parsed.runPhase);
      if (Array.isArray(parsed.runLogs)) setRunLogs(parsed.runLogs);
      if (parsed.skillLearningMode === 'confirm' || parsed.skillLearningMode === 'auto' || parsed.skillLearningMode === 'off') {
        setSkillLearningMode(parsed.skillLearningMode);
      }
      if (typeof parsed.isSkillEnabled === 'boolean') setIsSkillEnabled(parsed.isSkillEnabled);
      if (Array.isArray(parsed.selectedComposerSkillIds)) {
        setSelectedComposerSkillIds(parsed.selectedComposerSkillIds.filter((id): id is string => typeof id === 'string'));
      }
    } catch (e) {
      console.warn('Restore AI session failed:', e);
    } finally {
      setHasRestoredSession(true);
    }
  }, []);

  // Construct session object for persistence
  const sessionToPersist = useMemo<PersistedStudioSession>(() => ({
    messages,
    input,
    scope,
    output,
    cadence,
    risk,
    targetDocId,
    isSearchEnabled,
    referencedPageIds,
    attachedLinks,
    draft,
    selectedDraftStepIds,
    stepRunState,
    runPhase,
    runLogs,
    skillLearningMode,
    isSkillEnabled,
    selectedComposerSkillIds
  }), [
    messages,
    input,
    scope,
    output,
    cadence,
    risk,
    targetDocId,
    isSearchEnabled,
    referencedPageIds,
    attachedLinks,
    draft,
    selectedDraftStepIds,
    stepRunState,
    runPhase,
    runLogs,
    skillLearningMode,
    isSkillEnabled,
    selectedComposerSkillIds
  ]);

  const debouncedSession = useDebounce(sessionToPersist, 1000);

  useEffect(() => {
    if (!hasRestoredSession) return;
    try {
      localStorage.setItem(STUDIO_SESSION_STORAGE_KEY, JSON.stringify(debouncedSession));
    } catch (e) {
      console.warn('Persist AI session failed:', e);
    }
  }, [debouncedSession, hasRestoredSession]);

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
      workflowAbortRef.current?.abort();
    },
    []
  );

  const callApi = async (
    systemInstruction: string,
    userPrompt: string,
    onChunk?: (chunk: string) => void,
    signal?: AbortSignal
  ) => {
    if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    if (settings.apiProvider === 'gemini' || (!settings.apiUrl && !settings.apiKey)) {
      const apiKey = settings.apiKey || (typeof process !== 'undefined' ? (process as any).env?.GEMINI_API_KEY : '');
      if (!apiKey) throw new Error('未配置 API Key');
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash', systemInstruction });
      if (onChunk) {
        const result = await model.generateContentStream(userPrompt);
        let fullText = '';
        for await (const chunk of result.stream) {
          if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
          const chunkText = chunk.text();
          if (!chunkText) continue;
          fullText += chunkText;
          onChunk(chunkText);
        }
        if (!fullText) {
          const finalResponse = await result.response;
          fullText = finalResponse.text() || '';
          if (fullText) onChunk(fullText);
        }
        return fullText;
      }
      const result = await model.generateContent(userPrompt);
      return result.response.text() || '';
    }

    const cleanUrl = settings.apiUrl.replace(/\/+$/, '');
    const response = await fetch(`${cleanUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: settings.selectedModel || 'default',
        stream: !!onChunk,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt }
        ]
      })
    });
    if (!response.ok) throw new Error(`API Error: ${response.status}`);

    if (onChunk && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      let fullText = '';

      while (true) {
        if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payload);
            const content = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.message?.content || '';
            if (!content) continue;
            fullText += content;
            onChunk(content);
          } catch {
            // Ignore non-JSON SSE lines.
          }
        }
      }

      if (fullText) return fullText;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (onChunk && content) onChunk(content);
    return content;
  };

  const availableReferenceDocs = useMemo(
    () => documents.filter(doc => !doc.isDeleted && (chatDocFilter === 'all' || doc.isInKnowledgeBase)),
    [documents, chatDocFilter]
  );

  const linkStatus = useMemo(() => {
    const total = attachedLinks.length;
    const done = attachedLinks.filter(link => link.status === 'done').length;
    const loading = attachedLinks.filter(link => link.status === 'loading').length;
    const errorCount = attachedLinks.filter(link => link.status === 'error').length;
    return { total, done, loading, errorCount };
  }, [attachedLinks]);

  const selectedComposerSkills = useMemo(() => {
    if (selectedComposerSkillIds.length === 0) return [];
    const selectedIdSet = new Set(selectedComposerSkillIds);
    return skills.filter(skill => selectedIdSet.has(skill.id));
  }, [skills, selectedComposerSkillIds]);

  const workflowStepStats = useMemo(() => {
    const list = Object.values(stepRunState);
    return {
      done: list.filter(item => item.status === 'done').length,
      failed: list.filter(item => item.status === 'failed').length,
      running: list.filter(item => item.status === 'running').length
    };
  }, [stepRunState]);

  const persistLearnedSkill = (draft: ProposedSkillDraft) => {
    const safeName = draft.name.trim();
    const safePrompt = draft.prompt.trim();
    if (!safeName || !safePrompt) {
      return { status: 'error' as const, note: '技能草案缺少名称或提示词。' };
    }

    const signature = normalizeSignature(safeName, safePrompt);
    const existing = skillsRef.current.find(skill => (
      normalizeSignature(skill.name, skill.prompt) === signature ||
      skill.name.trim().toLowerCase() === safeName.toLowerCase()
    ));

    if (existing) {
      return {
        status: 'skipped' as const,
        note: `技能已存在：${existing.name}`,
        skill: existing
      };
    }

    const nextSkill: InspirationSkill = {
      id: createLearnedSkillId(),
      name: safeName,
      description: draft.description.trim() || 'AI 学习生成技能',
      prompt: safePrompt,
      scope: draft.scope,
      output: draft.output,
      cadence: draft.cadence,
      risk: draft.risk
    };
    onAddSkill(nextSkill);
    skillsRef.current = [...skillsRef.current, nextSkill];
    return {
      status: 'created' as const,
      note: `已创建技能：${nextSkill.name}`,
      skill: nextSkill
    };
  };

  const resolveUsedSkillHints = (
    payload: Record<string, unknown> | null,
    replyContext?: ReplySkillContext
  ): { ids: string[]; names: string[] } => {
    const allHints = [
      ...toHintList(payload?.used_skill_ids),
      ...toHintList(payload?.usedSkillIds),
      ...toHintList(payload?.used_skill_names),
      ...toHintList(payload?.usedSkillNames),
      ...toHintList(payload?.used_skills),
      ...toHintList(payload?.usedSkills)
    ];

    const collected = new Map<string, InspirationSkill>();
    for (const skill of resolveSkillsByHints(allHints, skillsRef.current)) {
      collected.set(skill.id, skill);
    }

    for (const skill of replyContext?.invokedSkills || []) {
      collected.set(skill.id, skill);
    }

    return {
      ids: Array.from(collected.values()).map(skill => skill.id),
      names: Array.from(collected.values()).map(skill => skill.name)
    };
  };

  const resolveAssistantSkillMeta = (assistantRawText: string, replyContext?: ReplySkillContext) => {
    const { cleanText, payload } = extractSkillOps(assistantRawText);
    const normalizedText = normalizeReferenceSection(cleanText);
    const usedSkills = resolveUsedSkillHints(payload, replyContext);
    const proposedRaw = payload?.proposed_skill ?? payload?.proposedSkill;
    const proposedSkill = normalizeProposedSkill(proposedRaw, replyContext?.baseMessage || '');
    const meta: SkillMessageMeta = {};

    if (usedSkills.ids.length > 0) {
      meta.usedSkillIds = usedSkills.ids;
      meta.usedSkillNames = usedSkills.names;
    }

    if (proposedSkill) {
      meta.proposedSkill = proposedSkill;
      if (skillLearningMode === 'off') {
        meta.learningStatus = 'skipped';
        meta.learningNote = '已识别可学习技能，当前模式为关闭。';
      } else if (skillLearningMode === 'auto') {
        const score = proposedSkill.confidence ?? 0.72;
        if (score < 0.62) {
          meta.learningStatus = 'skipped';
          meta.learningNote = `置信度 ${(score * 100).toFixed(0)}%，低于自动学习阈值。`;
        } else {
          const persisted = persistLearnedSkill(proposedSkill);
          meta.learningStatus = persisted.status;
          meta.learningNote = persisted.note;
          if (persisted.skill) {
            const ids = new Set(meta.usedSkillIds || []);
            const names = new Set(meta.usedSkillNames || []);
            ids.add(persisted.skill.id);
            names.add(persisted.skill.name);
            meta.usedSkillIds = Array.from(ids);
            meta.usedSkillNames = Array.from(names);
          }
        }
      } else {
        meta.learningStatus = 'suggested';
        meta.learningNote = proposedSkill.confidence !== undefined
          ? `建议保存技能（置信度 ${(proposedSkill.confidence * 100).toFixed(0)}%）。`
          : '建议保存此技能以便下次复用。';
      }
    }

    const hasMeta = !!(
      (meta.usedSkillIds && meta.usedSkillIds.length > 0) ||
      meta.proposedSkill ||
      meta.learningStatus ||
      meta.learningNote
    );

    return {
      cleanText: normalizedText,
      meta: hasMeta ? meta : undefined
    };
  };

  const confirmProposedSkillFromMessage = (messageId: string) => {
    const target = messages.find(msg => msg.id === messageId && msg.role === 'assistant');
    const proposed = target?.skillMeta?.proposedSkill;
    if (!proposed) return;

    const persisted = persistLearnedSkill(proposed);
    setMessages(prev =>
      prev.map(msg => {
        if (msg.id !== messageId || msg.role !== 'assistant') return msg;
        const nextMeta: SkillMessageMeta = {
          ...(msg.skillMeta || {}),
          learningStatus: persisted.status,
          learningNote: persisted.note
        };
        if (persisted.skill) {
          const ids = new Set(nextMeta.usedSkillIds || []);
          const names = new Set(nextMeta.usedSkillNames || []);
          ids.add(persisted.skill.id);
          names.add(persisted.skill.name);
          nextMeta.usedSkillIds = Array.from(ids);
          nextMeta.usedSkillNames = Array.from(names);
        }
        return { ...msg, skillMeta: nextMeta };
      })
    );
  };

  const handleTavilySearch = async (query: string) => {
    if (!tavilyApiKey) {
      setShowApiSettings(true);
      setError('请先配置 Tavily API Key 才能开启联网搜索。');
      return null;
    }

    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyApiKey,
          query,
          search_depth: 'advanced',
          include_answer: true,
          max_results: 5
        })
      });

      if (!response.ok) throw new Error('联网搜索服务不可用');
      return await response.json();
    } catch (e) {
      console.error('Tavily search error:', e);
      setError('联网搜索失败，请稍后重试或检查 API Key。');
      return null;
    }
  };

  const fetchLinkContent = async (safeUrl: string) => {
    try {
      const response = await fetch(`https://r.jina.ai/${safeUrl}`, {
        headers: { 'X-Return-Format': 'markdown' }
      });
      if (!response.ok) throw new Error(`抓取状态 ${response.status}`);
      const content = await response.text();
      const titleMatch = content.match(/^# (.*)/m);
      const title = titleMatch ? titleMatch[1] : safeUrl;
      setAttachedLinks(prev =>
        prev.map(link => (link.url === safeUrl ? { ...link, content, title, status: 'done', error: undefined } : link))
      );
    } catch (e) {
      console.error('Link fetch error:', e);
      setAttachedLinks(prev =>
        prev.map(link =>
          link.url === safeUrl
            ? {
                ...link,
                status: 'error',
                error: '网页抓取失败，建议重试或直接发送链接让 AI 基于 URL 给出建议。'
              }
            : link
        )
      );
      setError('有网页链接抓取失败，可点击重试，或直接发送让 AI 先处理。');
    }
  };

  const handleAddLink = async (url: string) => {
    const safeUrl = url.trim();
    if (!safeUrl || !/^https?:\/\//i.test(safeUrl)) {
      setError('请输入有效网页链接（http:// 或 https://）。');
      return;
    }

    if (attachedLinks.some(link => link.url === safeUrl)) {
      setError('该网页链接已添加。');
      return;
    }

    setError(null);
    setAttachedLinks(prev => [...prev, { url: safeUrl, status: 'loading' }]);
    setShowLinkInput(false);
    setNewLinkUrl('');

    await fetchLinkContent(safeUrl);
  };

  const retryLinkFetch = async (url: string) => {
    setError(null);
    setAttachedLinks(prev =>
      prev.map(link => (link.url === url ? { ...link, status: 'loading', error: undefined } : link))
    );
    await fetchLinkContent(url);
  };

  const handleChatFileUpload = async (files: FileList | null, source: 'files' | 'folder') => {
    if (!files || files.length === 0) return;
    const maxFiles = 50;
    const maxFileSizeBytes = 2 * 1024 * 1024;
    const maxTotalSizeBytes = 12 * 1024 * 1024;
    const collectedFiles: Array<{ name: string; content: string }> = [];
    let collectedBytes = 0;
    let skippedByType = 0;
    let skippedBySize = 0;
    let skippedByTotalSize = 0;

    for (let i = 0; i < files.length; i += 1) {
      if (collectedFiles.length >= maxFiles) break;
      const file = files[i];
      if (file.size > maxFileSizeBytes) {
        skippedBySize += 1;
        continue;
      }
      if (collectedBytes + file.size > maxTotalSizeBytes) {
        skippedByTotalSize += 1;
        continue;
      }
      const isTextFile =
        file.type.startsWith('text/') ||
        /\.(md|txt|js|ts|tsx|jsx|json|css|html|py|java|c|cpp|go|rs|rb|php|sql|yaml|yml|toml)$/i.test(file.name);
      if (!isTextFile) {
        skippedByType += 1;
        continue;
      }

      try {
        const content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsText(file);
        });
        const pathName = (((file as any).webkitRelativePath as string) || file.name).replace(/\\/g, '/');
        collectedFiles.push({ name: pathName, content });
        collectedBytes += file.size;
      } catch (e) {
        console.error('Read file failed:', file.name, e);
      }
    }

    if (collectedFiles.length === 0) {
      const tips = [
        skippedByType > 0 ? '仅支持文本类文件' : '',
        skippedBySize > 0 ? '单文件最大 2MB' : '',
        skippedByTotalSize > 0 ? '本次上传总计最大 12MB' : ''
      ]
        .filter(Boolean)
        .join('；');
      setError(tips ? `未读取到可分析文件（${tips}）。` : '未读取到可分析的文本文件。');
      return;
    }

    if (source === 'folder') {
      const firstPath = collectedFiles[0].name;
      const folderName = firstPath.includes('/') ? firstPath.split('/')[0] : '上传文件夹';
      setAttachedFiles(prev => [
        ...prev,
        {
          id: crypto.randomUUID(),
          name: folderName,
          type: 'folder',
          files: collectedFiles
        }
      ]);
    } else {
      setAttachedFiles(prev => [
        ...prev,
        ...collectedFiles.map(file => ({
          id: crypto.randomUUID(),
          name: file.name,
          type: 'file' as const,
          content: file.content
        }))
      ]);
    }

    const warnings = [
      files.length > maxFiles ? `已截取前 ${maxFiles} 个文件` : '',
      skippedByType > 0 ? `跳过 ${skippedByType} 个非文本文件` : '',
      skippedBySize > 0 ? `跳过 ${skippedBySize} 个超 2MB 文件` : '',
      skippedByTotalSize > 0 ? `超出总量限制，跳过 ${skippedByTotalSize} 个文件` : ''
    ].filter(Boolean);
    if (warnings.length > 0) {
      setError(warnings.join('；'));
    } else {
      setError(null);
    }
  };

  const streamAssistantReply = async (
    assistantMessageId: string,
    systemInstruction: string,
    prompt: string,
    replyContext?: ReplySkillContext
  ) => {
    setIsThinking(true);
    setError(null);
    setCanRetryLastRequest(false);

    const controller = new AbortController();
    abortControllerRef.current = controller;
    activeAssistantMessageIdRef.current = assistantMessageId;
    stopStreamingRef.current = false;

    try {
      let receivedChunk = false;
      const response = await callApi(
        systemInstruction,
        prompt,
        chunk => {
          if (controller.signal.aborted || stopStreamingRef.current) return;
          receivedChunk = true;
          setMessages(prev =>
            prev.map(msg => (msg.id === assistantMessageId ? { ...msg, content: `${msg.content}${chunk}` } : msg))
          );
        },
        controller.signal
      );

      const { cleanText, meta } = resolveAssistantSkillMeta(response || '', replyContext);

      if (!receivedChunk && !stopStreamingRef.current) {
        const fallbackText = cleanText || '我已经收到你的资源和问题。要不要我先给出执行建议？';
        setMessages(prev =>
          prev.map(msg =>
            msg.id === assistantMessageId
              ? {
                  ...msg,
                  content: fallbackText,
                  skillMeta: meta
                }
              : msg
          )
        );
      } else if (!stopStreamingRef.current) {
        setMessages(prev =>
          prev.map(msg =>
            msg.id === assistantMessageId
              ? {
                  ...msg,
                  content: cleanText || msg.content,
                  skillMeta: meta
                }
              : msg
          )
        );
      }
      setCanRetryLastRequest(false);
    } catch (e: any) {
      const isAbort = controller.signal.aborted || stopStreamingRef.current || e?.name === 'AbortError';
      if (isAbort) {
        setMessages(prev =>
          prev.map(msg =>
            msg.id === assistantMessageId
              ? {
                  ...msg,
                  content: msg.content
                    ? `${msg.content}\n\n> 已中断本次回复，可点击“重试上次”继续。`
                    : '已中断本次回复，可点击“重试上次”继续。'
                }
              : msg
          )
        );
        setError('已中断当前回复，可点击“重试上次”。');
      } else {
        const errText = `调用失败：${e?.message || '未知错误'}。`;
        setMessages(prev => {
          let matched = false;
          const next = prev.map(msg => {
            if (msg.id === assistantMessageId) {
              matched = true;
              return { ...msg, content: errText };
            }
            return msg;
          });
          return matched ? next : [...next, { id: assistantMessageId, role: 'assistant', content: errText }];
        });
        setError(errText);
      }
      setCanRetryLastRequest(true);
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
      if (activeAssistantMessageIdRef.current === assistantMessageId) activeAssistantMessageIdRef.current = null;
      stopStreamingRef.current = false;
      setIsThinking(false);
    }
  };

  const stopStreamingReply = () => {
    if (!isThinking) return;
    stopStreamingRef.current = true;
    abortControllerRef.current?.abort();
  };

  const retryLastRequest = async () => {
    if (isThinking || !lastRequestPayloadRef.current) return;
    const assistantMessageId = crypto.randomUUID();
    setMessages(prev => [...prev, { id: assistantMessageId, role: 'assistant', content: '' }]);
    await streamAssistantReply(
      assistantMessageId,
      lastRequestPayloadRef.current.systemInstruction,
      lastRequestPayloadRef.current.prompt,
      lastRequestPayloadRef.current.replyContext
    );
  };

  const applyRoutingPreferences = (selectedSkills: InspirationSkill[]) => {
    if (selectedSkills.length === 0) return;
    const primary = selectedSkills[0];
    setScope(primary.scope);
    setOutput(primary.output);
    setCadence(selectedSkills.some(skill => skill.cadence === 'auto') ? 'auto' : 'manual');
    setRisk(
      selectedSkills.some(skill => skill.risk === 'high')
        ? 'high'
        : selectedSkills.some(skill => skill.risk === 'medium')
          ? 'medium'
          : 'low'
    );
  };

  const selectSkillsBySimilarity = (text: string, catalog: InspirationSkill[]): InspirationSkill[] => {
    if (!text.trim() || catalog.length === 0) return [];
    const ranked = catalog
      .map(skill => {
        const profile = [
          skill.name,
          skill.description,
          skill.prompt,
          skill.scope,
          skill.output,
          skill.cadence,
          skill.risk
        ].join('\n');
        return {
          skill,
          score: scoreTextSimilarity(text, profile)
        };
      })
      .sort((a, b) => b.score - a.score);

    if (ranked.length === 0 || ranked[0].score < 0.05) return [];
    const threshold = Math.max(0.05, ranked[0].score * 0.62);
    return ranked
      .filter(item => item.score >= threshold)
      .slice(0, 3)
      .map(item => item.skill);
  };

  const hasExplicitPlanningCue = (text: string) => {
    const cues = [
      '目标拆解',
      '拆成步骤',
      '拆解',
      '里程碑',
      '行动项',
      '任务分解',
      '执行计划',
      '路线图',
      'roadmap',
      'breakdown',
      'plan',
      'next actions'
    ];
    const normalized = text.toLowerCase();
    return cues.some(cue => normalized.includes(cue.toLowerCase()));
  };

  const isDirectQaStyleRequest = (text: string) => {
    const compact = text.replace(/\s+/g, '');
    const qaSignals = /是什么|为什么|多少|谁|哪里|何时|怎么回事|能不能|可以吗|吗\?|吗？|\?$|？$/i;
    return compact.length <= 56 && qaSignals.test(compact);
  };

  const planningIntentScore = (text: string) => {
    const planningProfile = '目标拆解 里程碑 执行计划 roadmap 分阶段 行动清单 任务分解 优先级 next actions';
    return scoreTextSimilarity(text, planningProfile);
  };

  const pruneOverTriggeredSkills = (text: string, selectedSkills: InspirationSkill[]): InspirationSkill[] => {
    if (selectedSkills.length === 0) return selectedSkills;
    const hasPlanCue = hasExplicitPlanningCue(text);
    const planScore = planningIntentScore(text);
    const isQaRequest = isDirectQaStyleRequest(text);

    return selectedSkills.filter(skill => {
      if (!isGoalBreakdownSkill(skill)) return true;
      if (hasPlanCue) return true;
      if (selectedSkills.length === 1) {
        return planScore >= 0.17 && !isQaRequest;
      }
      return planScore >= 0.12 && !isQaRequest;
    });
  };

  const shouldEnableSearchFromSimilarity = (text: string, selectedSkills: InspirationSkill[]) => {
    const searchIntentProfile = '联网搜索 web search latest current update 实时 调研 新闻 行情 价格';
    const requestScore = scoreTextSimilarity(text, searchIntentProfile);
    const skillScore = selectedSkills.reduce((maxScore, skill) => {
      const profile = `${skill.name}\n${skill.description}\n${skill.prompt}`;
      return Math.max(maxScore, scoreTextSimilarity(profile, searchIntentProfile));
    }, 0);
    return requestScore >= 0.1 || skillScore >= 0.2;
  };

  const detectIntentAndSelectSkills = async (text: string): Promise<SkillRoutingResult> => {
    const safeText = text.trim();
    if (!safeText || skills.length === 0) {
      return { skills: [], autoSearch: false };
    }

    const skillCatalog = skills
      .map(
        skill =>
          `id=${skill.id}; name=${skill.name}; desc=${skill.description}; scope=${skill.scope}; output=${skill.output}; cadence=${skill.cadence}; risk=${skill.risk}; prompt=${skill.prompt.slice(0, 420)}`
      )
      .join('\n');

    try {
      const routerSystemInstruction = `You are a semantic router for an AI workspace assistant.
Return strict JSON only. No markdown.
Schema:
{"selected_skill_ids":[],"enable_web_search":false}
Rules:
1) Select 0-3 skills from the catalog, in priority order.
2) Prefer semantic understanding over literal keyword matching.
3) Multiple skills are allowed when they complement each other.
4) If no skill fits, return an empty selected_skill_ids array.
5) enable_web_search is true only when the request needs fresh external information.
6) Do NOT select goal_breakdown for direct Q&A, explanation, fact lookup, or short troubleshooting requests. Use it only when user explicitly asks for planning/decomposition/roadmap/action breakdown.`;
      const routerPrompt = `SKILLS CATALOG:
${skillCatalog}

USER REQUEST:
${safeText}

Return JSON only.`;
      const routingController = new AbortController();
      const timeoutId = window.setTimeout(() => {
        routingController.abort();
      }, SKILL_ROUTER_TIMEOUT_MS);
      let rawRouting = '';
      try {
        rawRouting = await callApi(routerSystemInstruction, routerPrompt, undefined, routingController.signal);
      } finally {
        window.clearTimeout(timeoutId);
      }
      const payload = parseJsonObject(rawRouting || '');
      if (payload) {
        const hints = [
          ...toHintList(payload.selected_skill_ids),
          ...toHintList(payload.selectedSkillIds),
          ...toHintList(payload.selected_skills),
          ...toHintList(payload.selectedSkills),
          ...toHintList(payload.skill_ids),
          ...toHintList(payload.skillIds),
          ...toHintList(payload.skills)
        ];
        const routedSkills = pruneOverTriggeredSkills(safeText, resolveSkillsByHints(hints, skills).slice(0, 3));
        const autoSearch =
          parseBooleanLike(payload.enable_web_search) ??
          parseBooleanLike(payload.enableWebSearch) ??
          parseBooleanLike(payload.auto_search) ??
          parseBooleanLike(payload.autoSearch) ??
          parseBooleanLike(payload.need_web_search) ??
          parseBooleanLike(payload.needWebSearch) ??
          false;

        if (routedSkills.length > 0 || autoSearch) {
          return { skills: routedSkills, autoSearch };
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        console.warn('Skill routing with model failed, using similarity fallback.', e);
      }
    }

    const fallbackSkills = pruneOverTriggeredSkills(safeText, selectSkillsBySimilarity(safeText, skills));
    return {
      skills: fallbackSkills,
      autoSearch: shouldEnableSearchFromSimilarity(safeText, fallbackSkills)
    };
  };

  const sendMessage = async (
    preset?: string,
    options?: { invokedSkills?: InspirationSkill[]; invokedSkill?: InspirationSkill }
  ) => {
    if (isThinking) return;
    const text = (preset ?? input).trim();

    const filesToInclude = [...attachedFiles];
    const linksToInclude = attachedLinks.filter(link => link.status !== 'loading');
    const referencedPages = documents.filter(doc => referencedPageIds.includes(doc.id) && !doc.isDeleted);
    const hasManualSkillSelection = !!(
      (options?.invokedSkills && options.invokedSkills.length > 0) ||
      options?.invokedSkill
    );
    if (!text && filesToInclude.length === 0 && linksToInclude.length === 0 && referencedPages.length === 0 && !hasManualSkillSelection) return;

    setInput('');
    setError(null);
    setShowLinkInput(false);
    setShowChatDocSelector(false);
    setShowUploadMenu(false);

    const baseMessage = text || '请根据我提供的资源给出回答。';
    let autoSelectedSkills = isSkillEnabled
      ? [...(options?.invokedSkills || (options?.invokedSkill ? [options.invokedSkill] : []))]
      : [];
    let autoSearchEnabled = isSearchEnabled;
    const buildDisplayMessage = (selectedSkills: InspirationSkill[], searchEnabled: boolean) => {
      const indicatorParts = [
        referencedPages.length > 0 ? `引用 ${referencedPages.length} 个页面` : '',
        filesToInclude.length > 0 ? `上传 ${filesToInclude.length} 个文件资源` : '',
        linksToInclude.length > 0 ? `网页 ${linksToInclude.filter(link => link.status === 'done').length}/${linksToInclude.length}` : '',
        searchEnabled ? '联网搜索' : '',
        !isSkillEnabled ? '技能关闭' : '',
        isSkillEnabled && selectedSkills.length > 0 ? `智能调用技能：${selectedSkills.map(skill => skill.name).join(' + ')}` : ''
      ].filter(Boolean);
      return indicatorParts.length > 0 ? `${baseMessage} (${indicatorParts.join('，')})` : baseMessage;
    };

    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    let displayMessage = buildDisplayMessage(autoSelectedSkills, autoSearchEnabled);
    let userMessage: StudioMessage = { id: userMessageId, role: 'user', content: displayMessage };
    let historySource = [...messages, userMessage];
    setMessages([...historySource, { id: assistantMessageId, role: 'assistant', content: '' }]);

    if (isSkillEnabled && !preset && autoSelectedSkills.length === 0 && text) {
      const detection = await detectIntentAndSelectSkills(text);
      if (detection.skills.length > 0) {
        autoSelectedSkills = detection.skills;
        applyRoutingPreferences(autoSelectedSkills);
      }
      if (detection.autoSearch) {
        autoSearchEnabled = true;
      }
    }

    if (isSkillEnabled && !autoSearchEnabled && autoSelectedSkills.length > 0) {
      const inferredSearch = shouldEnableSearchFromSimilarity(text || preset || '', autoSelectedSkills);
      if (inferredSearch) {
        autoSearchEnabled = true;
      }
    }
    if (autoSearchEnabled !== isSearchEnabled) setIsSearchEnabled(autoSearchEnabled);

    const finalDisplayMessage = buildDisplayMessage(autoSelectedSkills, autoSearchEnabled);
    if (finalDisplayMessage !== displayMessage) {
      displayMessage = finalDisplayMessage;
      userMessage = { ...userMessage, content: displayMessage };
      historySource = [...messages, userMessage];
      setMessages(prev =>
        prev.map(msg => (msg.id === userMessageId && msg.role === 'user' ? { ...msg, content: displayMessage } : msg))
      );
    }

    const replyContext: ReplySkillContext = {
      baseMessage,
      invokedSkills: isSkillEnabled && autoSelectedSkills.length > 0 ? autoSelectedSkills : undefined
    };

    setAttachedFiles([]);
    setAttachedLinks([]);
    setReferencedPageIds([]);

    try {
      let messageContent = baseMessage;
      const contexts: string[] = [];
      const sourceCatalog: Array<{ id: string; title: string; hint: string }> = [];
      let sourceIndex = 1;
      const nextSourceId = () => `S${sourceIndex++}`;

      // 多技能并用：统一前置技能指令，避免互相覆盖
      if (isSkillEnabled && autoSelectedSkills.length > 0) {
        const mergedSkillInstruction = autoSelectedSkills
          .map((skill, index) => `${index + 1}. ${skill.name}: ${skill.prompt}`)
          .join('\n');
        messageContent = `请综合应用以下技能（可并用，不要重复输出）：\n${mergedSkillInstruction}\n\n用户原始请求：${messageContent}`;
      }

      if (referencedPages.length > 0) {
        contexts.push(
          `[Referenced Workspace Pages]:\n${referencedPages
            .map(doc => {
              const sourceId = nextSourceId();
              sourceCatalog.push({ id: sourceId, title: doc.title || '无标题页面', hint: '工作区页面引用' });
              return `--- [${sourceId}] PAGE: ${doc.title || '无标题'} ---\n${toPlainText(doc.content).slice(0, 5000)}`;
            })
            .join('\n\n')}`
        );
      }

      if (filesToInclude.length > 0) {
        const fileContexts = filesToInclude.map(item => {
          if (item.type === 'folder' && item.files) {
            const sourceId = nextSourceId();
            sourceCatalog.push({ id: sourceId, title: item.name, hint: `文件夹，共 ${item.files.length} 个文件` });
            return `--- [${sourceId}] FOLDER: ${item.name} ---\n${item.files
              .map(file => `[File: ${file.name}]\n${file.content}`)
              .join('\n\n')}`;
          }
          const sourceId = nextSourceId();
          sourceCatalog.push({ id: sourceId, title: item.name, hint: '上传文件' });
          return `--- [${sourceId}] FILE: ${item.name} ---\n${item.content || ''}`;
        });
        contexts.push(`[Attached Files & Folders Context]:\n${fileContexts.join('\n\n---\n\n')}`);
      }

      if (linksToInclude.length > 0) {
        contexts.push(
          `[Attached Web Content Context]:\n${linksToInclude
            .map(link => {
              const sourceId = nextSourceId();
              sourceCatalog.push({
                id: sourceId,
                title: link.title || link.url,
                hint: link.status === 'done' ? '网页链接抓取成功' : '网页抓取失败，仅提供 URL'
              });
              const linkBody =
                link.status === 'done'
                  ? link.content || ''
                  : `抓取失败：${link.error || '请结合 URL 语义先给建议，并提示用户稍后重试。'}`;
              return `--- [${sourceId}] URL: ${link.url} (Title: ${link.title || link.url}) ---\n${linkBody}`;
            })
            .join('\n\n')}`
        );
      }

      if (contexts.length > 0) {
        messageContent = `${messageContent}\n\nRESOURCE CONTEXT:\n${contexts.join('\n\n---\n\n')}`;
      }

      let searchInstruction = '';
      if (autoSearchEnabled) {
        const searchData = await handleTavilySearch(baseMessage);
        if (searchData?.results?.length) {
          const searchContext = `[Web Search Results]:\n${searchData.results
            .map((result: any) => {
              const sourceId = nextSourceId();
              sourceCatalog.push({ id: sourceId, title: result.title || result.url, hint: result.url || '联网搜索' });
              return `--- [${sourceId}] SOURCE: ${result.title} (${result.url}) ---\n${result.content}`;
            })
            .join('\n\n')}`;
          messageContent = `${messageContent}\n\nWEB SEARCH CONTEXT:\n${searchContext}`;
          searchInstruction =
            "\n\nCRITICAL: Web search is ENABLED. You MUST prioritize the information in 'WEB SEARCH CONTEXT'. If conflict exists, trust web search context.";
        }
      }

      const historyContext = historySource
        .slice(-10)
        .map(item => `${item.role === 'user' ? '用户' : 'AI'}: ${item.content}`)
        .join('\n');
      const sourceCatalogText = sourceCatalog.length
        ? sourceCatalog.map(source => `[${source.id}] ${source.title} | ${source.hint}`).join('\n')
        : '无外部来源';
      const skillsCatalogText = isSkillEnabled && skills.length > 0
        ? skills
            .map(skill => (
              `- id=${skill.id}; name=${skill.name}; scope=${skill.scope}; output=${skill.output}; cadence=${skill.cadence}; risk=${skill.risk}; desc=${skill.description}; prompt=${skill.prompt.slice(0, 260)}`
            ))
            .join('\n')
        : isSkillEnabled
          ? '无可用技能'
          : '技能开关关闭（忽略全部技能）';

      const systemInstruction = `Today's Date: ${new Date().toLocaleDateString()}
You are Inspriation AI, a workspace assistant.
Rules:
1) Always reply in Chinese.
2) Keep scope tight. Solve only what user asked, do not over-perform.
3) Be concise, practical, and clear.
4) Prioritize provided context from files/pages/links.
5) If context is insufficient, ask only one focused follow-up question.
6) Never fabricate facts, URLs, or source ids.
7) If source catalog exists, cite source ids like [S1], [S2] in key claims and reference list.
8) If sources conflict, explicitly state uncertainty and give a verification path.
9) Use Markdown with this structure:
   ## 结论摘要
   ## 可执行步骤
   ## 风险与注意
   ## 参考来源
10) SKILL SWITCH: ${isSkillEnabled ? 'ON' : 'OFF'}.
11) If SKILL SWITCH is ON, you may combine multiple skills and record ALL used skill ids/names in skill_ops arrays.
12) If SKILL SWITCH is OFF, do NOT apply any skill and always set used_skill_ids/used_skill_names to empty arrays, proposed_skill to null.
13) Append exactly one machine-readable tail tag at the end (not in code block):
<skill_ops>{"used_skill_ids":[],"used_skill_names":[],"proposed_skill":null}</skill_ops>
14) proposed_skill should be an object only when a reusable new skill is clearly valuable.
15) proposed_skill object format:
{"name":"","description":"","prompt":"","scope":"current_doc|knowledge_base|new_page","output":"plan|rewrite|translate","cadence":"manual|auto","risk":"low|medium|high","confidence":0.0,"rationale":""}
16) In section "## 参考来源", output one source per bullet line, e.g. "- [S1] 标题 | [https://example.com](https://example.com)".` + searchInstruction;
      const preference = `偏好：范围=${getScopeLabel(scope)}；输出=${getOutputLabel(output)}；节奏=${getCadenceLabel(cadence)}；风险=${getRiskLabel(risk)}。`;
      const learningModeLabel =
        skillLearningMode === 'auto' ? '自动保存' : skillLearningMode === 'off' ? '关闭' : '确认后保存';
      const prompt =
        `${preference}\n` +
        `SKILLS SWITCH: ${isSkillEnabled ? 'ON' : 'OFF'}\n` +
        `SKILL LEARNING MODE: ${learningModeLabel}\n` +
        `SKILLS CATALOG:\n${skillsCatalogText}\n` +
        `SOURCE CATALOG:\n${sourceCatalogText}\n` +
        `${historyContext ? `${historyContext}\n` : ''}` +
        `用户最新请求：${messageContent}`;

      lastRequestPayloadRef.current = { systemInstruction, prompt, replyContext };
      await streamAssistantReply(assistantMessageId, systemInstruction, prompt, replyContext);
    } catch (e: any) {
      const errText = `调用失败：${e?.message || '未知错误'}。`;
      setMessages(prev =>
        prev.map(msg => (msg.id === assistantMessageId ? { ...msg, content: errText } : msg))
      );
      setError(errText);
      setCanRetryLastRequest(false);
      setIsThinking(false);
    }
  };

  const buildDraftFromChat = async () => {
    if (!hasUserMessages || isGeneratingDraft) return;
    setIsGeneratingDraft(true);
    setError(null);
    setRunLogs([]);

    try {
      const userTexts = messages.filter(m => m.role === 'user').map(m => m.content).join('；');
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')?.content || '';
      const inferredOutput = detectOutput(userTexts);
      const finalOutput = output || inferredOutput;
      const lines = lastAssistant
        .split('\n')
        .map(line => line.replace(/^[-*]\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 5);
      const steps = (lines.length > 0
        ? lines
        : [
            '对话澄清目标和约束',
            `锁定作用范围：${getScopeLabel(scope)}`,
            `锁定输出重心：${getOutputLabel(finalOutput)}`,
            `选择执行节奏：${getCadenceLabel(cadence)}`,
            `设定风险阈值：${getRiskLabel(risk)}`
          ]
      ).map((line, idx) => ({
        id: `step-${idx}`,
        title: line.length > 24 ? `${line.slice(0, 24)}...` : line,
        detail: line
      }));

      const nextDraft: WorkflowDraft = {
        id: `draft-${Date.now()}`,
        goal: userTexts.slice(0, 160),
        summary: lastAssistant.slice(0, 180) || '根据对话自动生成执行草案',
        scope,
        output: finalOutput,
        cadence,
        risk,
        targetDocId: scope === 'current_doc' ? (targetDocId || activeDocId || null) : null,
        steps,
        runCount: 0
      };

      setDraft(nextDraft);
      setSelectedDraftStepIds(nextDraft.steps.map(step => step.id));
      setStepRunState(
        Object.fromEntries(nextDraft.steps.map(step => [step.id, createDefaultStepRunState()])) as Record<
          string,
          StepRunState
        >
      );
      setDraftUndoSnapshot(null);
      setRunPhase('idle');
      setLastRunBackup(null);
      setShowDraftPanel(true);
    } finally {
      setIsGeneratingDraft(false);
    }
  };

  const toggleDraftStepSelection = (stepId: string) => {
    setSelectedDraftStepIds(prev => (
      prev.includes(stepId) ? prev.filter(id => id !== stepId) : [...prev, stepId]
    ));
  };

  const reorderDraftSteps = (fromStepId: string, toStepId: string) => {
    if (fromStepId === toStepId) return;
    setDraft(prev => {
      if (!prev) return prev;
      const fromIndex = prev.steps.findIndex(step => step.id === fromStepId);
      const toIndex = prev.steps.findIndex(step => step.id === toStepId);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const nextSteps = [...prev.steps];
      const [moved] = nextSteps.splice(fromIndex, 1);
      nextSteps.splice(toIndex, 0, moved);
      return { ...prev, steps: nextSteps };
    });
  };

  const saveDraftUndoSnapshot = (deletedCount: number) => {
    if (!draft) return;
    setDraftUndoSnapshot({
      draft: { ...draft, steps: draft.steps.map(step => ({ ...step })) },
      selectedStepIds: [...selectedDraftStepIds],
      deletedCount
    });
  };

  const deleteDraftStep = (stepId: string) => {
    if (!draft) return;
    saveDraftUndoSnapshot(1);
    setDraft(prev => {
      if (!prev) return prev;
      const nextSteps = prev.steps.filter(step => step.id !== stepId);
      if (nextSteps.length === 0) {
        setSelectedDraftStepIds([]);
        return { ...prev, steps: [] };
      }
      setSelectedDraftStepIds(selected => selected.filter(id => id !== stepId));
      return { ...prev, steps: nextSteps };
    });
  };

  const deleteSelectedDraftSteps = () => {
    if (!draft || selectedDraftStepIds.length === 0) return;
    const selectedIds = new Set(selectedDraftStepIds);
    const deletedCount = draft.steps.filter(step => selectedIds.has(step.id)).length;
    if (deletedCount === 0) return;
    saveDraftUndoSnapshot(deletedCount);
    setDraft(prev => (prev ? { ...prev, steps: prev.steps.filter(step => !selectedIds.has(step.id)) } : prev));
    setSelectedDraftStepIds([]);
  };

  const undoDraftDeletion = () => {
    if (!draftUndoSnapshot) return;
    setDraft(draftUndoSnapshot.draft);
    setSelectedDraftStepIds(draftUndoSnapshot.selectedStepIds);
    setDraftUndoSnapshot(null);
    setError(null);
  };

  const stopWorkflowRun = () => {
    if (!isRunning) return;
    workflowAbortRef.current?.abort();
    setRunPhase('stopped');
    setRunLogs(prev => [...prev, '已请求停止执行，正在中断...']);
  };

  const rollbackLastCurrentDocRun = () => {
    if (!lastRunBackup) return;
    onUpdateDoc(lastRunBackup.docId, {
      content: lastRunBackup.content,
      aiSummary: lastRunBackup.aiSummary,
      aiActionItems: lastRunBackup.aiActionItems,
      autoInsightsUpdatedAt: lastRunBackup.autoInsightsUpdatedAt,
      goalSource: lastRunBackup.goalSource,
      automationStrategy: lastRunBackup.automationStrategy
    });
    setRunLogs(prev => [...prev, '已回滚最近一次对当前页面的工作流写入。']);
    setLastRunBackup(null);
  };

  const retryFailedWorkflowSteps = async () => {
    if (!draft) return;
    const failedStepIds = draft.steps
      .filter(step => stepRunState[step.id]?.status === 'failed')
      .map(step => step.id);
    if (failedStepIds.length === 0) {
      setError('当前没有失败步骤可重试。');
      return;
    }
    await runWorkflow(failedStepIds);
  };

  const runWorkflow = async (stepIdsOverride?: string[]) => {
    if (!draft || isRunning) return;
    const effectiveStepIds = stepIdsOverride || selectedDraftStepIds;
    const selectedSteps = draft.steps.filter(step => effectiveStepIds.includes(step.id));
    if (selectedSteps.length === 0) {
      setError('请先选中至少一个草稿步骤后再执行。');
      return;
    }

    const controller = new AbortController();
    workflowAbortRef.current = controller;
    setIsRunning(true);
    setRunPhase('running');
    setError(null);
    setRunLogs([`开始执行：${selectedSteps.length} 个步骤`]);

    setStepRunState(prev => {
      const next = { ...prev };
      for (const step of draft.steps) {
        const current = next[step.id] || createDefaultStepRunState();
        if (selectedSteps.some(item => item.id === step.id)) {
          next[step.id] = {
            ...current,
            status: 'queued',
            error: null,
            output: stepIdsOverride ? current.output : ''
          };
        } else if (!stepIdsOverride) {
          next[step.id] = { ...current, status: 'skipped', error: null };
        }
      }
      return next;
    });

    try {
      const docId = draft.targetDocId || activeDocId || availableDocs[0]?.id || null;
      const target = draft.scope === 'current_doc' ? availableDocs.find(d => d.id === docId) : null;
      if (draft.scope === 'current_doc' && !target) throw new Error('没有可用页面可绑定');

      const controllerSignal = controller.signal;
      const now = new Date().toLocaleString();
      const stepOutputs: Array<{ step: WorkflowStep; output: string }> = [];
      const shouldContinueOnFailure = draft.risk === 'high' && draft.cadence === 'auto';

      for (const [index, step] of selectedSteps.entries()) {
        if (controllerSignal.aborted) throw new DOMException('Workflow aborted', 'AbortError');
        const startedAt = new Date().toISOString();
        setRunLogs(prev => [...prev, `步骤 ${index + 1}/${selectedSteps.length} 执行中：${step.title}`]);
        setStepRunState(prev => ({
          ...prev,
          [step.id]: {
            ...(prev[step.id] || createDefaultStepRunState()),
            status: 'running',
            startedAt,
            endedAt: undefined,
            error: null,
            attempts: (prev[step.id]?.attempts || 0) + 1
          }
        }));

        const previousContext = stepOutputs
          .map((item, idx) => `步骤${idx + 1} ${item.step.title}:\n${item.output.slice(0, 1200)}`)
          .join('\n\n');
        const targetContext =
          target ? `目标页面标题：${target.title || '无标题'}\n页面内容摘要：${toPlainText(target.content).slice(0, 3000)}` : '';
        const stepInstruction = `你是工作流执行器。请直接执行给定步骤，并返回结构化 Markdown：
## 执行说明
## 产出结果
## 下一步建议
要求：中文、可落地、不要输出与步骤无关内容。`;
        const stepPrompt = [
          `当前时间：${now}`,
          `工作流目标：${draft.goal}`,
          `工作流摘要：${draft.summary}`,
          `作用范围：${getScopeLabel(draft.scope)}`,
          `输出重心：${getOutputLabel(draft.output)}`,
          `执行节奏：${getCadenceLabel(draft.cadence)}`,
          `风险档位：${getRiskLabel(draft.risk)}`,
          targetContext,
          previousContext ? `已完成步骤上下文：\n${previousContext}` : '',
          `当前步骤：${step.title}\n步骤细节：${step.detail}`
        ]
          .filter(Boolean)
          .join('\n\n');

        let stepOutput = '';
        try {
          const outputText = await callApi(
            stepInstruction,
            stepPrompt,
            chunk => {
              stepOutput += chunk;
              setStepRunState(prev => ({
                ...prev,
                [step.id]: {
                  ...(prev[step.id] || createDefaultStepRunState()),
                  status: 'running',
                  output: stepOutput
                }
              }));
            },
            controllerSignal
          );
          if (!stepOutput && outputText) stepOutput = outputText;
          if (!stepOutput.trim()) stepOutput = '已执行该步骤，但未返回详细内容。';
          const endedAt = new Date().toISOString();
          stepOutputs.push({ step, output: stepOutput });
          setStepRunState(prev => ({
            ...prev,
            [step.id]: {
              ...(prev[step.id] || createDefaultStepRunState()),
              status: 'done',
              output: stepOutput,
              error: null,
              endedAt
            }
          }));
          setRunLogs(prev => [...prev, `步骤完成：${step.title}`]);
        } catch (stepError: any) {
          const endedAt = new Date().toISOString();
          const errText = stepError?.message || '步骤执行失败';
          setStepRunState(prev => ({
            ...prev,
            [step.id]: {
              ...(prev[step.id] || createDefaultStepRunState()),
              status: 'failed',
              error: errText,
              endedAt
            }
          }));
          setRunLogs(prev => [...prev, `步骤失败：${step.title}（${errText}）`]);
          if (!shouldContinueOnFailure) {
            throw new Error(`步骤「${step.title}」执行失败：${errText}`);
          }
        }
      }

      if (stepOutputs.length === 0) {
        throw new Error('没有成功执行的步骤。');
      }

      const strategy: AutomationStrategy = {
        executionMode: draft.cadence === 'auto' ? 'auto_apply' : 'preview',
        targetPreference: 'follow_selector',
        riskTolerance: draft.risk,
        idleMs: draft.cadence === 'auto' ? 65000 : 90000,
        maxItems: draft.cadence === 'auto' ? 4 : 2
      };
      const executionTitle = `Inspriation AI · 工作流执行 · ${new Date().toLocaleString()}`;
      const htmlResultList = stepOutputs
        .map((item, idx) => (
          `<li><strong>${idx + 1}. ${escapeHtml(item.step.title)}</strong><br/>${escapeHtml(item.output).replace(/\n/g, '<br/>')}</li>`
        ))
        .join('');
      const executionSummary = stepOutputs
        .map(item => `${item.step.title}：${item.output.split('\n')[0] || '已执行'}`)
        .join('；')
        .slice(0, 300);
      const executionHtml = `<section data-ai-workflow-run="${Date.now()}"><h2>${escapeHtml(executionTitle)}</h2><p><strong>目标：</strong>${escapeHtml(draft.goal)}</p><p>${escapeHtml(draft.summary)}</p><h3>执行结果</h3><ol>${htmlResultList}</ol></section>`;

      if (draft.scope === 'current_doc' && target) {
        setLastRunBackup({
          docId: target.id,
          content: target.content,
          aiSummary: target.aiSummary,
          aiActionItems: target.aiActionItems,
          autoInsightsUpdatedAt: target.autoInsightsUpdatedAt,
          goalSource: target.goalSource,
          automationStrategy: target.automationStrategy
        });

        onUpdateDoc(target.id, {
          content: `${target.content}${target.content.includes('</p>') || target.content.includes('</h') ? '' : '<p></p>'}${executionHtml}`,
          goalSource: {
            goal: draft.goal,
            constraints: `模式: ${getOutputLabel(draft.output)}；节奏: ${getCadenceLabel(draft.cadence)}；风险: ${getRiskLabel(draft.risk)}；选中步骤: ${selectedSteps.length}/${draft.steps.length}`
          },
          automationStrategy: strategy,
          aiSummary: executionSummary || draft.summary,
          aiActionItems: stepOutputs.map(item => item.step.title).slice(0, 8),
          autoInsightsUpdatedAt: new Date().toISOString()
        });
        onSelectDoc(target.id);
        onOpenDocumentArea();
        setRunLogs(prev => [
          ...prev,
          `已写入当前页面：${target.title || '无标题'}`,
          `自动化策略已更新：${strategy.executionMode === 'auto_apply' ? '自动执行' : '预览优先'}`
        ]);
      } else if (draft.scope === 'knowledge_base') {
        const title = `Inspriation AI · 知识库执行 ${new Date().toLocaleDateString()}`;
        const kbHtml = `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(draft.summary)}</p><h2>执行结果</h2><ol>${htmlResultList}</ol><h2>知识库页面</h2><ul>${knowledgeBaseDocs
          .map((doc, i) => `<li>${i + 1}. ${escapeHtml(doc.title || '无标题')} - ${escapeHtml(toPlainText(doc.content).slice(0, 90))}</li>`)
          .join('')}</ul>`;
        onCreateDoc(null, { title, content: kbHtml });
        onOpenDocumentArea();
        setRunLogs(prev => [...prev, `已创建知识库执行页，涉及 ${knowledgeBaseDocs.length} 个页面`]);
      } else {
        const title = 'Inspriation AI · 工作流执行单';
        const newPageHtml = `<h1>${escapeHtml(title)}</h1><p><strong>目标:</strong> ${escapeHtml(draft.goal)}</p><p>${escapeHtml(draft.summary)}</p><h2>执行结果</h2><ol>${htmlResultList}</ol>`;
        onCreateDoc(null, { title, content: newPageHtml });
        onOpenDocumentArea();
        setRunLogs(prev => [...prev, '已创建新的执行单页面']);
      }

      setDraft(prev =>
        prev ? { ...prev, runCount: prev.runCount + 1, lastRunAt: new Date().toISOString() } : prev
      );
      setRunPhase('completed');
    } catch (e: any) {
      const isAbort = e?.name === 'AbortError' || workflowAbortRef.current?.signal.aborted;
      setRunPhase(isAbort ? 'stopped' : 'failed');
      setError(isAbort ? '执行已停止。' : e?.message || '执行失败');
    } finally {
      setIsRunning(false);
      workflowAbortRef.current = null;
    }
  };

  const resetConversation = () => {
    abortControllerRef.current?.abort();
    workflowAbortRef.current?.abort();
    stopStreamingRef.current = false;
    setMessages([createWelcomeMessage()]);
    setInput('');
    setDraft(null);
    setDraftUndoSnapshot(null);
    setStepRunState({});
    setRunPhase('idle');
    setLastRunBackup(null);
    setRunLogs([]);
    setError(null);
    setCanRetryLastRequest(false);
    setShowDraftPanel(false);
    setShowSettings(false);
    setShowChatDocSelector(false);
    setShowUploadMenu(false);
    setShowLinkInput(false);
    setShowApiSettings(false);
    setAttachedFiles([]);
    setAttachedLinks([]);
    setReferencedPageIds([]);
    setSelectedComposerSkillIds([]);
    setSelectedDraftStepIds([]);
    setDraggingDraftStepId(null);
    lastRequestPayloadRef.current = null;
    localStorage.removeItem(STUDIO_SESSION_STORAGE_KEY);
  };

  const applyWorkflowPreset = (preset: 'safe' | 'balanced' | 'aggressive') => {
    if (preset === 'safe') {
      setCadence('manual');
      setRisk('low');
      setOutput('plan');
      return;
    }
    if (preset === 'aggressive') {
      setCadence('auto');
      setRisk('high');
      return;
    }
    setCadence('auto');
    setRisk('medium');
    setOutput('plan');
  };

  const toggleInspirationSkillSelection = (skill: InspirationSkill) => {
    if (isThinking) return;
    if (!isSkillEnabled) {
      setError('技能开关已关闭，开启后才可手动调用技能。');
      return;
    }
    setError(null);
    setSelectedComposerSkillIds(prev => {
      const exists = prev.includes(skill.id);
      const next = exists ? prev.filter(id => id !== skill.id) : [...prev, skill.id];
      const nextSkills = next
        .map(id => skills.find(item => item.id === id))
        .filter((item): item is InspirationSkill => !!item);
      if (nextSkills.length > 0) {
        applyRoutingPreferences(nextSkills);
      }
      return next;
    });
  };

  const renderComposer = (floating: boolean) => (
    <div
      className={`w-full rounded-[24px] border border-white/10 bg-gradient-to-br from-zinc-800/92 to-zinc-900/95 px-3 pb-2.5 pt-2.5 shadow-[0_24px_70px_-34px_rgba(0,0,0,0.95)] ${
        floating ? 'backdrop-blur-lg' : ''
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {skills.slice(0, 9).map(skill => (
            <button
              key={skill.id}
              onClick={() => toggleInspirationSkillSelection(skill)}
              disabled={isThinking || !isSkillEnabled}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                isSkillEnabled
                  ? selectedComposerSkillIds.includes(skill.id)
                    ? 'border-blue-300/60 bg-blue-500/30 text-blue-100'
                    : 'border-blue-400/30 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20'
                  : 'border-zinc-700/70 bg-zinc-800/40 text-zinc-500'
              }`}
              title={
                isSkillEnabled
                  ? `${skill.description}（点击${selectedComposerSkillIds.includes(skill.id) ? '取消' : '选中'}）`
                  : '技能开关关闭，当前不可调用'
              }
            >
              {selectedComposerSkillIds.includes(skill.id) ? <Check className="h-3 w-3" /> : <ListTree className="h-3 w-3" />}
              {skill.name}
            </button>
          ))}
      </div>
      <input
        ref={chatFilesInputRef}
        type="file"
        className="hidden"
        multiple
        accept=".txt,.md,.markdown,.html,.htm,.docx,.pdf,.csv,text/plain,text/markdown,text/html,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/csv,application/csv,application/vnd.ms-excel"
        onChange={e => handleChatFileUpload(e.target.files, 'files')}
      />
      <input
        ref={chatFolderInputRef}
        type="file"
        className="hidden"
        accept=".txt,.md,.markdown,.html,.htm,.docx,.pdf,.csv,text/plain,text/markdown,text/html,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/csv,application/csv,application/vnd.ms-excel"
        onChange={e => handleChatFileUpload(e.target.files, 'folder')}
        {...({ webkitdirectory: '', directory: '' } as any)}
      />
      <div className="flex items-end gap-3">
        <textarea
          rows={1}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (isThinking) return;
              const options = selectedComposerSkills.length > 0 ? { invokedSkills: selectedComposerSkills } : undefined;
              void sendMessage(undefined, options);
              if (options) setSelectedComposerSkillIds([]);
            }
          }}
          placeholder="使用 AI 处理各种任务..."
          className="min-h-[42px] max-h-[118px] w-full flex-1 resize-none border-0 bg-transparent text-zinc-100 outline-none placeholder:text-zinc-500"
        />
        <button
          onClick={() => {
            const options = selectedComposerSkills.length > 0 ? { invokedSkills: selectedComposerSkills } : undefined;
            void sendMessage(undefined, options);
            if (options) setSelectedComposerSkillIds([]);
          }}
          disabled={
            isThinking ||
            (!input.trim() &&
              attachedFiles.length === 0 &&
              linkStatus.done + linkStatus.errorCount === 0 &&
              referencedPageIds.length === 0 &&
              selectedComposerSkills.length === 0)
          }
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-45"
          title="发送"
        >
          {isThinking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4 ml-0.5" />}
        </button>
      </div>
      {showLinkInput && (
        <div className="mt-2 flex items-center gap-2 rounded-xl border border-blue-500/30 bg-blue-500/10 p-2">
          <input
            type="url"
            value={newLinkUrl}
            onChange={e => setNewLinkUrl(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddLink(newLinkUrl);
              }
              if (e.key === 'Escape') setShowLinkInput(false);
            }}
            placeholder="粘贴网页链接 (https://...)"
            className="h-8 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-200 outline-none focus:border-blue-500"
            autoFocus
          />
          <button
            onClick={() => handleAddLink(newLinkUrl)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white transition-colors hover:bg-blue-500"
          >
            <Check className="h-4 w-4" />
          </button>
        </div>
      )}

      {showApiSettings && (
        <div className="mt-2 flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 p-2">
          <input
            type="password"
            value={tavilyApiKey}
            onChange={e => setTavilyApiKey(e.target.value)}
            placeholder="Tavily API Key"
            className="h-8 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-200 outline-none focus:border-amber-400"
          />
          <button
            onClick={() => {
              if (tavilyApiKey.trim()) {
                setShowApiSettings(false);
                setError(null);
              }
            }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500 text-zinc-900 transition-colors hover:bg-amber-400"
          >
            <Check className="h-4 w-4" />
          </button>
        </div>
      )}

      {showChatDocSelector && (
        <div className="mt-2 rounded-xl border border-zinc-700 bg-zinc-900/95 p-2">
          <div className="mb-2 flex items-center justify-between">
            <div className="inline-flex rounded-lg bg-zinc-800 p-0.5">
              <button
                onClick={() => setChatDocFilter('kb')}
                className={`rounded-md px-2 py-1 text-[11px] ${chatDocFilter === 'kb' ? 'bg-zinc-200 text-zinc-900' : 'text-zinc-400'}`}
              >
                知识库
              </button>
              <button
                onClick={() => setChatDocFilter('all')}
                className={`rounded-md px-2 py-1 text-[11px] ${chatDocFilter === 'all' ? 'bg-zinc-200 text-zinc-900' : 'text-zinc-400'}`}
              >
                全部
              </button>
            </div>
            <button onClick={() => setShowChatDocSelector(false)} className="rounded text-zinc-500 hover:text-zinc-200">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="max-h-32 space-y-1 overflow-y-auto custom-scrollbar">
            {availableReferenceDocs.map(doc => (
              <button
                key={doc.id}
                onClick={() =>
                  setReferencedPageIds(prev =>
                    prev.includes(doc.id) ? prev.filter(id => id !== doc.id) : [...prev, doc.id]
                  )
                }
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors ${
                  referencedPageIds.includes(doc.id)
                    ? 'bg-purple-500/20 text-purple-200'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                <span
                  className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded border ${
                    referencedPageIds.includes(doc.id)
                      ? 'border-purple-400 bg-purple-500 text-white'
                      : 'border-zinc-600'
                  }`}
                >
                  {referencedPageIds.includes(doc.id) && <Check className="h-2.5 w-2.5" />}
                </span>
                <span className="truncate text-left">{doc.title || '无标题'}</span>
              </button>
            ))}
            {availableReferenceDocs.length === 0 && (
              <div className="px-2 py-3 text-xs text-zinc-500">
                {chatDocFilter === 'kb' ? '知识库暂无页面，请先在侧边栏标记。' : '暂无可引用页面。'}
              </div>
            )}
          </div>
        </div>
      )}

      {showUploadMenu && (
        <div className="mt-2 flex gap-2 rounded-xl border border-zinc-700 bg-zinc-900/95 p-2">
          <button
            onClick={() => {
              chatFilesInputRef.current?.click();
              setShowUploadMenu(false);
            }}
            className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 transition-colors hover:bg-zinc-700"
          >
            上传多个文件
          </button>
          <button
            onClick={() => {
              chatFolderInputRef.current?.click();
              setShowUploadMenu(false);
            }}
            className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 transition-colors hover:bg-zinc-700"
          >
            上传文件夹
          </button>
        </div>
      )}

      {referencedPageIds.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {referencedPageIds.map(id => {
            const target = documents.find(doc => doc.id === id);
            if (!target) return null;
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full border border-purple-400/40 bg-purple-500/10 px-2 py-1 text-[11px] text-purple-200"
              >
                <Library className="h-3 w-3" />
                <span className="max-w-[160px] truncate">{target.title || '无标题'}</span>
                <button
                  onClick={() => setReferencedPageIds(prev => prev.filter(item => item !== id))}
                  className="rounded text-purple-300 transition-colors hover:text-white"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {attachedFiles.length > 0 && (
        <div className="mt-2 max-h-24 space-y-1 overflow-y-auto rounded-xl border border-zinc-700/80 bg-zinc-900/75 p-2 custom-scrollbar">
          {attachedFiles.map((item, idx) => (
            <div key={item.id} className="flex items-center justify-between gap-2 text-[11px] text-zinc-300">
              <div className="flex min-w-0 items-center gap-1.5">
                {item.type === 'folder' ? (
                  <Folder className="h-3.5 w-3.5 text-purple-300" />
                ) : (
                  <FolderSync className="h-3.5 w-3.5 text-blue-300" />
                )}
                <span className="truncate">{item.name}</span>
              </div>
              <button
                onClick={() => setAttachedFiles(prev => prev.filter((_, index) => index !== idx))}
                className="rounded text-zinc-500 transition-colors hover:text-zinc-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {attachedLinks.length > 0 && (
        <div className="mt-2 max-h-28 space-y-1 overflow-y-auto rounded-xl border border-zinc-700/80 bg-zinc-900/75 p-2 custom-scrollbar">
          {attachedLinks.map((link, idx) => (
            <div key={`${link.url}-${idx}`} className="flex items-center justify-between gap-2 text-[11px] text-zinc-300">
              <div className="flex min-w-0 items-center gap-1.5">
                {link.status === 'loading' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-300" />
                ) : link.status === 'error' ? (
                  <X className="h-3.5 w-3.5 text-rose-300" />
                ) : (
                  <Globe2 className="h-3.5 w-3.5 text-emerald-300" />
                )}
                <span className="truncate">
                  {link.status === 'loading' ? '正在抓取网页...' : link.title || link.url}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {link.status === 'error' && (
                  <button
                    onClick={() => retryLinkFetch(link.url)}
                    className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-amber-300"
                    title="重试抓取"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                )}
                <button
                  onClick={() => setAttachedLinks(prev => prev.filter((_, index) => index !== idx))}
                  className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowChatDocSelector(v => !v)}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
              showChatDocSelector || referencedPageIds.length > 0
                ? 'bg-purple-500/20 text-purple-200'
                : 'text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-200'
            }`}
            title="引用页面知识库"
          >
            <Library className="h-4 w-4" />
          </button>
          <button
            onClick={() => setShowUploadMenu(v => !v)}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
              showUploadMenu || attachedFiles.length > 0
                ? 'bg-blue-500/20 text-blue-200'
                : 'text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-200'
            }`}
            title="上传文件夹或多个文件"
          >
            <FolderSync className="h-4 w-4" />
          </button>
          <button
            onClick={() => setShowLinkInput(v => !v)}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
              showLinkInput || attachedLinks.length > 0
                ? 'bg-sky-500/20 text-sky-200'
                : 'text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-200'
            }`}
            title="添加网页链接"
          >
            <Link2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => setIsSearchEnabled(v => !v)}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
              isSearchEnabled
                ? 'bg-emerald-500/20 text-emerald-200'
                : 'text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-200'
            }`}
            title={isSearchEnabled ? '已开启联网搜索' : '开启联网搜索'}
          >
            <Globe2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => setShowApiSettings(v => !v)}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
              tavilyApiKey ? 'text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-200' : 'text-amber-400'
            }`}
            title="配置联网搜索 API Key"
          >
            <Settings2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => {
              const next = !isSkillEnabled;
              setIsSkillEnabled(next);
              if (!next) setSelectedComposerSkillIds([]);
            }}
            className={`inline-flex h-8 items-center gap-1 rounded-md border px-2 text-[10px] transition-colors ${
              isSkillEnabled
                ? 'border-blue-400/40 bg-blue-500/15 text-blue-200 hover:bg-blue-500/25'
                : 'border-zinc-600/60 bg-zinc-800/60 text-zinc-400 hover:bg-zinc-700/70'
            }`}
            title={isSkillEnabled ? '已开启技能调用' : '技能调用已关闭'}
          >
            <Brain className="h-3.5 w-3.5" />
            {isSkillEnabled ? '技能开' : '技能关'}
          </button>
          {selectedComposerSkillIds.length > 0 && (
            <button
              onClick={() => setSelectedComposerSkillIds([])}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-blue-400/35 bg-blue-500/10 px-2 text-[10px] text-blue-200 transition-colors hover:bg-blue-500/20"
              title="清空已选技能"
            >
              <Check className="h-3 w-3" />
              已选 {selectedComposerSkillIds.length}
            </button>
          )}
          {skills.length > 9 && <div className="mx-1 h-4 w-px bg-zinc-700/50" />}
          {skills.slice(9).map(skill => (
            <button
              key={skill.id}
              onClick={() => toggleInspirationSkillSelection(skill)}
              disabled={isThinking || !isSkillEnabled}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                isSkillEnabled
                  ? selectedComposerSkillIds.includes(skill.id)
                    ? 'border-blue-300/60 bg-blue-500/30 text-blue-100'
                    : 'border-blue-400/30 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20'
                  : 'border-zinc-700/70 bg-zinc-800/40 text-zinc-500'
              }`}
              title={
                isSkillEnabled
                  ? `${skill.description}（点击${selectedComposerSkillIds.includes(skill.id) ? '取消' : '选中'}）`
                  : '技能开关关闭，当前不可调用'
              }
            >
              {selectedComposerSkillIds.includes(skill.id) ? <Check className="h-3 w-3" /> : <ListTree className="h-3 w-3" />}
              {skill.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          {isThinking && (
            <button
              onClick={stopStreamingReply}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-rose-400/40 bg-rose-500/10 px-2 text-[11px] text-rose-200 transition-colors hover:bg-rose-500/20"
              title="停止当前回复"
            >
              <Square className="h-3 w-3 fill-current" />
              停止
            </button>
          )}
          {!isThinking && canRetryLastRequest && (
            <button
              onClick={retryLastRequest}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-amber-400/40 bg-amber-500/10 px-2 text-[11px] text-amber-200 transition-colors hover:bg-amber-500/20"
              title="重试上次请求"
            >
              <RotateCcw className="h-3 w-3" />
              重试上次
            </button>
          )}
          {linkStatus.loading > 0 && (
            <span className="text-[11px] text-zinc-500">网页抓取中 {linkStatus.loading}</span>
          )}
        </div>
      </div>
      {error && <div className="mt-2 text-xs text-rose-300">{error}</div>}
    </div>
  );

  return (
    <div className="relative h-full overflow-hidden bg-[radial-gradient(circle_at_20%_10%,_rgba(29,78,216,0.14),transparent_30%),radial-gradient(circle_at_80%_0%,_rgba(37,99,235,0.1),transparent_26%),#080a10] text-zinc-100">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0))]" />

      <div className="absolute right-6 top-4 z-40">
        <div className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-zinc-900/80 p-1.5 backdrop-blur-md">
          <button
            onClick={() => setShowSettings(v => !v)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-blue-300 transition-colors hover:bg-zinc-700/70"
            title="参数面板"
          >
            <AIBurstIcon size="md" />
          </button>
          <button
            onClick={() => setShowSkillsManager(true)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-zinc-200 transition-colors hover:bg-zinc-700/70"
            title="技能管理 (Skills)"
          >
            <Brain className="h-4 w-4" />
          </button>
          <button
            onClick={() => setShowDraftPanel(v => !v)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-zinc-200 transition-colors hover:bg-zinc-700/70"
            title="工作流草案"
          >
            <ListTree className={`h-4 w-4 ${showDraftPanel ? 'text-blue-300' : 'text-zinc-200'}`} />
          </button>
          <span className="mx-1 h-5 w-px bg-zinc-700" />
          <button
            onClick={resetConversation}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-zinc-200 transition-colors hover:bg-zinc-700/70"
            title="新对话"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      <SkillsManager
        isOpen={showSkillsManager}
        onClose={() => setShowSkillsManager(false)}
        skills={skills}
        onAddSkill={onAddSkill}
        onDeleteSkill={onDeleteSkill}
      />

      {showSettings && (
        <div className="absolute right-6 top-16 z-40 w-80 rounded-2xl border border-white/10 bg-zinc-900/96 p-4 shadow-[0_20px_40px_-10px_rgba(0,0,0,0.8)] backdrop-blur-xl">
          <div className="mb-4 flex items-center justify-between border-b border-zinc-800/80 pb-3">
            <h3 className="text-sm font-semibold text-zinc-100">工作流参数</h3>
            <button
              onClick={() => setShowSettings(false)}
              className="rounded-full p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-medium text-zinc-400">预设策略</label>
              <div className="flex gap-2">
                {[
                  { id: 'safe', label: '稳健', color: 'emerald' },
                  { id: 'balanced', label: '平衡', color: 'blue' },
                  { id: 'aggressive', label: '冲刺', color: 'rose' }
                ].map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => applyWorkflowPreset(preset.id as any)}
                    className={`flex-1 rounded-lg border border-zinc-700/50 bg-zinc-800/50 py-1.5 text-xs text-zinc-300 transition-all hover:border-${preset.color}-500/50 hover:bg-${preset.color}-500/10 hover:text-${preset.color}-200`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400">作用范围</label>
                <select
                  value={scope}
                  onChange={e => setScope(e.target.value as WorkflowScope)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-blue-500"
                >
                  <option value="current_doc">当前页面</option>
                  <option value="knowledge_base">知识库</option>
                  <option value="new_page">新页面</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400">输出重心</label>
                <select
                  value={output}
                  onChange={e => setOutput(e.target.value as WorkflowOutput)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-blue-500"
                >
                  <option value="plan">目标拆解</option>
                  <option value="rewrite">内容重写</option>
                  <option value="translate">双语翻译</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-400">执行节奏</label>
                  <select
                    value={cadence}
                    onChange={e => setCadence(e.target.value as WorkflowCadence)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-200 outline-none focus:border-blue-500"
                  >
                    <option value="auto">自动</option>
                    <option value="manual">手动</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-400">风险档位</label>
                  <select
                    value={risk}
                    onChange={e => setRisk(e.target.value as WorkflowRisk)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-200 outline-none focus:border-blue-500"
                  >
                    <option value="low">低</option>
                    <option value="medium">中</option>
                    <option value="high">高</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400">目标页面</label>
                <select
                  value={targetDocId || ''}
                  onChange={e => setTargetDocId(e.target.value || null)}
                  disabled={scope !== 'current_doc'}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {availableDocs.length === 0 ? (
                    <option value="">暂无可用页面</option>
                  ) : (
                    availableDocs.map(doc => (
                      <option key={doc.id} value={doc.id}>
                        {doc.title || '无标题'}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400">技能学习模式</label>
                <select
                  value={skillLearningMode}
                  onChange={e => setSkillLearningMode(e.target.value as SkillLearningMode)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-blue-500"
                >
                  <option value="confirm">确认后保存（推荐）</option>
                  <option value="auto">自动保存</option>
                  <option value="off">关闭自动学习</option>
                </select>
                <div className="text-[11px] text-zinc-500">
                  AI 会在回复尾部输出技能调用元信息，并根据模式自动创建或建议创建技能。
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-zinc-800/80">
              <button
                onClick={() => {
                  setScope('current_doc');
                  setOutput('plan');
                  setCadence('auto');
                  setRisk('medium');
                  setSkillLearningMode('confirm');
                  setIsSkillEnabled(true);
                  setSelectedComposerSkillIds([]);
                  if (activeDocId) setTargetDocId(activeDocId);
                }}
                className="w-full rounded-lg border border-zinc-700/50 bg-zinc-800/30 py-2 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              >
                恢复默认设置
              </button>
            </div>
          </div>
        </div>
      )}

      {!hasUserMessages ? (
        <div className="relative z-10 mx-auto flex h-full w-full max-w-5xl items-center justify-center px-4 pb-14 pt-20">
          <div className="w-full max-w-[780px]">
            <div className="mb-8 flex flex-col items-center justify-center gap-3 text-center">
              <AIBurstIcon size="xl" />
              <h1 className="text-4xl font-bold tracking-tight text-zinc-100">今天有什么可以帮到你?</h1>
            </div>
            {renderComposer(false)}
          </div>
        </div>
      ) : (
        <div className="relative z-10 mx-auto flex h-full w-full max-w-4xl flex-col px-4 pb-36 pt-20">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 custom-scrollbar">
            {messages.map(msg => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[90%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'rounded-br-md bg-blue-600 text-white'
                      : 'rounded-bl-md border border-zinc-700/70 bg-zinc-900/85 text-zinc-100'
                  }`}
                >
                  {msg.role === 'assistant' && (
                    <div className="mb-1 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-blue-300">
                      <AIBurstIcon size="sm" />
                      <span>Inspriation AI</span>
                      {!msg.content && (
                        <>
                          <span className="ml-2 h-3.5 w-px bg-blue-300/35" />
                          <span className="ml-2 text-[11px] font-medium normal-case tracking-normal text-zinc-300">
                            正在生成回复
                          </span>
                          <div className="ai-reply-loader ai-reply-loader-inline ml-2" aria-hidden="true">
                            <span className="ai-reply-ball" />
                            <span className="ai-reply-ball" />
                            <span className="ai-reply-ball" />
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  {msg.role === 'assistant' && msg.skillMeta && (
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      {(msg.skillMeta.usedSkillNames || []).length > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-blue-400/30 bg-blue-500/10 px-2 py-1 text-[11px] text-blue-200">
                          <CheckCircle2 className="h-3 w-3" />
                          已调用技能：{(msg.skillMeta.usedSkillNames || []).join('、')}
                        </span>
                      )}
                      {msg.skillMeta.learningStatus && (
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] ${
                            msg.skillMeta.learningStatus === 'created'
                              ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                              : msg.skillMeta.learningStatus === 'error'
                                ? 'border-rose-400/30 bg-rose-500/10 text-rose-200'
                                : msg.skillMeta.learningStatus === 'suggested'
                                  ? 'border-amber-400/30 bg-amber-500/10 text-amber-200'
                                  : 'border-zinc-500/40 bg-zinc-700/20 text-zinc-300'
                          }`}
                        >
                          <Brain className="h-3 w-3" />
                          {msg.skillMeta.learningNote || '技能学习状态已更新'}
                        </span>
                      )}
                      {msg.skillMeta.learningStatus === 'suggested' && msg.skillMeta.proposedSkill && (
                        <button
                          onClick={() => confirmProposedSkillFromMessage(msg.id)}
                          className="inline-flex items-center gap-1 rounded-full border border-blue-400/40 bg-blue-500/15 px-2.5 py-1 text-[11px] text-blue-200 transition-colors hover:bg-blue-500/25"
                          title="保存 AI 建议的技能"
                        >
                          <Check className="h-3 w-3" />
                          保存技能
                        </button>
                      )}
                    </div>
                  )}
                  {msg.role === 'assistant' ? (
                    msg.content ? (
                      <div className="prose prose-sm max-w-none prose-zinc prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-headings:my-3 prose-strong:text-zinc-100 prose-code:text-zinc-100 prose-a:text-sky-300 prose-a:underline prose-a:underline-offset-2 dark:prose-invert">
                        <ReactMarkdown>{msg.content}</ReactMarkdown>
                      </div>
                    ) : null
                  ) : (
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                  )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20">
            <div className="pointer-events-auto">{renderComposer(true)}</div>
          </div>
        </div>
      )}

      <aside
        className={`absolute right-0 top-20 z-30 h-[calc(100%-5rem)] w-full max-w-[360px] border-l border-white/10 bg-zinc-950/96 shadow-[-18px_0_40px_-30px_rgba(0,0,0,1)] backdrop-blur-xl transition-transform duration-300 ${showDraftPanel ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="flex h-full flex-col">
          <div className="border-b border-zinc-800 px-4 py-3">
            <div className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <AIBurstIcon size="md" />
              工作流草案
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              {getScopeLabel(scope)} · {getOutputLabel(output)} · {getCadenceLabel(cadence)} · {getRiskLabel(risk)}
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 custom-scrollbar">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={buildDraftFromChat}
                disabled={!hasUserMessages || isGeneratingDraft}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs text-zinc-200 transition-colors hover:border-blue-500/50 hover:text-blue-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isGeneratingDraft ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock3 className="h-4 w-4" />}
                生成草案
              </button>
              <button
                onClick={() => {
                  void runWorkflow();
                }}
                disabled={!draft || isRunning}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-blue-600 px-3 text-xs text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                执行工作流
              </button>
              <button
                onClick={stopWorkflowRun}
                disabled={!isRunning}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 text-xs text-rose-200 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Square className="h-3 w-3 fill-current" />
                停止执行
              </button>
              <button
                onClick={retryFailedWorkflowSteps}
                disabled={isRunning || workflowStepStats.failed === 0}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 text-xs text-amber-200 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                重试失败步骤
              </button>
              <button
                onClick={rollbackLastCurrentDocRun}
                disabled={isRunning || !lastRunBackup}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-zinc-600 bg-zinc-900 px-3 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                回滚写入
              </button>
              <span
                className={`inline-flex h-9 items-center rounded-xl border px-3 text-[11px] ${
                  runPhase === 'running'
                    ? 'border-blue-500/40 bg-blue-500/10 text-blue-200'
                    : runPhase === 'completed'
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                      : runPhase === 'failed'
                        ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                        : runPhase === 'stopped'
                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                          : 'border-zinc-700 bg-zinc-900 text-zinc-400'
                }`}
              >
                {runPhase === 'running'
                  ? '执行中'
                  : runPhase === 'completed'
                    ? '执行完成'
                    : runPhase === 'failed'
                      ? '执行失败'
                      : runPhase === 'stopped'
                        ? '已停止'
                        : '等待执行'}
              </span>
            </div>

            {draft ? (
              <div className="rounded-2xl border border-zinc-700 bg-zinc-900/85 p-3">
                <div className="text-sm font-semibold text-zinc-100">{draft.goal}</div>
                <div className="mt-1 text-xs leading-relaxed text-zinc-400">{draft.summary}</div>
                <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-400">
                  <span>
                    选点：{selectedDraftStepIds.length} / {draft.steps.length} · 完成 {workflowStepStats.done} · 失败 {workflowStepStats.failed}
                  </span>
                  <div className="inline-flex items-center gap-1.5">
                    <button
                      onClick={() => setSelectedDraftStepIds(draft.steps.map(step => step.id))}
                      className="rounded-md bg-zinc-800 px-2 py-1 text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white"
                    >
                      全选
                    </button>
                    <button
                      onClick={() => setSelectedDraftStepIds([])}
                      className="rounded-md bg-zinc-800 px-2 py-1 text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white"
                    >
                      清空
                    </button>
                    <button
                      onClick={deleteSelectedDraftSteps}
                      disabled={selectedDraftStepIds.length === 0}
                      className="inline-flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-1 text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
                      title="删除已选步骤"
                    >
                      <Trash2 className="h-3 w-3" />
                      批量删
                    </button>
                    <button
                      onClick={undoDraftDeletion}
                      disabled={!draftUndoSnapshot}
                      className="inline-flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-1 text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
                      title={draftUndoSnapshot ? `撤销最近删除（${draftUndoSnapshot.deletedCount} 项）` : '暂无可撤销删除'}
                    >
                      <RotateCcw className="h-3 w-3" />
                      撤销
                    </button>
                  </div>
                </div>
                <div className="mt-3 space-y-2.5">
                  {draft.steps.map((step, idx) => (
                    (() => {
                      const runInfo = stepRunState[step.id] || createDefaultStepRunState();
                      return (
                        <div
                          key={step.id}
                          draggable
                          onDragStart={() => setDraggingDraftStepId(step.id)}
                          onDragOver={e => e.preventDefault()}
                          onDrop={e => {
                            e.preventDefault();
                            if (draggingDraftStepId) reorderDraftSteps(draggingDraftStepId, step.id);
                            setDraggingDraftStepId(null);
                          }}
                          onDragEnd={() => setDraggingDraftStepId(null)}
                          className={`rounded-xl border p-2 transition-colors ${
                            selectedDraftStepIds.includes(step.id)
                              ? 'border-blue-500/40 bg-blue-500/10'
                              : 'border-zinc-700/70 bg-zinc-900/60'
                          } ${draggingDraftStepId === step.id ? 'opacity-60' : ''}`}
                        >
                          <div className="flex gap-2.5">
                            <span className="mt-0.5 rounded p-1 text-zinc-500" title="拖动排序">
                              <GripVertical className="h-3.5 w-3.5" />
                            </span>
                            <button
                              onClick={() => toggleDraftStepSelection(step.id)}
                              className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-semibold transition-colors ${
                                selectedDraftStepIds.includes(step.id)
                                  ? 'border-blue-400 bg-blue-600 text-white'
                                  : 'border-zinc-600 text-zinc-400 hover:border-zinc-400 hover:text-zinc-200'
                              }`}
                              title={selectedDraftStepIds.includes(step.id) ? '取消选点' : '选中该步骤'}
                            >
                              {selectedDraftStepIds.includes(step.id) ? <Check className="h-3 w-3" /> : idx + 1}
                            </button>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <div className="text-sm font-medium text-zinc-100">{step.title}</div>
                                <span
                                  className={`rounded-full border px-2 py-0.5 text-[10px] ${
                                    runInfo.status === 'running'
                                      ? 'border-blue-500/40 bg-blue-500/15 text-blue-200'
                                      : runInfo.status === 'done'
                                        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
                                        : runInfo.status === 'failed'
                                          ? 'border-rose-500/40 bg-rose-500/15 text-rose-200'
                                          : runInfo.status === 'queued'
                                            ? 'border-amber-500/40 bg-amber-500/15 text-amber-200'
                                            : runInfo.status === 'skipped'
                                              ? 'border-zinc-600 bg-zinc-800/70 text-zinc-400'
                                              : 'border-zinc-600 bg-zinc-800/70 text-zinc-400'
                                  }`}
                                >
                                  {getStepRunStatusLabel(runInfo.status)}
                                </span>
                                {runInfo.attempts > 0 && (
                                  <span className="text-[10px] text-zinc-500">尝试 {runInfo.attempts} 次</span>
                                )}
                              </div>
                              <div className="text-xs leading-relaxed text-zinc-400">{step.detail}</div>
                            </div>
                            <button
                              onClick={() => deleteDraftStep(step.id)}
                              className="mt-0.5 rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-rose-300"
                              title="删除该步骤"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          {(runInfo.error || runInfo.output) && (
                            <div className="mt-2 rounded-lg border border-zinc-700/80 bg-zinc-950/70 p-2">
                              {runInfo.error && <div className="text-[11px] text-rose-300">失败原因：{runInfo.error}</div>}
                              {runInfo.output && (
                                <details className="group mt-1">
                                  <summary className="cursor-pointer text-[11px] text-zinc-400 group-open:text-zinc-300">
                                    查看执行产出
                                  </summary>
                                  <div className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-zinc-300">
                                    {runInfo.output}
                                  </div>
                                </details>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()
                  ))}
                  {draft.steps.length === 0 && (
                    <div className="rounded-lg border border-dashed border-zinc-700 p-3 text-xs text-zinc-500">
                      当前草稿没有步骤，重新生成草稿即可恢复。
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-900/70 p-4 text-xs leading-relaxed text-zinc-500">
                先发起对话，再生成草案。
              </div>
            )}

            {runLogs.length > 0 && (
              <div className="rounded-2xl border border-emerald-900/60 bg-emerald-950/30 p-3">
                <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  执行日志 · {runPhase}
                </div>
                {runLogs.map((line, idx) => (
                  <div key={`${line}-${idx}`} className="text-xs text-emerald-200">
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
