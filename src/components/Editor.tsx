import { useState, useEffect, useRef, useMemo } from 'react';
import { Document, Settings, DocumentSnapshot, GoalPlan, GoalExecutionLog, AutomationStrategy } from '../App';
import { Skill } from '../types/skill';
import { Sparkles, AlignLeft, ListTree, Wand2, Loader2, Check, X, Languages, Download, Send, PenTool, Eraser, LayoutTemplate, Image as ImageIcon, FileSearch, CheckSquare, Type as TypeIcon, Zap, Code, ChevronDown, ChevronUp, Table as TableIcon, CalendarDays, Smile, Share2, Globe, Lock, Eye, Paperclip, FolderSync, Plus, Link as LinkIcon, MessageSquare, Folder, Settings as SettingsIcon, RotateCcw, Library, Brain } from 'lucide-react';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import TiptapEditor from './TiptapEditor';
import ReactMarkdown from 'react-markdown';
import { sanitizeHtml, escapeHtml } from '../utils/safeHtml';

const AUTO_WEB_SEARCH_PATTERN = /最新|实时|今天|刚刚|新闻|股价|天气|汇率|比分|价格|recent|latest|today|current|news|price|weather|score|exchange rate/i;
const AUTO_INSIGHT_MIN_CONTENT_LENGTH = 180;
const AUTO_INSIGHT_IDLE_MS = 45000;
const GOAL_PLAN_MAX_TASKS = 20;
const GOAL_PLAN_MAX_NEXT_ACTIONS = 3;
const GOAL_PLAN_MAX_MILESTONES = 8;
const GOAL_PLAN_MAX_RISKS = 6;
const GOAL_AUTO_REPLAN_INTERVAL_MS = 10 * 60 * 1000;
const GOAL_AUTO_REPLAN_IDLE_MS = 35000;
const GOAL_AUTO_REPLAN_MIN_DIFF = 180;
const GOAL_PLAN_CONTAINER_SELECTOR = '[data-goal-plan="v1"]';
const AUTO_EXECUTION_IDLE_MS = 65000;
const AUTO_EXECUTION_COOLDOWN_MS = 4 * 60 * 1000;
const AUTO_EXECUTION_MAX_ITEMS = 3;
const AUTO_EXECUTION_RISKY_TEXT_PATTERN = /(删除|清空|覆盖|重写整篇|彻底替换|drop|delete|erase|overwrite|wipe)/i;
const AUTO_EXECUTION_IDLE_OPTIONS = [30000, 45000, 65000, 90000];
const AUTO_EXECUTION_RISK_LEVEL_SCORE: Record<'low' | 'medium' | 'high', number> = {
  low: 1,
  medium: 2,
  high: 3
};
const AUTO_PREVIEW_QUEUE_LIMIT = 8;

type PreviewQueueItem = {
  id: string;
  title: string;
  content: string;
  mode: AiEditMode;
  target: 'original' | 'translated';
  createdAt: string;
  trigger: GoalExecutionLog['trigger'];
  patches?: ParagraphPatch[];
};

type AiEditMode = 'replace' | 'append' | 'prepend' | 'update_block';

type ParagraphPatchAction = 'replace' | 'insert_before' | 'insert_after' | 'delete';

type ParagraphPatch = {
  id: string;
  action: ParagraphPatchAction;
  find: string;
  content?: string;
  reason?: string;
};

const DEFAULT_AUTOMATION_STRATEGY: AutomationStrategy = {
  executionMode: 'preview',
  targetPreference: 'follow_selector',
  riskTolerance: 'medium',
  idleMs: AUTO_EXECUTION_IDLE_MS,
  maxItems: AUTO_EXECUTION_MAX_ITEMS
};

const normalizeAutomationStrategy = (
  input: AutomationStrategy | undefined,
  hasDualColumn: boolean
): AutomationStrategy => {
  const executionMode = input?.executionMode === 'auto_apply'
    ? 'auto_apply'
    : DEFAULT_AUTOMATION_STRATEGY.executionMode;
  const rawTarget = input?.targetPreference;
  let targetPreference: AutomationStrategy['targetPreference'] = DEFAULT_AUTOMATION_STRATEGY.targetPreference;
  if (rawTarget === 'original' || rawTarget === 'translated' || rawTarget === 'follow_selector') {
    targetPreference = rawTarget;
  }
  if (!hasDualColumn && targetPreference === 'translated') {
    targetPreference = 'follow_selector';
  }
  const riskTolerance = input?.riskTolerance === 'high'
    ? 'high'
    : input?.riskTolerance === 'low'
      ? 'low'
      : DEFAULT_AUTOMATION_STRATEGY.riskTolerance;
  const idleMs = Number.isFinite(input?.idleMs as number)
    ? Math.min(Math.max(Number(input?.idleMs), 20000), 120000)
    : DEFAULT_AUTOMATION_STRATEGY.idleMs;
  const maxItems = Number.isFinite(input?.maxItems as number)
    ? Math.min(Math.max(Math.round(Number(input?.maxItems)), 1), 5)
    : DEFAULT_AUTOMATION_STRATEGY.maxItems;

  return {
    executionMode,
    targetPreference,
    riskTolerance,
    idleMs,
    maxItems
  };
};

type EditorProps = {
  doc: Document;
  documents: Document[];
  onUpdate: (id: string, updates: Partial<Document>) => void;
  onCreateDoc: (parentId?: string | null, initialData?: { title?: string, content?: string }) => void;
  settings: Settings;
  snapshots: DocumentSnapshot[];
  onCreateSnapshot: () => void;
  onRestoreSnapshot: (snapshotId: string) => void;
  onDeleteSnapshot: (snapshotId: string) => void;
  skills: Skill[];
};

export default function Editor({ doc, documents, onUpdate, onCreateDoc, settings, snapshots, onCreateSnapshot, onRestoreSnapshot, onDeleteSnapshot, skills }: EditorProps) {
  const [isAiMenuOpen, setIsAiMenuOpen] = useState(false);
  const [showShareMenu, setShowShareMenu] = useState(false);
  const [showSnapshotMenu, setShowSnapshotMenu] = useState(false);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [aiSidebarWidth, setAiSidebarWidth] = useState(340);
  const [isResizingAiSidebar, setIsResizingAiSidebar] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [referencedPageIds, setReferencedPageIds] = useState<string[]>([]);
  const [showPageSelector, setShowPageSelector] = useState(false);
  const [showChatDocSelector, setShowChatDocSelector] = useState(false);
  const [chatDocFilter, setChatDocFilter] = useState<'all' | 'kb'>('kb');
  const [aiMode, setAiMode] = useState<AiEditMode>('replace');
  const [aiTarget, setAiTarget] = useState<'original' | 'translated'>('original');
  const [lastAiTarget, setLastAiTarget] = useState<'original' | 'translated'>('original');
  const [goalInput, setGoalInput] = useState('');
  const [goalConstraintsInput, setGoalConstraintsInput] = useState('');
  const [goalDeadlineInput, setGoalDeadlineInput] = useState('');
  const [goalPlanDraft, setGoalPlanDraft] = useState<GoalPlan | null>(null);
  const [isPlanningGoal, setIsPlanningGoal] = useState(false);
  const [goalPlanError, setGoalPlanError] = useState<string | null>(null);
  const goalAutoReplanTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastGoalPlanAtRef = useRef(0);
  const lastGoalPlanPlainTextRef = useRef('');

  const startResizingAiSidebar = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingAiSidebar(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingAiSidebar) return;
      // Calculate width from the right side of the screen
      const newWidth = Math.min(Math.max(window.innerWidth - e.clientX, 280), 600);
      setAiSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizingAiSidebar(false);
    };

    if (isResizingAiSidebar) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingAiSidebar]);
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [previewQueue, setPreviewQueue] = useState<PreviewQueueItem[]>([]);
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const [automationStrategy, setAutomationStrategy] = useState<AutomationStrategy>(() => normalizeAutomationStrategy(
    doc.automationStrategy,
    doc.translatedContent !== undefined
  ));
  const [customPrompt, setCustomPrompt] = useState('');
  const [completion, setCompletion] = useState('');
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [isGettingCompletion, setIsGettingCompletion] = useState(false);
  const [magicActionStatus, setMagicActionStatus] = useState<{ type: string, status: 'detecting' | 'processing' | 'done' | 'error', message?: string } | null>(null);
  const completionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const completionRequestSeqRef = useRef(0);
  const completionSignatureRef = useRef('');
  const [mode, setMode] = useState<'edit' | 'chat'>('edit');
  const [isChatTaskMode, setIsChatTaskMode] = useState(false);
  const [isAutoInsightCollapsed, setIsAutoInsightCollapsed] = useState(true);
  const [showGoalHub, setShowGoalHub] = useState(false);
  const [activeActionPanel, setActiveActionPanel] = useState<'creation' | 'format' | 'advanced'>('format');
  const [messages, setMessages] = useState<Array<{role: 'user' | 'assistant', content: string}>>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  const toggleShare = () => {
    onUpdate(doc.id, { isPublic: !doc.isPublic });
  };

  const copyShareLink = () => {
    const url = window.location.origin + '?id=' + doc.id + '&shared=true';
    navigator.clipboard.writeText(url);
    alert('链接已复制到剪贴板！');
  };
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const [scrollPercentage, setScrollPercentage] = useState(0);
  const [selectionContext, setSelectionContext] = useState<string | null>(null);
  const isDualColumn = doc.translatedContent !== undefined;
  const activePreviewItem = useMemo(
    () => previewQueue.find(item => item.id === activePreviewId) || null,
    [previewQueue, activePreviewId]
  );
  const safeActiveTarget = isDualColumn && aiTarget === 'translated' ? 'translated' : 'original';
  const safeLastTarget = isDualColumn && lastAiTarget === 'translated' ? 'translated' : 'original';
  const sanitizedAiResultHtml = useMemo(() => {
    const html = (aiResult || '').replace(/\[CREATE_PAGE\|.*?\|.*?\]/g, '');
    const withTypingIndicator = isProcessing
      ? `${html}<span class="inline-block w-1.5 h-4 bg-purple-500 animate-pulse ml-1"></span>`
      : html;
    return sanitizeHtml(withTypingIndicator);
  }, [aiResult, isProcessing]);
  const sanitizedDocPreviewHtml = useMemo(() => sanitizeHtml(doc.content), [doc.content]);
  const sanitizedAiComparePreviewHtml = useMemo(
    () => sanitizeHtml(safeLastTarget === 'translated' ? (doc.translatedContent || '') : doc.content),
    [safeLastTarget, doc.translatedContent, doc.content]
  );

  const handleAskAiAboutSelection = (text: string) => {
    setSelectionContext(text);
    setMode('chat');
    setIsAiMenuOpen(true);
    // 不再预填输入框，保持输入框清爽
    setCustomPrompt('');
  };

  const formatSnapshotTime = (isoDate: string) => {
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return isoDate;
    return date.toLocaleString();
  };

  useEffect(() => {
    const handleScroll = () => {
      if (scrollContainerRef.current) {
        const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
        const windowHeight = scrollHeight - clientHeight;
        if (windowHeight > 0) {
          const percentage = (scrollTop / windowHeight) * 100;
          setScrollPercentage(percentage);
        }
      }
    };

    const container = scrollContainerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
    }
    return () => container?.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (mode === 'chat' && chatContainerRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, mode]);

  useEffect(() => {
    setShowSnapshotMenu(false);
    setAutoInsightError(null);
    setAutoExecutionStatus(null);
    setIsChatTaskMode(false);
    setIsAutoInsightCollapsed(true);
    setPreviewQueue([]);
    setActivePreviewId(null);
    setAiResult(null);
    setAutomationStrategy(normalizeAutomationStrategy(doc.automationStrategy, doc.translatedContent !== undefined));
    setShowGoalHub(false);
    setActiveActionPanel('format');
    setAiTarget('original');
    setLastAiTarget('original');
    setGoalInput(doc.goalSource?.goal || '');
    setGoalConstraintsInput(doc.goalSource?.constraints || '');
    setGoalDeadlineInput(doc.goalSource?.deadline || '');
    setGoalPlanDraft(doc.goalPlan || null);
    setIsPlanningGoal(false);
    setGoalPlanError(null);
    if (goalAutoReplanTimeoutRef.current) {
      clearTimeout(goalAutoReplanTimeoutRef.current);
      goalAutoReplanTimeoutRef.current = null;
    }
    lastGoalPlanAtRef.current = doc.goalPlanUpdatedAt ? new Date(doc.goalPlanUpdatedAt).getTime() || 0 : 0;
    lastGoalPlanPlainTextRef.current = doc.content.replace(/<[^>]*>/g, '').trim();
    setIsTranslationTask(false);
    setTranslationStreamHtml('');
    translationStreamBufferRef.current = '';
    setCompletion('');
    setCompletionError(null);
    setIsGettingCompletion(false);
    completionSignatureRef.current = '';
    completionRequestSeqRef.current += 1;
    if (completionTimeoutRef.current) {
      clearTimeout(completionTimeoutRef.current);
      completionTimeoutRef.current = null;
    }
    const plainText = doc.content.replace(/<[^>]*>/g, '').trim();
    const baseSignature = `${doc.id}:${plainText.length}:${plainText.slice(0, 100)}:${plainText.slice(-120)}`;
    lastInsightSignatureRef.current = doc.autoInsightsUpdatedAt ? baseSignature : '';
    if (autoInsightTimeoutRef.current) {
      clearTimeout(autoInsightTimeoutRef.current);
      autoInsightTimeoutRef.current = null;
    }
    if (autoExecutionTimeoutRef.current) {
      clearTimeout(autoExecutionTimeoutRef.current);
      autoExecutionTimeoutRef.current = null;
    }
    lastAutoExecutionSignatureRef.current = '';
    lastAutoExecutionAtRef.current = 0;
  }, [doc.id]);

  useEffect(() => {
    if (doc.translatedContent !== undefined) return;
    setAiTarget('original');
    if (lastAiTarget === 'translated') {
      setLastAiTarget('original');
    }
  }, [doc.translatedContent, lastAiTarget]);

  useEffect(() => {
    const normalized = normalizeAutomationStrategy(doc.automationStrategy, doc.translatedContent !== undefined);
    setAutomationStrategy(normalized);
  }, [doc.id, doc.automationStrategy, doc.translatedContent]);

  useEffect(() => {
    if (doc.translatedContent !== undefined) return;
    if (automationStrategy.targetPreference !== 'translated') return;
    const next = normalizeAutomationStrategy({ ...automationStrategy, targetPreference: 'follow_selector' }, false);
    setAutomationStrategy(next);
    onUpdate(doc.id, { automationStrategy: next });
  }, [doc.id, doc.translatedContent, automationStrategy.targetPreference, onUpdate]);

  useEffect(() => {
    setGoalPlanDraft(doc.goalPlan || null);
  }, [doc.id, doc.goalPlanUpdatedAt]);

  useEffect(() => {
    return () => {
      if (autoInsightTimeoutRef.current) {
        clearTimeout(autoInsightTimeoutRef.current);
      }
      if (autoExecutionTimeoutRef.current) {
        clearTimeout(autoExecutionTimeoutRef.current);
      }
      if (goalAutoReplanTimeoutRef.current) {
        clearTimeout(goalAutoReplanTimeoutRef.current);
      }
      if (completionTimeoutRef.current) {
        clearTimeout(completionTimeoutRef.current);
      }
      completionRequestSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (settings.aiAutocomplete) return;
    setCompletion('');
    setCompletionError(null);
    setIsGettingCompletion(false);
    completionSignatureRef.current = '';
    completionRequestSeqRef.current += 1;
    if (completionTimeoutRef.current) {
      clearTimeout(completionTimeoutRef.current);
      completionTimeoutRef.current = null;
    }
  }, [settings.aiAutocomplete]);

  // AI 针对页面模式下的自动滚动跟随
  useEffect(() => {
    if (isProcessing && mode === 'edit' && aiResult && scrollContainerRef.current) {
      // 延迟一下确保 DOM 已更新
      const container = scrollContainerRef.current;
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [aiResult, isProcessing, mode]);
  
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const [attachedFiles, setAttachedFiles] = useState<Array<{ 
    id: string, 
    name: string, 
    type: 'file' | 'folder', 
    content?: string, 
    files?: Array<{ name: string, content: string }> 
  }>>([]);
  const [attachedLinks, setAttachedLinks] = useState<Array<{ url: string, content?: string, title?: string, status: 'pending' | 'loading' | 'done' | 'error' }>>([]);
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [newLinkUrl, setNewLinkUrl] = useState('');
  const [isSearchEnabled, setIsSearchEnabled] = useState(false);
  const [isAutoAnalyzing, setIsAutoAnalyzing] = useState(false);
  const [autoInsightError, setAutoInsightError] = useState<string | null>(null);
  const [autoExecutionStatus, setAutoExecutionStatus] = useState<{
    level: 'idle' | 'running' | 'success' | 'warning';
    message: string;
  } | null>(null);
  const autoInsightTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const autoExecutionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastAutoExecutionAtRef = useRef(0);
  const lastAutoExecutionSignatureRef = useRef('');
  const lastInsightSignatureRef = useRef<string>('');
  const latestGoalExecutionLog = doc.goalExecutionLog && doc.goalExecutionLog.length > 0
    ? doc.goalExecutionLog[doc.goalExecutionLog.length - 1]
    : null;
  const formatExecutionTrigger = (trigger: GoalExecutionLog['trigger']) => {
    if (trigger === 'auto_replan') return '自动重规划';
    if (trigger === 'init') return '初次拆解';
    if (trigger === 'auto_execute') return '自动执行';
    if (trigger === 'manual_execute') return '手动执行';
    return '手动重规划';
  };
  const [tavilyApiKey, setTavilyApiKey] = useState(() => {
    return localStorage.getItem('tavily_api_key') || '';
  });
  const [showApiSettings, setShowApiSettings] = useState(false);

  useEffect(() => {
    localStorage.setItem('tavily_api_key', tavilyApiKey);
  }, [tavilyApiKey]);

  const handleTavilySearch = async (query: string) => {
    if (!tavilyApiKey) {
      alert('请先配置 Tavily API Key 以启用联网搜索功能。');
      setShowApiSettings(true);
      return null;
    }

    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyApiKey,
          query: query,
          search_depth: "advanced",
          include_answer: true,
          max_results: 5
        })
      });

      if (!response.ok) throw new Error('搜索服务暂时不可用');
      const data = await response.json();
      return data;
    } catch (err) {
      console.error("Tavily search error:", err);
      return null;
    }
  };

  const handleAddLink = async (url: string) => {
    if (!url || !url.startsWith('http')) {
      alert('请输入有效的网页链接 (需以 http:// 或 https:// 开头)');
      return;
    }
    
    const linkId = Date.now().toString();
    const newLink = { url, status: 'loading' as const };
    setAttachedLinks(prev => [...prev, newLink]);
    setShowLinkInput(false);
    setNewLinkUrl('');

    try {
      // 使用 Jina Reader API 获取网页内容，它能将网页转换为适合 LLM 阅读的 Markdown
      const response = await fetch(`https://r.jina.ai/${url}`, {
        headers: { 'X-Return-Format': 'markdown' }
      });
      
      if (!response.ok) throw new Error('无法获取网页内容');
      
      const content = await response.text();
      // 简单提取标题
      const titleMatch = content.match(/^# (.*)/m);
      const title = titleMatch ? titleMatch[1] : url.split('/').pop() || url;

      setAttachedLinks(prev => prev.map(l => 
        l.url === url ? { ...l, content, title, status: 'done' } : l
      ));
    } catch (err) {
      console.error("Link fetch error:", err);
      setAttachedLinks(prev => prev.map(l => 
        l.url === url ? { ...l, status: 'error' } : l
      ));
    }
  };

  const handleCoverUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        onUpdate(doc.id, { coverImage: reader.result as string });
      };
      reader.readAsDataURL(file);
    }
  };

  const handleChatFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileList: Array<{ name: string, content: string }> = [];
    const maxFiles = 50; 
    let processedCount = 0;

    // 检查是否包含文件夹路径 (webkitRelativePath)
    const firstFilePath = (files[0] as any).webkitRelativePath;
    const isFolderUpload = firstFilePath && firstFilePath.includes('/');
    const folderName = isFolderUpload ? firstFilePath.split('/')[0] : null;

    for (let i = 0; i < files.length; i++) {
      if (processedCount >= maxFiles) break;
      
      const file = files[i];
      const isText = file.type.startsWith('text/') || 
                     /\.(md|txt|js|ts|tsx|jsx|json|css|html|py|java|c|cpp|go|rs|rb|php|sql|yaml|yml|toml)$/i.test(file.name);
      const isDocx = /\.(docx|doc)$/i.test(file.name);
      const isPdf = /\.(pdf)$/i.test(file.name);

      if (isText) {
        try {
          const content = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsText(file);
          });
          
          const name = (file as any).webkitRelativePath || file.name;
          fileList.push({ name, content });
          processedCount++;
        } catch (err) {
          console.error(`Failed to read file: ${file.name}`, err);
        }
      } else if (isDocx) {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const mammoth = await import('mammoth');
          const result = await mammoth.extractRawText({ arrayBuffer });
          const content = result.value;
          
          const name = (file as any).webkitRelativePath || file.name;
          fileList.push({ name, content });
          processedCount++;
        } catch (err) {
          console.error(`Failed to read docx file: ${file.name}`, err);
        }
      } else if (isPdf) {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const pdfjs = await import('pdfjs-dist');
          const worker = await import('pdfjs-dist/build/pdf.worker.mjs?url');
          pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
          
          const pdf = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
          let content = '';
          for (let j = 1; j <= pdf.numPages; j++) {
            const page = await pdf.getPage(j);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map((item: any) => item.str).join(' ');
            content += `[Page ${j}]\n${pageText}\n\n`;
          }
          
          const name = (file as any).webkitRelativePath || file.name;
          fileList.push({ name, content });
          processedCount++;
        } catch (err) {
          console.error(`Failed to read pdf file: ${file.name}`, err);
        }
      }
    }

    if (fileList.length > 0) {
      if (isFolderUpload && folderName && fileList.length > 1) {
        // 作为一个整体文件夹添加
        setAttachedFiles(prev => [...prev, {
          id: Date.now().toString(),
          name: folderName,
          type: 'folder',
          files: fileList
        }]);
      } else {
        // 作为独立文件添加
        const individualFiles = fileList.map(f => ({
          id: Math.random().toString(36).substr(2, 9),
          name: f.name,
          type: 'file' as const,
          content: f.content
        }));
        setAttachedFiles(prev => [...prev, ...individualFiles]);
      }
    }

    if (files.length > maxFiles) {
      alert(`内容过多，已自动筛选前 ${maxFiles} 个核心代码/文本文件进行分析。`);
    }
    
    if (chatFileInputRef.current) chatFileInputRef.current.value = '';
  };

  const removeCover = () => {
    onUpdate(doc.id, { coverImage: undefined });
  };

  const COMMON_EMOJIS = [
    // 写作与办公
    '📝', '📅', '📊', '📂', '📁', '📌', '📎', '💻', '🖥️', '📱', '⌨️', '🖱️', '🖨️', '📦', '🏗️', '🛠️', '⚙️', '🧪', '🧬', '🧠',
    // 创意与灵感
    '✨', '🚀', '💡', '🌟', '🔥', '🌈', '🎨', '🎭', '🎬', '📸', '🌿', '🌸', '🍄', '🌍', '☀️', '🌙', '☁️', '🌊', '⚡', '💎',
    // 状态与符号
    '✅', '❌', '⚠️', '🚩', '🎯', '🏆', '🔔', '🔑', '🏠', '🍎', '☕', '🎸', '🎧', '📚', '🖊️', '⚽', '🎮', '🏃', '✈️', '🎨'
  ];

  const handleIconSelect = (emoji: string) => {
    onUpdate(doc.id, { icon: emoji });
    setShowIconPicker(false);
  };

  const removeIcon = () => {
    onUpdate(doc.id, { icon: undefined });
  };

  useEffect(() => {
    if (titleRef.current) {
      titleRef.current.style.height = 'auto';
      titleRef.current.style.height = titleRef.current.scrollHeight + 'px';
    }
  }, [doc.title]);

  const [selectedActions, setSelectedActions] = useState<string[]>([]);

  const toggleAction = (action: string) => {
    setSelectedActions(prev => 
      prev.includes(action) ? prev.filter(a => a !== action) : [...prev, action]
    );
  };

  const clearSelectedActions = () => {
    setSelectedActions([]);
  };

  const creationActionItems = [
    { key: 'write', label: '帮我写作', icon: PenTool },
    { key: 'polish', label: '智能润色', icon: Eraser },
    { key: 'template', label: '生成模板', icon: LayoutTemplate },
    { key: 'summarize', label: '全文总结', icon: FileSearch }
  ];

  const formatActionItems = [
    { key: 'format', label: '美化格式', icon: TypeIcon },
    { key: 'paragraphs', label: '划分段落', icon: AlignLeft },
    { key: 'organize', label: '整理逻辑', icon: ListTree },
    { key: 'generate_table', label: '制作表格', icon: TableIcon },
    { key: 'generate_schedule', label: '生成日程', icon: CalendarDays },
    { key: 'grammar', label: '纠正语法', icon: Zap },
    { key: 'translate', label: '翻译页面', icon: Languages }
  ];

  const advancedActionItems = [
    { key: 'tone_pro', label: '改为专业语调', icon: Library },
    { key: 'tone_casual', label: '改为友好语调', icon: Smile },
    { key: 'explain', label: '解释内容代码', icon: Code },
    { key: 'action_items', label: '提取待办事项', icon: CheckSquare }
  ];

  const actionPanelTabs = [
    { key: 'creation' as const, label: '内容创作' },
    { key: 'format' as const, label: '格式工具' },
    { key: 'advanced' as const, label: '专业分析' }
  ];

  const activeActionItems = activeActionPanel === 'creation'
    ? creationActionItems
    : activeActionPanel === 'format'
      ? formatActionItems
      : advancedActionItems;

  const activeActionPanelHint = activeActionPanel === 'creation'
    ? '快速写作、润色、模板与总结'
    : activeActionPanel === 'format'
      ? '文本结构、格式整理与翻译'
      : '语调切换、解释与任务提取';

  const actionLabelMap = [...creationActionItems, ...formatActionItems, ...advancedActionItems].reduce<Record<string, string>>((acc, item) => {
    acc[item.key] = item.label;
    return acc;
  }, {});

  const updateAutomationStrategy = (updater: (prev: AutomationStrategy) => AutomationStrategy) => {
    setAutomationStrategy(prev => {
      const next = normalizeAutomationStrategy(updater(prev), doc.translatedContent !== undefined);
      onUpdate(doc.id, { automationStrategy: next });
      return next;
    });
  };

  const formatAutoIdleLabel = (ms: number) => `${Math.round(ms / 1000)}s`;

  const getAiModeLabel = (mode: AiEditMode) => {
    if (mode === 'append') return '末尾追加';
    if (mode === 'prepend') return '首部插入';
    if (mode === 'update_block') return '更新块';
    return '全量替换';
  };

  const getAiModeHint = (mode: AiEditMode) => {
    if (mode === 'append') return '✨ 仅生成新增内容并追加到目标栏末尾';
    if (mode === 'prepend') return '📌 仅生成新增内容并插入到目标栏开头';
    if (mode === 'update_block') return '🧩 生成段落级 patch（精准改段，不重写整篇）';
    return '📝 重组并输出整篇内容，适合结构性调整';
  };

  const renderAiUpdateBlock = (content: string, target: 'original' | 'translated') => {
    const targetLabel = target === 'translated' ? '译文栏' : '原文栏';
    return `<div class="ai-update-block my-4 rounded-xl border border-purple-200 bg-purple-50/60 px-4 py-3">
      <div class="text-[11px] font-bold text-purple-600 mb-2">AI 更新块 · ${targetLabel} · ${new Date().toLocaleString()}</div>
      ${content}
    </div>`;
  };

  const normalizePatchText = (input: string) => input.replace(/\s+/g, ' ').trim();

  const normalizeParagraphPatches = (payload: any): ParagraphPatch[] => {
    const rawPatches = Array.isArray(payload?.patches) ? payload.patches : [];
    return rawPatches
      .map((raw: any, index: number) => {
        const action = String(raw?.action || '').trim().toLowerCase() as ParagraphPatchAction;
        if (!['replace', 'insert_before', 'insert_after', 'delete'].includes(action)) return null;
        const find = normalizePatchText(String(raw?.find || ''));
        if (!find) return null;
        const content = typeof raw?.content === 'string' ? raw.content.trim() : '';
        if (action !== 'delete' && !content) return null;
        return {
          id: typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : `patch-${Date.now()}-${index}`,
          action,
          find,
          content: content || undefined,
          reason: typeof raw?.reason === 'string' ? raw.reason.trim() : undefined
        } as ParagraphPatch;
      })
      .filter(Boolean)
      .slice(0, 12) as ParagraphPatch[];
  };

  const applyParagraphPatchesToHtml = (
    html: string,
    patches: ParagraphPatch[]
  ): { html: string; appliedPatchIds: string[]; skippedPatchIds: string[] } => {
    const container = document.createElement('div');
    container.innerHTML = html || '';
    const blockSelector = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th';
    const appliedPatchIds: string[] = [];
    const skippedPatchIds: string[] = [];

    const findBlockElement = (snippet: string): Element | null => {
      const snippetText = normalizePatchText(snippet);
      if (!snippetText) return null;
      const blocks = Array.from(container.querySelectorAll(blockSelector));
      for (const block of blocks) {
        const text = normalizePatchText(block.textContent || '');
        if (!text) continue;
        if (text.includes(snippetText) || snippetText.includes(text)) {
          return block;
        }
      }
      return null;
    };

    for (const patch of patches) {
      const targetBlock = findBlockElement(patch.find);
      if (!targetBlock) {
        skippedPatchIds.push(patch.id);
        continue;
      }

      try {
        if (patch.action === 'replace') {
          targetBlock.outerHTML = patch.content || '';
        } else if (patch.action === 'insert_before') {
          targetBlock.insertAdjacentHTML('beforebegin', patch.content || '');
        } else if (patch.action === 'insert_after') {
          targetBlock.insertAdjacentHTML('afterend', patch.content || '');
        } else if (patch.action === 'delete') {
          targetBlock.remove();
        }
        appliedPatchIds.push(patch.id);
      } catch {
        skippedPatchIds.push(patch.id);
      }
    }

    return {
      html: container.innerHTML,
      appliedPatchIds,
      skippedPatchIds
    };
  };

  const getPreviewTitle = (
    actions: string[],
    prompt: string | undefined,
    trigger: GoalExecutionLog['trigger']
  ) => {
    const prefix = trigger === 'auto_execute' ? '自动·' : '';
    const promptLine = (prompt || '').split('\n').map(line => line.trim()).find(Boolean) || '';
    if (promptLine) {
      const shortPrompt = promptLine.length > 22 ? `${promptLine.slice(0, 22)}...` : promptLine;
      return `${prefix}${shortPrompt}`;
    }
    if (actions.length > 0) {
      const label = actions
        .slice(0, 2)
        .map(action => actionLabelMap[action] || action)
        .join(' + ');
      return `${prefix}${label}`;
    }
    return `${prefix}AI 预览`;
  };

  const activatePreviewItem = (previewId: string) => {
    const item = previewQueue.find(entry => entry.id === previewId);
    if (!item) return;
    setActivePreviewId(item.id);
    setAiResult(item.content);
    setLastAiTarget(item.target);
  };

  const removePreviewItemFromQueue = (previewId: string) => {
    setPreviewQueue(prev => {
      const next = prev.filter(item => item.id !== previewId);
      if (next.length === 0) {
        setActivePreviewId(null);
        setAiResult(null);
        return next;
      }

      const activeStillExists = activePreviewId ? next.some(item => item.id === activePreviewId) : false;
      if (!activeStillExists || activePreviewId === previewId) {
        const fallback = next[0];
        setActivePreviewId(fallback.id);
        setAiResult(fallback.content);
        setLastAiTarget(fallback.target);
      }
      return next;
    });
  };

  const clearPreviewQueue = () => {
    setPreviewQueue([]);
    setActivePreviewId(null);
    setAiResult(null);
  };

  const getPatchActionLabel = (action: ParagraphPatchAction) => {
    if (action === 'replace') return '替换段落';
    if (action === 'insert_before') return '前插一段';
    if (action === 'insert_after') return '后插一段';
    return '删除段落';
  };

  const applySinglePatchFromPreview = (previewId: string, patchId: string) => {
    const previewItem = previewQueue.find(item => item.id === previewId);
    if (!previewItem || previewItem.mode !== 'update_block' || !previewItem.patches?.length) return;
    const patch = previewItem.patches.find(item => item.id === patchId);
    if (!patch) return;

    const applyToTranslated = previewItem.target === 'translated' && doc.translatedContent !== undefined;
    const sourceHtml = applyToTranslated ? (doc.translatedContent || '') : doc.content;
    const singleResult = applyParagraphPatchesToHtml(sourceHtml, [patch]);
    if (singleResult.appliedPatchIds.length === 0) {
      setAutoExecutionStatus({
        level: 'warning',
        message: '该段落 patch 未命中，请调整后再试。'
      });
      return;
    }

    onCreateSnapshot();
    if (applyToTranslated) {
      onUpdate(doc.id, { translatedContent: singleResult.html });
    } else {
      onUpdate(doc.id, { content: singleResult.html });
    }

    const remainingPatches = previewItem.patches.filter(item => item.id !== patchId);
    if (remainingPatches.length === 0) {
      removePreviewItemFromQueue(previewId);
      return;
    }

    const nextPreviewHtml = applyParagraphPatchesToHtml(singleResult.html, remainingPatches).html;
    setPreviewQueue(prev => prev.map(item => (
      item.id === previewId
        ? {
            ...item,
            patches: remainingPatches,
            content: nextPreviewHtml,
            title: `${item.title.replace(/\s*\(\d+ patches\)$/i, '')} (${remainingPatches.length} patches)`
          }
        : item
    )));
    if (activePreviewId === previewId) {
      setAiResult(nextPreviewHtml);
    }
  };

  const dismissSinglePatchFromPreview = (previewId: string, patchId: string) => {
    const previewItem = previewQueue.find(item => item.id === previewId);
    if (!previewItem || previewItem.mode !== 'update_block' || !previewItem.patches?.length) return;
    const remainingPatches = previewItem.patches.filter(item => item.id !== patchId);
    if (remainingPatches.length === 0) {
      removePreviewItemFromQueue(previewId);
      return;
    }

    const currentBaseHtml = previewItem.target === 'translated' && doc.translatedContent !== undefined
      ? (doc.translatedContent || '')
      : doc.content;
    const nextPreviewHtml = applyParagraphPatchesToHtml(currentBaseHtml, remainingPatches).html;

    setPreviewQueue(prev => prev.map(item => (
      item.id === previewId
        ? {
            ...item,
            patches: remainingPatches,
            content: nextPreviewHtml,
            title: `${item.title.replace(/\s*\(\d+ patches\)$/i, '')} (${remainingPatches.length} patches)`
          }
        : item
    )));
    if (activePreviewId === previewId) {
      setAiResult(nextPreviewHtml);
    }
  };

  const handleRunAi = () => {
    if (mode === 'chat') {
      handleChatAction();
    } else {
      if (selectedActions.length > 0 || customPrompt.trim()) {
        handleAiAction(selectedActions, customPrompt);
      }
    }
  };

  const handleNewChat = () => {
    setMessages([]);
    setCustomPrompt('');
    setAttachedFiles([]);
    setAttachedLinks([]);
    setReferencedPageIds([]);
    setSelectionContext(null);
  };

  const handleChatAction = async () => {
    if (!customPrompt.trim() && attachedFiles.length === 0 && attachedLinks.length === 0 && !selectionContext) return;
    const allowTaskExecution = isChatTaskMode;
    
    const userMessage = customPrompt;
    const filesToUpload = [...attachedFiles];
    const linksToInclude = [...attachedLinks.filter(l => l.status === 'done')];
    const currentSelection = selectionContext;
    
    setCustomPrompt('');
    setAttachedFiles([]);
    setAttachedLinks([]);
    setSelectionContext(null);

    let messageContent = userMessage;
    const contexts = [];
    
    if (currentSelection) {
      contexts.push(`[Selected Text Context]:\n"""\n${currentSelection}\n"""`);
    }
    
    if (filesToUpload.length > 0) {
      const fileContexts = filesToUpload.map(item => {
        if (item.type === 'folder' && item.files) {
          return `--- FOLDER: ${item.name} ---\n${item.files.map(f => `[File: ${f.name}]\n${f.content}`).join('\n\n')}`;
        } else {
          return `--- FILE: ${item.name} ---\n${item.content}`;
        }
      });
      contexts.push(`[Attached Files & Folders Context]:\n${fileContexts.join('\n\n---\n\n')}`);
    }
    
    if (linksToInclude.length > 0) {
      contexts.push(`[Attached Web Content Context]:\n${linksToInclude.map(l => `--- URL: ${l.url} (Title: ${l.title}) ---\n${l.content}`).join('\n\n')}`);
    }

    if (contexts.length > 0) {
      messageContent = `${userMessage}\n\nKNOWLEDGE CONTEXT:\n${contexts.join('\n\n---\n\n')}`;
    }

    // 处理联网搜索
    let searchInstruction = "";
    const shouldAutoSearch = !isSearchEnabled && !!tavilyApiKey && AUTO_WEB_SEARCH_PATTERN.test(userMessage);
    if (isSearchEnabled || shouldAutoSearch) {
      setMessages(prev => [...prev, { role: 'user', content: userMessage + (shouldAutoSearch ? ' (🤖 自动联网检索中...)' : ' (🌐 正在搜索联网信息...)') }]);
      setIsProcessing(true);
      const searchData = await handleTavilySearch(userMessage);
      if (searchData && searchData.results) {
        const searchContext = `[Web Search Results]:\n${searchData.results.map((r: any) => `--- SOURCE: ${r.title} (${r.url}) ---\n${r.content}`).join('\n\n')}`;
        messageContent = `${messageContent}\n\nWEB SEARCH CONTEXT:\n${searchContext}`;
        searchInstruction = shouldAutoSearch
          ? "\n\nCRITICAL: Automatic web search has been enabled because the user likely needs real-time information. You MUST prioritize 'WEB SEARCH CONTEXT'."
          : "\n\nCRITICAL: Web search is ENABLED. You MUST prioritize the information in 'WEB SEARCH CONTEXT' to answer. This context contains real-time data from the internet. If there's a conflict between your internal knowledge and the search results, trust the search results.";
      }
    } else {
      const displayMessage = (filesToUpload.length > 0 || linksToInclude.length > 0 || currentSelection)
        ? `${userMessage}${currentSelection ? ' (📍 已引用选中文字)' : ''}${filesToUpload.length > 0 ? ` (📂 已分析 ${filesToUpload.length} 个文件)` : ''}${linksToInclude.length > 0 ? ` (🌐 ${linksToInclude.length} 个网页)` : ''}` 
        : userMessage;

      setMessages(prev => [...prev, { role: 'user', content: displayMessage }]);
      setIsProcessing(true);
    }

    try {
      // 1. 获取当前文章上下文
      const documentContext = doc.content 
        ? `\n\nCurrent Document Content:\n"""\n${doc.content}\n"""\n\n(The user may ask questions about the above content)`
        : '';

      // 2. 获取跨文档知识库上下文 (所有标记为知识库的页面)
      const otherDocs = documents.filter(d => d.id !== doc.id && !d.isDeleted && d.isInKnowledgeBase);
      const kbContext = otherDocs.length > 0 
        ? `\n\nWORKSPACE KNOWLEDGE BASE:\nYou have access to the following other documents in the user's workspace. Use this information to answer questions that span multiple documents or refer to other pages:\n${otherDocs.map(d => `--- DOCUMENT: ${d.title} ---\n${d.content.replace(/<[^>]*>/g, '').substring(0, 500)}...`).join('\n\n')}\n\nIf the user asks "what else do I have?" or "summarize my workspace", refer to these documents.`
        : '';

      // 3. 获取手动引用的页面内容 (优先级更高)
      const referencedPages = documents.filter(d => referencedPageIds.includes(d.id));
      const refContext = referencedPages.length > 0
        ? `\n\nMANUALLY REFERENCED DOCUMENTS (SPECIFIC CONTEXT):\nThe user has specifically referenced these documents for this chat. PRIORITIZE using their content to answer:\n${referencedPages.map(d => `--- REFERENCE: ${d.title} ---\n${d.content.replace(/<[^>]*>/g, '')}`).join('\n\n')}`
        : '';

      const pageCreationInstruction = allowTaskExecution
        ? "\n\nPAGE CREATION CAPABILITY: You can create new pages for the user. If the user explicitly asks to create a NEW page, document, or article (e.g., 'put this in a new page'), you MUST include a special command at the END of your response in this exact format: [CREATE_PAGE|Title|Content]. The Title should be short and the Content should be formatted in HTML (without markdown code blocks). For example: [CREATE_PAGE|My New Article|<h1>My New Article</h1><p>Content goes here...</p>]. Ensure Title and Content do not contain the '|' or ']' characters directly. Do not mention this command in your natural language response to the user, just add it at the very end. Do not repeat the original document content in your natural language response if you are creating a new page."
        : "\n\nDISCUSSION MODE: The user is chatting only. Do NOT output any workspace command tags such as [CREATE_PAGE|...]. Do NOT trigger task execution behavior automatically. Provide analysis, suggestions, and options only.";

      const notionDerivedGuardrails =
        "\n\nNOTION-STYLE GUARDRAILS: Keep scope tight and avoid over-performing. If context is insufficient, ask one focused follow-up question. Never fabricate facts, links, or source references. If uncertainty exists, state it clearly and provide a verification path.";

      const skillsContext = skills && skills.length > 0
        ? `\n\nAVAILABLE SKILLS: You have access to the following special skills. If the user's request matches a skill's purpose, use the skill's specific prompt logic as a guide:\n${skills.map(s => `- [${s.name}]: ${s.description}\n  Logic: ${s.prompt}`).join('\n')}`
        : '';

      const systemInstruction = `Today's Date: ${new Date().toLocaleDateString()}\n\nYou are a helpful AI assistant. You can help users with writing, analysis, or general questions. Always be concise and friendly.` + 
        pageCreationInstruction +
        notionDerivedGuardrails +
        searchInstruction +
        "\n\nWORKSPACE OPERATIONS: You can help users manage their workspace. If the user asks to delete a page, archive it, or rename it, confirm you understand and guide them to use the sidebar buttons. You do NOT have direct deletion permissions for existing pages via commands yet, but you can create new ones." +
        "\n\nFORMATTING: For task lists (checklists), use <ul data-type=\"taskList\"><li data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p>Task text</p></div></li></ul> format in your HTML content." +
        skillsContext +
        documentContext + kbContext + refContext;
      
      // 4. 构建包含历史记录的完整 prompt
      const historyContext = messages.slice(-10).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
      
      let fullPrompt = "";
      if (historyContext) {
        fullPrompt += `${historyContext}\n`;
      }
      fullPrompt += `User: ${messageContent}`;
      
      // 添加一个空的助手机息用于流式显示
      setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
      
      let finalAssistantResponse = "";
      await callApi(systemInstruction, fullPrompt, false, (chunk) => {
        finalAssistantResponse += chunk;
        setMessages(prev => {
          const newMessages = [...prev];
          const lastIndex = newMessages.length - 1;
          const lastMessage = newMessages[lastIndex];
          if (lastMessage && lastMessage.role === 'assistant') {
            // 在流式输出中先移除指令标签，避免显示给用户
            const cleanContent = (lastMessage.content + chunk).replace(/\[CREATE_PAGE\|.*?\|.*?\]/g, '');
            newMessages[lastIndex] = { ...lastMessage, content: cleanContent };
          }
          return newMessages;
        });
      });

      // 4. 处理指令 (例如新建页面)
      const pageMatch = finalAssistantResponse.match(/\[CREATE_PAGE\|(.*?)\|(.*?)\]/);
      if (allowTaskExecution && pageMatch) {
        const title = pageMatch[1].trim();
        const content = pageMatch[2].trim();
        
        // 在对话中先提示即将跳转
        setMessages(prev => {
          const newMessages = [...prev];
          const lastIndex = newMessages.length - 1;
          if (newMessages[lastIndex]?.role === 'assistant') {
            newMessages[lastIndex].content += `\n\n✨ **正在为你跳转到新页面：${title}...**`;
          }
          return newMessages;
        });

        // 延迟一小会儿执行跳转，给用户一个阅读提示的时间
        setTimeout(() => {
          onCreateDoc(null, { title, content });
          // 关闭侧边栏，因为用户通常会想看新页面
          setIsAiMenuOpen(false);
        }, 1500);
      } else if (!allowTaskExecution && pageMatch) {
        setMessages(prev => {
          const next = [...prev];
          const lastIndex = next.length - 1;
          if (lastIndex >= 0 && next[lastIndex].role === 'assistant') {
            next[lastIndex] = {
              ...next[lastIndex],
              content: `${next[lastIndex].content}\n\n> 已拦截任务执行：当前是讨论模式。开启“任务模式”后可执行创建页面。`
            };
          }
          return next;
        });
      }
      
    } catch (error) {
      console.error("Chat Error:", error);
      setMessages(prev => [...prev, { role: 'assistant', content: "抱歉，出现错误，请稍后再试。" }]);
    } finally {
      setIsProcessing(false);
    }
  };

  const callApi = async (systemInstruction: string, userPrompt: string, requireJson: boolean = false, onChunk?: (chunk: string) => void) => {
    if (settings.apiProvider === 'gemini' || (!settings.apiUrl && !settings.apiKey)) {
      // Use user-provided API key if available, otherwise fallback to env
      const apiKey = settings.apiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error('未配置 Gemini API Key。请在设置中输入 API Key 或在环境变量中配置。');
      }
      
      const genAI = new GoogleGenerativeAI(apiKey);
      const generationConfig: any = {};
      if (requireJson) {
        generationConfig.responseMimeType = "application/json";
        generationConfig.responseSchema = {
          type: SchemaType.OBJECT,
          properties: {
            optimizedContent: { type: SchemaType.STRING },
            translatedContent: { type: SchemaType.STRING }
          },
          required: ["optimizedContent", "translatedContent"]
        };
      }

      const model = genAI.getGenerativeModel({ 
        model: 'gemini-1.5-flash',
        systemInstruction: systemInstruction,
        generationConfig
      });

      if (onChunk) {
        const result = await model.generateContentStream(userPrompt);

        let fullText = "";
        for await (const chunk of result.stream) {
          const chunkText = chunk.text();
          fullText += chunkText;
          onChunk(chunkText);
        }
        return fullText;
      } else {
        const result = await model.generateContent(userPrompt);
        return result.response.text();
      }
    } else {
      // Use custom OpenAI-compatible API
      const messages = [
        { role: "system", content: systemInstruction },
        { role: "user", content: userPrompt }
      ];
      
      const cleanUrl = settings.apiUrl.replace(/\/+$/, '');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

      try {
        const body: any = {
          model: settings.selectedModel || 'default',
          messages,
          stream: !!onChunk
        };

        if (requireJson && settings.apiProvider === 'openai') {
           body.response_format = { type: "json_object" };
        }

        const response = await fetch(`${cleanUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.apiKey}`
          },
          signal: controller.signal,
          body: JSON.stringify(body)
        });
        
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(`API Error: ${response.status} ${errorData.error?.message || ''}`);
        }
        
        if (onChunk && response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let fullContent = "";
          
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n').filter(line => line.trim() !== '');
            
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const dataStr = line.slice(6);
                if (dataStr === '[DONE]') break;
                try {
                  const data = JSON.parse(dataStr);
                  const content = data.choices?.[0]?.delta?.content || "";
                  if (content) {
                    fullContent += content;
                    onChunk(content);
                  }
                } catch (e) {
                  console.warn("Error parsing SSE chunk:", e);
                }
              }
            }
          }
          return fullContent;
        } else {
          const data = await response.json();
          let content = data.choices?.[0]?.message?.content;
          if (!content) throw new Error('Invalid API response: no content');
          
          if (requireJson) {
             content = content.trim();
             if (content.startsWith('```')) {
               content = content.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '');
             }
          }
          return content;
        }
      } catch (error: any) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
          throw new Error('Request timed out after 60 seconds');
        }
        throw error;
      }
    }
  };

  const parseAiJsonPayload = (rawText: string): any | null => {
    const text = rawText.trim();
    if (!text) return null;

    let candidate = text;
    if (candidate.startsWith('```')) {
      candidate = candidate.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    try {
      return JSON.parse(candidate);
    } catch {
      const firstBrace = candidate.indexOf('{');
      const lastBrace = candidate.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const sliced = candidate.slice(firstBrace, lastBrace + 1);
        try {
          return JSON.parse(sliced);
        } catch {
          return null;
        }
      }
      return null;
    }
  };

  const normalizeGoalStatus = (value: unknown): 'todo' | 'doing' | 'done' | 'blocked' => {
    if (value === 'doing' || value === 'done' || value === 'blocked') return value;
    return 'todo';
  };

  const normalizePriority = (value: unknown): 'p0' | 'p1' | 'p2' => {
    if (value === 'p0' || value === 'p2') return value;
    return 'p1';
  };

  const normalizeRiskLevel = (value: unknown): 'low' | 'medium' | 'high' => {
    if (value === 'low' || value === 'high') return value;
    return 'medium';
  };

  const makeGoalItemId = (prefix: string, index: number) => `${prefix}-${Date.now()}-${index}`;

  const estimateTextDiffMagnitude = (previousText: string, currentText: string): number => {
    if (previousText === currentText) return 0;
    const minLen = Math.min(previousText.length, currentText.length);
    let mismatch = Math.abs(previousText.length - currentText.length);
    for (let i = 0; i < minLen; i += 1) {
      if (previousText[i] !== currentText[i]) {
        mismatch += 1;
      }
      if (mismatch >= 1000) {
        return mismatch;
      }
    }
    return mismatch;
  };

  const normalizeGoalPlan = (input: any): GoalPlan | null => {
    if (!input || typeof input !== 'object') return null;

    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (!summary) return null;

    const milestonesRaw = Array.isArray(input.milestones) ? input.milestones : [];
    const tasksRaw = Array.isArray(input.tasks) ? input.tasks : [];
    const nextActionsRaw = Array.isArray(input.nextActions) ? input.nextActions : [];
    const risksRaw = Array.isArray(input.risks) ? input.risks : [];

    const milestones = milestonesRaw
      .map((item: any, index: number) => {
        const title = typeof item?.title === 'string' ? item.title.trim() : '';
        if (!title) return null;
        return {
          id: typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : makeGoalItemId('ms', index),
          title,
          due: typeof item?.due === 'string' && item.due.trim() ? item.due.trim() : undefined,
          status: normalizeGoalStatus(item?.status)
        };
      })
      .filter(Boolean)
      .slice(0, GOAL_PLAN_MAX_MILESTONES) as GoalPlan['milestones'];

    const tasks = tasksRaw
      .map((item: any, index: number) => {
        const title = typeof item?.title === 'string' ? item.title.trim() : '';
        if (!title) return null;
        return {
          id: typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : makeGoalItemId('task', index),
          title,
          priority: normalizePriority(item?.priority),
          milestoneId: typeof item?.milestoneId === 'string' && item.milestoneId.trim() ? item.milestoneId.trim() : undefined,
          status: normalizeGoalStatus(item?.status),
          owner: item?.owner === 'me' ? 'me' : undefined
        };
      })
      .filter(Boolean)
      .slice(0, GOAL_PLAN_MAX_TASKS) as GoalPlan['tasks'];

    const nextActions = nextActionsRaw
      .map((item: any, index: number) => {
        const title = typeof item?.title === 'string' ? item.title.trim() : '';
        if (!title) return null;
        const reason = typeof item?.reason === 'string' ? item.reason.trim() : '';
        return {
          id: typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : makeGoalItemId('next', index),
          title,
          reason: reason || '与当前目标最相关的下一步动作'
        };
      })
      .filter(Boolean)
      .slice(0, GOAL_PLAN_MAX_NEXT_ACTIONS) as GoalPlan['nextActions'];

    const risks = risksRaw
      .map((item: any, index: number) => {
        const title = typeof item?.title === 'string' ? item.title.trim() : '';
        if (!title) return null;
        return {
          id: typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : makeGoalItemId('risk', index),
          title,
          level: normalizeRiskLevel(item?.level),
          mitigation: typeof item?.mitigation === 'string' && item.mitigation.trim() ? item.mitigation.trim() : undefined
        };
      })
      .filter(Boolean)
      .slice(0, GOAL_PLAN_MAX_RISKS) as GoalPlan['risks'];

    if (tasks.length === 0 && nextActions.length === 0) return null;

    return {
      version: 'v1',
      summary,
      milestones,
      tasks,
      nextActions,
      risks
    };
  };

  const renderGoalPlanAsHtml = (plan: GoalPlan): string => {
    const summaryHtml = `<section data-goal-section="summary" class="mb-6"><h2>目标摘要</h2><p>${escapeHtml(plan.summary)}</p></section>`;

    const milestoneHtml = plan.milestones.length > 0
      ? `<section data-goal-section="milestones" class="mb-6"><h2>里程碑</h2><ul>${plan.milestones.map((item) => `<li><strong>${escapeHtml(item.title)}</strong>${item.due ? `（截止：${escapeHtml(item.due)}）` : ''} - ${escapeHtml(item.status)}</li>`).join('')}</ul></section>`
      : '';

    const taskHtml = plan.tasks.length > 0
      ? `<section data-goal-section="tasks" class="mb-6"><h2>任务清单</h2><ul data-type="taskList">${plan.tasks.map((task, index) => {
          const checked = task.status === 'done' ? 'true' : 'false';
          const checkedAttr = checked === 'true' ? ' checked' : '';
          return `<li data-checked="${checked}" data-goal-task-index="${index}" data-goal-task-id="${escapeHtml(task.id)}"><label><input type="checkbox"${checkedAttr}><span></span></label><div><p>[${escapeHtml(task.priority.toUpperCase())}] ${escapeHtml(task.title)}</p></div></li>`;
        }).join('')}</ul></section>`
      : '';

    const nextActionsHtml = plan.nextActions.length > 0
      ? `<section data-goal-section="next-actions" class="mb-6"><h2>今日下一步</h2><ol>${plan.nextActions.map((action) => `<li><strong>${escapeHtml(action.title)}</strong><br/><span>${escapeHtml(action.reason)}</span></li>`).join('')}</ol></section>`
      : '';

    const risksHtml = plan.risks.length > 0
      ? `<section data-goal-section="risks"><h2>风险与缓解</h2><ul>${plan.risks.map((risk) => `<li><strong>[${escapeHtml(risk.level.toUpperCase())}] ${escapeHtml(risk.title)}</strong>${risk.mitigation ? `<br/><span>缓解：${escapeHtml(risk.mitigation)}</span>` : ''}</li>`).join('')}</ul></section>`
      : '';

    return `<div data-goal-plan="v1" class="goal-plan-block">${summaryHtml}${milestoneHtml}${taskHtml}${nextActionsHtml}${risksHtml}</div><p></p>`;
  };

  const patchGoalPlanIntoContent = (existingHtml: string, plan: GoalPlan): string => {
    const planHtml = renderGoalPlanAsHtml(plan);
    if (!existingHtml.trim()) return planHtml;
    if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
      return `${planHtml}${existingHtml}`;
    }

    const parser = new DOMParser();
    const currentDoc = parser.parseFromString(existingHtml, 'text/html');
    const planDoc = parser.parseFromString(planHtml, 'text/html');
    const incomingContainer = planDoc.body.querySelector(GOAL_PLAN_CONTAINER_SELECTOR);
    if (!incomingContainer) return planHtml;

    const importedContainer = currentDoc.importNode(incomingContainer, true);
    const existingContainer = currentDoc.body.querySelector(GOAL_PLAN_CONTAINER_SELECTOR);

    if (existingContainer) {
      existingContainer.replaceWith(importedContainer);
    } else {
      currentDoc.body.insertBefore(importedContainer, currentDoc.body.firstChild);
      const spacer = currentDoc.createElement('p');
      currentDoc.body.insertBefore(spacer, importedContainer.nextSibling);
    }

    return currentDoc.body.innerHTML;
  };

  const parseGoalTasksFromHtml = (html: string): Array<{ checked: boolean; title: string; priority?: 'p0' | 'p1' | 'p2' }> => {
    if (!html || typeof window === 'undefined' || typeof DOMParser === 'undefined') return [];

    const parser = new DOMParser();
    const parsed = parser.parseFromString(html, 'text/html');
    const scopedTaskList = parsed.body.querySelector(`${GOAL_PLAN_CONTAINER_SELECTOR} ul[data-type="taskList"]`);
    if (scopedTaskList) {
      const scopedItems = Array.from(scopedTaskList.querySelectorAll(':scope > li'));
      return scopedItems
        .map((item) => {
          const checkedAttr = item.getAttribute('data-checked');
          const checked = checkedAttr === 'true';
          const rawText = (item.textContent || '').replace(/\s+/g, ' ').trim();
          if (!rawText) return null;
          const prefixMatch = rawText.match(/^\[(P0|P1|P2)\]\s*/i);
          const priority = prefixMatch ? (prefixMatch[1].toLowerCase() as 'p0' | 'p1' | 'p2') : undefined;
          const title = rawText.replace(/^\[(P0|P1|P2)\]\s*/i, '').trim();
          if (!title) return null;
          return { checked, title, priority };
        })
        .filter(Boolean) as Array<{ checked: boolean; title: string; priority?: 'p0' | 'p1' | 'p2' }>;
    }

    const headings = Array.from(parsed.body.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    const taskHeading = headings.find((node) => (node.textContent || '').trim() === '任务清单');
    if (!taskHeading) return [];

    let cursor: Element | null = taskHeading.nextElementSibling;
    let taskList: Element | null = null;
    while (cursor) {
      if (/^H[1-6]$/.test(cursor.tagName)) break;
      if (cursor.matches('ul[data-type="taskList"]')) {
        taskList = cursor;
        break;
      }
      taskList = cursor.querySelector('ul[data-type="taskList"]');
      if (taskList) break;
      cursor = cursor.nextElementSibling;
    }

    if (!taskList) return [];

    const items = Array.from(taskList.querySelectorAll(':scope > li'));
    return items
      .map((item) => {
        const checkedAttr = item.getAttribute('data-checked');
        const checked = checkedAttr === 'true';
        const rawText = (item.textContent || '').replace(/\s+/g, ' ').trim();
        if (!rawText) return null;
        const prefixMatch = rawText.match(/^\[(P0|P1|P2)\]\s*/i);
        const priority = prefixMatch ? (prefixMatch[1].toLowerCase() as 'p0' | 'p1' | 'p2') : undefined;
        const title = rawText.replace(/^\[(P0|P1|P2)\]\s*/i, '').trim();
        if (!title) return null;
        return { checked, title, priority };
      })
      .filter(Boolean) as Array<{ checked: boolean; title: string; priority?: 'p0' | 'p1' | 'p2' }>;
  };

  const appendGoalExecutionLog = (
    previousLogs: GoalExecutionLog[] | undefined,
    trigger: GoalExecutionLog['trigger'],
    changedSections: string[],
    summary: string
  ): GoalExecutionLog[] => {
    const nextLog: GoalExecutionLog = {
      id: `goal-log-${Date.now()}`,
      at: new Date().toISOString(),
      trigger,
      changedSections,
      summary
    };
    return [...(previousLogs || []).slice(-19), nextLog];
  };

  const runGoalPlanner = async (trigger: GoalExecutionLog['trigger'], options?: { silent?: boolean }) => {
    const goal = goalInput.trim() || doc.goalSource?.goal?.trim() || '';
    if (!goal) {
      if (!options?.silent) {
        setGoalPlanError('请先输入你的目标。');
      }
      return;
    }

    setIsPlanningGoal(true);
    if (!options?.silent) {
      setGoalPlanError(null);
    }

    const constraints = goalConstraintsInput.trim() || doc.goalSource?.constraints || '';
    const deadline = goalDeadlineInput.trim() || doc.goalSource?.deadline || '';

    const systemInstruction = `Today's Date: ${new Date().toLocaleDateString()}\n\nYou are an execution planner for a personal workspace. Return strict JSON only. No markdown. No commentary.\nRequired schema keys: version, summary, milestones, tasks, nextActions, risks.\nConstraints: version must be \"v1\"; tasks 5-20; nextActions <= 3; keep each title concise and actionable.`;

    const plainText = doc.content.replace(/<[^>]*>/g, '').trim();
    const userPrompt = `Create or refresh an execution plan.\nGoal: ${goal}\nConstraints: ${constraints || 'N/A'}\nDeadline: ${deadline || 'N/A'}\nCurrent content context:\n${plainText || '(empty)'}\n\nReturn JSON only with this shape:
{
  "version":"v1",
  "summary":"string",
  "milestones":[{"id":"string","title":"string","due":"optional string","status":"todo|doing|done|blocked"}],
  "tasks":[{"id":"string","title":"string","priority":"p0|p1|p2","milestoneId":"optional string","status":"todo|doing|done|blocked","owner":"optional me"}],
  "nextActions":[{"id":"string","title":"string","reason":"string"}],
  "risks":[{"id":"string","title":"string","level":"low|medium|high","mitigation":"optional string"}]
}`;

    try {
      const responseText = await callApi(systemInstruction, userPrompt);
      const payload = parseAiJsonPayload(responseText || '');
      const normalizedPlan = normalizeGoalPlan(payload);
      if (!normalizedPlan) {
        throw new Error('AI 规划结果无法解析，请重试。');
      }

      setGoalPlanDraft(normalizedPlan);
      lastGoalPlanAtRef.current = Date.now();
      lastGoalPlanPlainTextRef.current = plainText;
      onUpdate(doc.id, {
        goalSource: {
          goal,
          constraints: constraints || undefined,
          deadline: deadline || undefined
        },
        goalPlan: normalizedPlan,
        goalPlanUpdatedAt: new Date().toISOString(),
        aiSummary: normalizedPlan.summary,
        aiActionItems: normalizedPlan.nextActions.map(item => item.title).slice(0, GOAL_PLAN_MAX_NEXT_ACTIONS),
        goalExecutionLog: appendGoalExecutionLog(
          doc.goalExecutionLog,
          trigger,
          ['summary', 'milestones', 'tasks', 'nextActions', 'risks'],
          trigger === 'init'
            ? '初次自动拆解目标计划'
            : trigger === 'auto_replan'
              ? '自动重规划更新了目标计划'
              : '已更新目标执行计划'
        )
      });
    } catch (error: any) {
      if (!options?.silent) {
        setGoalPlanError(error?.message || '目标拆解失败，请稍后重试。');
      }
    } finally {
      setIsPlanningGoal(false);
    }
  };

  const applyGoalPlanToPage = () => {
    const plan = goalPlanDraft || doc.goalPlan;
    if (!plan) {
      setGoalPlanError('当前没有可应用的计划。');
      return;
    }

    const nextContent = patchGoalPlanIntoContent(doc.content, plan);
    onCreateSnapshot();
    onUpdate(doc.id, {
      content: nextContent,
      goalPlan: plan,
      goalPlanUpdatedAt: new Date().toISOString(),
      aiSummary: plan.summary,
      aiActionItems: plan.nextActions.map(item => item.title).slice(0, GOAL_PLAN_MAX_NEXT_ACTIONS),
      goalExecutionLog: appendGoalExecutionLog(
        doc.goalExecutionLog,
        'manual_replan',
        ['content', 'tasks', 'nextActions', 'milestones'],
        '已将目标计划应用到页面'
      )
    });
  };

  useEffect(() => {
    if (!doc.goalPlan || doc.goalPlan.tasks.length === 0) return;
    if (!doc.content.includes('data-type="taskList"')) return;
    if (!doc.content.includes('data-goal-plan="v1"') && !doc.content.includes('任务清单')) return;

    const parsedTasks = parseGoalTasksFromHtml(doc.content);
    if (parsedTasks.length === 0) return;

    const compareLen = Math.min(parsedTasks.length, doc.goalPlan.tasks.length);
    let hasChanged = false;
    const nextTasks = doc.goalPlan.tasks.map((task, index) => {
      if (index >= compareLen) return task;
      const parsed = parsedTasks[index];

      let nextStatus: GoalPlan['tasks'][number]['status'];
      if (parsed.checked) {
        nextStatus = 'done';
      } else if (task.status === 'doing' || task.status === 'blocked') {
        nextStatus = task.status;
      } else {
        nextStatus = 'todo';
      }

      const nextPriority = parsed.priority || task.priority;
      const nextTitle = parsed.title || task.title;

      if (nextStatus !== task.status || nextPriority !== task.priority || nextTitle !== task.title) {
        hasChanged = true;
        return {
          ...task,
          status: nextStatus,
          priority: nextPriority,
          title: nextTitle
        };
      }

      return task;
    });

    if (!hasChanged) return;

    onUpdate(doc.id, {
      goalPlan: {
        ...doc.goalPlan,
        tasks: nextTasks
      },
      goalPlanUpdatedAt: new Date().toISOString(),
      goalExecutionLog: appendGoalExecutionLog(
        doc.goalExecutionLog,
        'manual_replan',
        ['tasks'],
        '已同步页面勾选状态到任务计划'
      )
    });
  }, [doc.content, doc.goalPlan, doc.goalExecutionLog, doc.id]);

  useEffect(() => {
    if (!settings.aiAutomation) return;
    if (!doc.goalPlan) return;
    if (isPlanningGoal || isProcessing) return;

    if (goalAutoReplanTimeoutRef.current) {
      clearTimeout(goalAutoReplanTimeoutRef.current);
      goalAutoReplanTimeoutRef.current = null;
    }

    goalAutoReplanTimeoutRef.current = setTimeout(() => {
      const now = Date.now();
      if (now - lastGoalPlanAtRef.current < GOAL_AUTO_REPLAN_INTERVAL_MS) return;

      const currentPlainText = doc.content.replace(/<[^>]*>/g, '').trim();
      const diffMagnitude = estimateTextDiffMagnitude(lastGoalPlanPlainTextRef.current, currentPlainText);
      if (diffMagnitude < GOAL_AUTO_REPLAN_MIN_DIFF) return;

      runGoalPlanner('auto_replan', { silent: true });
    }, GOAL_AUTO_REPLAN_IDLE_MS);

    return () => {
      if (goalAutoReplanTimeoutRef.current) {
        clearTimeout(goalAutoReplanTimeoutRef.current);
        goalAutoReplanTimeoutRef.current = null;
      }
    };
  }, [doc.content, doc.id, doc.goalPlan, isPlanningGoal, isProcessing, settings.aiAutomation]);

  const runAutoInsights = async (force: boolean = false) => {
    if (isAutoAnalyzing || isProcessing || isGettingCompletion) return;

    const plainText = doc.content.replace(/<[^>]*>/g, '').trim();
    if (plainText.length < AUTO_INSIGHT_MIN_CONTENT_LENGTH) return;

    const signature = `${doc.id}:${plainText.length}:${plainText.slice(0, 100)}:${plainText.slice(-120)}`;
    if (!force && signature === lastInsightSignatureRef.current) return;

    setIsAutoAnalyzing(true);
    setAutoInsightError(null);

    try {
      const systemInstruction = `Today's Date: ${new Date().toLocaleDateString()}\n\nYou are an automation assistant for a personal writing workspace. Extract concise structured insights from the document. Return strict JSON only with keys: summary (string), tags (string array), actions (string array). Keep summary under 120 Chinese characters. Keep tags to 3-8 items. Keep actions to 3-8 concrete tasks.`;
      const userPrompt = `Analyze this document and generate automation insights:\n\n${plainText}`;
      const response = await callApi(systemInstruction, userPrompt);
      const payload = parseAiJsonPayload(response || '');
      if (!payload) {
        throw new Error('AI 返回结果无法解析为结构化数据');
      }

      const summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';
      const tags = Array.isArray(payload.tags)
        ? payload.tags.map((tag: any) => String(tag).trim()).filter(Boolean).slice(0, 8)
        : [];
      const actions = Array.isArray(payload.actions)
        ? payload.actions.map((item: any) => String(item).trim()).filter(Boolean).slice(0, 8)
        : [];

      onUpdate(doc.id, {
        aiSummary: summary,
        aiTags: tags,
        aiActionItems: actions,
        autoInsightsUpdatedAt: new Date().toISOString(),
      });
      lastInsightSignatureRef.current = signature;
    } catch (error: any) {
      setAutoInsightError(error?.message || '自动洞察失败');
    } finally {
      setIsAutoAnalyzing(false);
    }
  };

  useEffect(() => {
    if (!settings.aiAutomation) return;

    const plainText = doc.content.replace(/<[^>]*>/g, '').trim();
    if (plainText.length < AUTO_INSIGHT_MIN_CONTENT_LENGTH) return;

    if (autoInsightTimeoutRef.current) {
      clearTimeout(autoInsightTimeoutRef.current);
    }

    autoInsightTimeoutRef.current = setTimeout(() => {
      runAutoInsights(false);
    }, AUTO_INSIGHT_IDLE_MS);

    return () => {
      if (autoInsightTimeoutRef.current) {
        clearTimeout(autoInsightTimeoutRef.current);
        autoInsightTimeoutRef.current = null;
      }
    };
  }, [doc.content, doc.id, settings.aiAutomation]);

  const [isTranslationTask, setIsTranslationTask] = useState(false);
  const [translationStreamHtml, setTranslationStreamHtml] = useState('');
  const translationStreamBufferRef = useRef('');
  const translationStreamContainerRef = useRef<HTMLDivElement>(null);
  const sanitizedTranslationStreamingHtml = useMemo(
    () => sanitizeHtml(`${translationStreamHtml}<span class="inline-block w-1.5 h-4 bg-purple-500 animate-pulse ml-1 align-middle"></span>`),
    [translationStreamHtml]
  );

  useEffect(() => {
    if (!isProcessing || !isTranslationTask) return;
    if (!translationStreamContainerRef.current) return;
    translationStreamContainerRef.current.scrollTop = translationStreamContainerRef.current.scrollHeight;
  }, [translationStreamHtml, isProcessing, isTranslationTask]);

  const handleAiAction = async (
    actions: string[],
    prompt?: string,
    options?: {
      autoApply?: boolean;
      forceAppend?: boolean;
      executionTrigger?: GoalExecutionLog['trigger'];
      targetOverride?: 'original' | 'translated';
    }
  ) => {
    const autoApply = options?.autoApply ?? false;
    const executionTrigger = options?.executionTrigger || 'manual_execute';
    const effectiveAiMode: AiEditMode = options?.forceAppend ? 'append' : aiMode;
    const isTranslation = actions.includes('translate');
    const hasDualColumns = doc.translatedContent !== undefined;
    const targetSelection = hasDualColumns
      ? (options?.targetOverride || aiTarget)
      : 'original';
    const effectiveTarget: 'original' | 'translated' = !isTranslation && hasDualColumns && targetSelection === 'translated'
      ? 'translated'
      : 'original';
    const sourceContent = effectiveTarget === 'translated' ? (doc.translatedContent || '') : doc.content;
    const sourceLabel = effectiveTarget === 'translated' ? 'translated column' : 'original column';

    // 只有当既没有可处理正文，又没有自定义 Prompt，且没有外部链接时才阻止。
    if ((!sourceContent.trim() && !prompt?.trim() && attachedLinks.length === 0) || (actions.length === 0 && !prompt?.trim() && attachedLinks.length === 0)) return;

    setLastAiTarget(isTranslation ? 'translated' : effectiveTarget);
    setIsTranslationTask(isTranslation);
    setTranslationStreamHtml('');
    translationStreamBufferRef.current = '';
    
    if (isTranslation) {
      onUpdate(doc.id, { translatedContent: '' }); // 清空旧翻译，触发双栏
    }

    setIsProcessing(true);
    setAiResult('');
    
    const linksToInclude = [...attachedLinks.filter(l => l.status === 'done')];
    setAttachedLinks([]);

    // 自动滚动到生成区域开始位置
    setTimeout(() => {
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTo({
          top: 0, // 对于新生成，滚动到顶部（标题下方）
          behavior: 'smooth'
        });
      }
    }, 100);

    try {
      const hasOptimization = actions.some(a => ['organize', 'format', 'paragraphs', 'write', 'polish', 'template', 'summarize', 'action_items', 'grammar', 'tone_pro', 'tone_casual', 'explain', 'generate_table', 'generate_schedule'].includes(a)) || prompt;

      // 针对“追加内容”模式优化提示词
      const outputInstruction = effectiveAiMode === 'append'
        ? "APPEND MODE: The user wants to ADD new content to the end of the current document. ONLY generate the NEW content. DO NOT repeat the original content."
        : effectiveAiMode === 'prepend'
          ? "PREPEND MODE: The user wants to ADD new content to the beginning of the current document. ONLY generate the NEW content. DO NOT repeat the original content."
          : effectiveAiMode === 'update_block'
            ? "UPDATE BLOCK MODE: The user wants focused updates. Return only the updated section(s) as standalone content blocks. Do not rewrite the whole document."
            : "REPLACE MODE: The user wants to REVISE or REORGANIZE the entire content. Process and return the ENTIRE text with your improvements. Ensure no parts of the original text are left out unless explicitly asked.";

      // 2. 获取引用的页面内容作为额外上下文
      const referencedPages = documents.filter(d => referencedPageIds.includes(d.id));
      const refContext = referencedPages.length > 0
        ? `\n\nREFERENCED DOCUMENTS (EXTRA CONTEXT):\nThe user has specifically referenced these documents for this task. Use their content to inform your edits or generation:\n${referencedPages.map(d => `--- REFERENCE: ${d.title} ---\n${d.content.replace(/<[^>]*>/g, '')}`).join('\n\n')}`
        : '';

      const webContext = linksToInclude.length > 0
        ? `\n\nWEB CONTENT CONTEXT:\nThe user has provided content from external web pages. Use this information as a primary source for your task:\n${linksToInclude.map(l => `--- WEB PAGE: ${l.title} (${l.url}) ---\n${l.content}`).join('\n\n')}`
        : '';

      const pageCreationInstruction = "\n\nPAGE CREATION CAPABILITY: You can create new pages for the user. If the user explicitly asks to create a NEW page, document, or article (e.g., 'put this in a new page'), you MUST include a special command at the END of your response in this exact format: [CREATE_PAGE|Title|Content]. The Title should be short and the Content should be formatted in HTML (without markdown code blocks). For example: [CREATE_PAGE|My New Article|<h1>My New Article</h1><p>Content goes here...</p>]. Ensure Title and Content do not contain the '|' or ']' characters directly. Do not mention this command in your natural language response to the user, just add it at the very end. Do not repeat the original document content in your natural language response if you are creating a new page.";

      const formattingInstruction = actions.includes('format') || actions.includes('organize') || actions.includes('template') || actions.includes('generate_table') || actions.includes('generate_schedule')
        ? `\n\nFORMATTING: Always return the result in HTML format, using appropriate tags (<h1>, <p>, <strong>, <em>, etc.) so it can be rendered directly in a rich text editor. For tables, use standard <table>, <tr>, <th>, and <td> tags. For task lists (checklists), use <ul data-type="taskList"><li data-checked="false"><label><input type="checkbox"><span></span></label><div><p>Task text</p></div></li></ul> format. Do not wrap the response in markdown code blocks like \`\`\`html. Use various emojis and icons as bullet points, list items, or subtitle sequences to make the content more engaging and visually structured. INTELLIGENT HIGHLIGHTING: Intelligently use different background colors and text colors to make the content visually rich and highlight key information. Use <mark data-color="..."> for background highlights and <span style="color: ..."> for text colors. Available background colors: #fef08a (yellow), #bfdbfe (blue), #bbf7d0 (green), #fecaca (red), #e9d5ff (purple), #fed7aa (orange), #f1f5f9 (gray). Use these colors appropriately based on the importance or type of content.`
        : `\n\nFORMATTING: Return the result in clean HTML format. Use standard tags like <p>, <strong>, <em>, and <br/>. Keep the structure simple and focus only on the text content. Do not add complex headings, tables, or highlights unless specifically requested. Do not wrap the response in markdown code blocks.`;
      const notionDerivedGuardrails =
        "\n\nNOTION-STYLE GUARDRAILS: Keep scope tight and avoid over-performing. If context is insufficient, ask one focused follow-up question. Never fabricate facts, links, or source references. If uncertainty exists, state it clearly and provide a verification path.";

      let baseSystemInstruction = `Today's Date: ${new Date().toLocaleDateString()}\n\nYou are a helpful AI assistant. You can help users with writing, analysis, or general questions. Always be concise and friendly.` + 
        pageCreationInstruction +
        notionDerivedGuardrails +
        formattingInstruction + refContext + webContext;

      if (!isTranslation && hasDualColumns) {
        baseSystemInstruction += effectiveTarget === 'translated'
          ? "\n\nTARGET COLUMN: The user selected the translated column. Apply all edits ONLY to translated text and keep language consistency."
          : "\n\nTARGET COLUMN: The user selected the original column. Apply all edits ONLY to original text and keep language consistency.";
      }

      if (webContext) {
        baseSystemInstruction += "\n\nCRITICAL: You MUST prioritize the information in 'WEB CONTENT CONTEXT' for this task, as it represents the most current and relevant data provided by the user.";
      }
      
      // Add specific instructions for new actions
      if (actions.includes('write')) {
        baseSystemInstruction += " HELP WRITING: Based on the provided context or instructions, expand the content, add relevant details, and continue the narrative or argument in a natural and engaging way.";
      }
      if (actions.includes('polish')) {
        baseSystemInstruction += " POLISHING: Refine the language, improve vocabulary, fix grammar, and enhance the overall flow and professional tone of the text while preserving the original meaning.";
      }
      if (actions.includes('template')) {
        baseSystemInstruction += " TEMPLATE GENERATION: Create a well-structured document template or outline based on the user's topic. Use appropriate headings and placeholders.";
      }
      if (actions.includes('summarize')) {
        baseSystemInstruction += " SUMMARIZE: Provide a concise summary of the key points in the text. Use a bulleted list for clarity.";
      }
      if (actions.includes('action_items')) {
        baseSystemInstruction += " ACTION ITEMS: Identify and list all tasks, deadlines, and responsibilities mentioned in the text.";
      }
      if (actions.includes('grammar')) {
        baseSystemInstruction += " GRAMMAR & SPELLING: Fix all grammatical, spelling, and punctuation errors in the text.";
      }
      if (actions.includes('tone_pro')) {
        baseSystemInstruction += " PROFESSIONAL TONE: Rewrite the text to sound more professional, formal, and authoritative.";
      }
      if (actions.includes('tone_casual')) {
        baseSystemInstruction += " CASUAL TONE: Rewrite the text to sound more friendly, approachable, and conversational.";
      }
      if (actions.includes('explain')) {
        baseSystemInstruction += " EXPLAIN: Explain complex concepts or code snippets in the text in simple, easy-to-understand terms.";
      }
      if (actions.includes('generate_table')) {
        baseSystemInstruction += " TABLE GENERATION: Based on the content or user instructions, create a clear and organized data table using HTML <table> tags. Ensure headers are descriptive.";
      }
      if (actions.includes('generate_schedule')) {
        baseSystemInstruction += " SCHEDULE GENERATION: Create a detailed schedule or timeline (e.g., for a project or meeting) in a table or list format with times and responsibilities.";
      }

      // 如果文档内容不为空，将其作为上下文
      if (sourceContent.trim()) {
         baseSystemInstruction += `\n\nCurrent ${sourceLabel} Content:\n"""\n${sourceContent}\n"""\n`;
      } else {
         baseSystemInstruction += `\n\n(No existing content provided. Generate content based on user instructions.)\n`;
      }

      if (isTranslation && hasOptimization) {
        let systemInstruction = baseSystemInstruction + " Return the result as a JSON object with two fields: 'optimizedContent' (the improved original text in its original language) and 'translatedContent' (the translated text). CRITICAL: The 'translatedContent' MUST have the EXACT SAME HTML structure (tags, classes, hierarchy) as 'optimizedContent', only the text nodes should be translated. Use HTML tags for formatting in both fields.";
        
        let userPrompt = "Please apply the following improvements to the ENTIRE text below and then translate it:\n";
        if (actions.includes('organize')) userPrompt += "- Reorganize the logic and structure.\n";
        if (actions.includes('format')) userPrompt += "- Beautify the format and typography.\n";
        if (actions.includes('paragraphs')) userPrompt += "- Divide into readable paragraphs.\n";
        if (actions.includes('write')) userPrompt += "- Help expand and write more content.\n";
        if (actions.includes('polish')) userPrompt += "- Polish and refine the language.\n";
        if (actions.includes('template')) userPrompt += "- Generate a structured template.\n";
        if (actions.includes('summarize')) userPrompt += "- Summarize the key points.\n";
        if (actions.includes('action_items')) userPrompt += "- Extract action items.\n";
        if (actions.includes('generate_table')) userPrompt += "- Generate a data table.\n";
        if (actions.includes('generate_schedule')) userPrompt += "- Generate a detailed schedule.\n";
        if (actions.includes('grammar')) userPrompt += "- Fix grammar and spelling.\n";
        if (actions.includes('tone_pro')) userPrompt += "- Make it professional.\n";
        if (actions.includes('tone_casual')) userPrompt += "- Make it casual.\n";
        if (actions.includes('explain')) userPrompt += "- Explain concepts/code.\n";
        userPrompt += "- Finally, translate the result into fluent, natural-sounding Chinese (or English if the original is Chinese), PRESERVING ALL HTML TAGS EXACTLY.\n";
        if (prompt) userPrompt += `- Additional instructions: ${prompt}\n`;
        userPrompt += `\nHere is the complete text to process:\n\n${sourceContent}`;

        const responseText = await callApi(systemInstruction, userPrompt, true);

        let result = { optimizedContent: '', translatedContent: '' };
        try {
          // Remove potential markdown code blocks
          const cleanJson = responseText.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
          result = JSON.parse(cleanJson);
        } catch (e) {
          console.error("Failed to parse JSON response", responseText);
        }
        
        if (result.optimizedContent) {
          onUpdate(doc.id, { content: result.optimizedContent });
        }
        if (result.translatedContent) {
          onUpdate(doc.id, { translatedContent: result.translatedContent });
          setTranslationStreamHtml(result.translatedContent);
        }
        setIsAiMenuOpen(false); // Close menu after translation
      } else {
        let systemInstruction = baseSystemInstruction;
        let userPrompt = effectiveAiMode === 'replace'
          ? "Please apply the following improvements to the ENTIRE text below. Make sure no parts of the original text are left out or ignored:\n"
          : effectiveAiMode === 'append'
            ? "Generate ONLY new content to append at the end. Do not repeat existing paragraphs:\n"
            : effectiveAiMode === 'prepend'
              ? "Generate ONLY new content to insert at the beginning. Do not repeat existing paragraphs:\n"
              : "Generate focused update blocks only for the requested changes. Keep unchanged content out of the output:\n";

        if (actions.includes('organize')) {
          systemInstruction += " Reorganize the provided text to have a clear, logical flow. Ensure there is a coherent introduction, body, and conclusion. Do not add new information, just restructure the existing content completely.";
          userPrompt += "- Reorganize the logic and structure of the entire text.\n";
        }
        if (actions.includes('format')) {
          systemInstruction += " Beautify the formatting of the provided text. Add appropriate headings, bold text for emphasis, bullet points or numbered lists where applicable, and blockquotes if suitable. Make it visually appealing and easy to read throughout the whole document.";
          userPrompt += "- Beautify the format and typography of the entire text.\n";
        }
        if (actions.includes('paragraphs')) {
          systemInstruction += " Divide the provided text into readable paragraphs. Break up large walls of text into smaller, digestible chunks. Ensure each paragraph focuses on a single main idea. Process the whole text.";
          userPrompt += "- Divide the entire text into readable paragraphs.\n";
        }
        if (actions.includes('write')) {
          userPrompt += "- Help expand and write more content based on the context.\n";
        }
        if (actions.includes('polish')) {
          userPrompt += "- Polish and refine the language to make it more professional.\n";
        }
        if (actions.includes('template')) {
          userPrompt += "- Generate a structured template or outline for this topic.\n";
        }
        if (actions.includes('generate_table')) {
          userPrompt += "- Generate a data table based on the content or topic.\n";
        }
        if (actions.includes('generate_schedule')) {
          userPrompt += "- Generate a detailed schedule or timeline.\n";
        }
        if (actions.includes('summarize')) {
          userPrompt += "- Summarize the key points.\n";
        }
        if (actions.includes('action_items')) {
          userPrompt += "- Identify and list all tasks.\n";
        }
        if (actions.includes('grammar')) {
          userPrompt += "- Fix grammar and spelling errors.\n";
        }
        if (actions.includes('tone_pro')) {
          userPrompt += "- Make the tone more professional.\n";
        }
        if (actions.includes('tone_casual')) {
          userPrompt += "- Make the tone more casual.\n";
        }
        if (actions.includes('explain')) {
          userPrompt += "- Explain complex parts of the text.\n";
        }
        if (actions.includes('translate')) {
          systemInstruction += " Translate the entire provided text into fluent, natural-sounding Chinese (or English if the original is Chinese). Maintain the original formatting, structure, and length.";
          userPrompt += "- Translate the entire text.\n";
        }
        
        if (prompt) {
          userPrompt += `- Additional instructions: ${prompt}\n`;
        }

        userPrompt += `\nHere is the complete text to process:\n\n${sourceContent}`;

        let generatedPatches: ParagraphPatch[] = [];
        let resultText = '';
        if (effectiveAiMode === 'update_block') {
          systemInstruction += "\n\nPARAGRAPH PATCH MODE: Return STRICT JSON only with shape {\"patches\":[{\"action\":\"replace|insert_before|insert_after|delete\",\"find\":\"exact snippet from current text\",\"content\":\"html for new paragraph (omit only for delete)\",\"reason\":\"optional\"}]}. Keep patches focused on paragraph-level changes. Do not rewrite full document.";
          userPrompt += "\n- Return paragraph-level patches only, not full rewritten article.\n";
          const patchResponse = await callApi(systemInstruction, userPrompt, false);
          const patchPayload = parseAiJsonPayload(patchResponse || '');
          const normalizedPatches = normalizeParagraphPatches(patchPayload);
          if (normalizedPatches.length > 0) {
            generatedPatches = normalizedPatches;
            const patchPreview = applyParagraphPatchesToHtml(sourceContent, generatedPatches);
            if (patchPreview.appliedPatchIds.length > 0) {
              resultText = patchPreview.html;
            } else {
              resultText = patchResponse;
            }
          } else {
            resultText = patchResponse;
          }
        } else {
          resultText = await callApi(systemInstruction, userPrompt, false, (chunk) => {
            if (isTranslation) {
              translationStreamBufferRef.current += chunk;
              const nextStreamingContent = translationStreamBufferRef.current;
              setTranslationStreamHtml(nextStreamingContent);
              onUpdate(doc.id, {
                translatedContent: nextStreamingContent
              });
            } else if (!autoApply) {
              setAiResult(prev => {
                const newContent = (prev || '') + chunk;
                // 在流式输出中实时过滤指令
                return newContent.replace(/\[CREATE_PAGE\|.*?\|.*?\]/g, '');
              });
            }
          });
        }

        // 4. 处理指令 (针对页面模式下的新建页面)
        const pageMatch = resultText.match(/\[CREATE_PAGE\|(.*?)\|(.*?)\]/);
        if (pageMatch) {
          const title = pageMatch[1].trim();
          const content = pageMatch[2].trim();
          
          setAiResult(prev => (prev || '') + `\n\n<div class="mt-4 p-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-xl text-purple-700 dark:text-purple-300 font-bold text-center animate-pulse">✨ 正在为你创建新页面：${title}...</div>`);

          setTimeout(() => {
            onCreateDoc(null, { title, content });
            setIsAiMenuOpen(false);
            setAiResult(null); // 跳转后清除预览
          }, 1500);
          return; // 既然是新建页面，就不继续执行下面的替换/追加逻辑了
        }

        // Clean up potential markdown code block wrapping
        if (resultText.startsWith('```html')) {
          resultText = resultText.replace(/^```html\n?/, '').replace(/\n?```$/, '');
        } else if (resultText.startsWith('```json')) {
          resultText = resultText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
        } else if (resultText.startsWith('```')) {
          resultText = resultText.replace(/^```\n?/, '').replace(/\n?```$/, '');
        }

        if (isTranslation) {
          onUpdate(doc.id, { translatedContent: resultText });
          setTranslationStreamHtml(resultText);
          setIsAiMenuOpen(false); // 翻译完成关闭菜单
        } else if (autoApply) {
          const applyToTranslated = safeLastTarget === 'translated' && doc.translatedContent !== undefined;
          if (applyToTranslated) {
            const currentTranslated = (doc.translatedContent || '').trim();
            const patchAppliedForTranslated = effectiveAiMode === 'update_block' && generatedPatches.length > 0
              ? applyParagraphPatchesToHtml(doc.translatedContent || '', generatedPatches)
              : null;
            const hasAppliedTranslatedPatches = !!patchAppliedForTranslated && patchAppliedForTranslated.appliedPatchIds.length > 0;
            const mergedTranslated = hasAppliedTranslatedPatches
              ? patchAppliedForTranslated.html
              : effectiveAiMode === 'append'
                ? (currentTranslated ? `${doc.translatedContent}<br/>${resultText}` : resultText)
                : effectiveAiMode === 'prepend'
                  ? (currentTranslated ? `${resultText}<br/>${doc.translatedContent}` : resultText)
                  : effectiveAiMode === 'update_block'
                    ? (currentTranslated
                        ? `${doc.translatedContent}${renderAiUpdateBlock(resultText, 'translated')}`
                        : renderAiUpdateBlock(resultText, 'translated'))
                    : resultText;

            onUpdate(doc.id, {
              translatedContent: mergedTranslated,
              goalExecutionLog: appendGoalExecutionLog(
                doc.goalExecutionLog,
                executionTrigger,
                ['translatedContent'],
                effectiveAiMode === 'append'
                  ? '自动执行洞察并追加到译文栏'
                  : effectiveAiMode === 'prepend'
                  ? '自动执行洞察并插入到译文栏开头'
                    : effectiveAiMode === 'update_block'
                      ? (hasAppliedTranslatedPatches
                          ? `自动执行译文段落 patch (${patchAppliedForTranslated.appliedPatchIds.length} 条)`
                          : '自动执行洞察并生成译文更新块')
                      : '自动执行洞察并更新译文栏'
              )
            });
            setAiResult(null);
            return;
          }

          let finalContent = resultText;
          let finalTitle = doc.title;
          let baseContent = doc.content;

          if (doc.translatedContent) {
            baseContent = `<div class="bilingual-entry mb-8">
          <div class="original-section pb-4 border-b border-zinc-100 dark:border-zinc-800">
            <div class="text-[10px] font-bold text-zinc-400 uppercase mb-2">原文</div>
            ${doc.content}
          </div>
          <div class="translation-section pt-4">
            <div class="text-[10px] font-bold text-purple-400 uppercase mb-2">译文</div>
            ${doc.translatedContent}
          </div>
        </div>`;
          }

          const patchAppliedForContent = effectiveAiMode === 'update_block' && generatedPatches.length > 0
            ? applyParagraphPatchesToHtml(doc.content, generatedPatches)
            : null;
          const hasAppliedContentPatches = !!patchAppliedForContent && patchAppliedForContent.appliedPatchIds.length > 0;

          if (hasAppliedContentPatches) {
            finalContent = patchAppliedForContent.html;
          } else if (effectiveAiMode === 'append') {
            finalContent = baseContent + '<br/>' + resultText;
          } else if (effectiveAiMode === 'prepend') {
            finalContent = resultText + '<br/>' + baseContent;
          } else if (effectiveAiMode === 'update_block') {
            finalContent = baseContent + renderAiUpdateBlock(resultText, 'original');
          } else {
            const titleMatch = resultText.match(/<(h1|h2)[^>]*>(.*?)<\/\1>/i);
            if (titleMatch && titleMatch[2]) {
              finalTitle = titleMatch[2].replace(/<[^>]*>/g, '').trim();
              finalContent = resultText.replace(titleMatch[0], '').trim();
            }
          }

          onUpdate(doc.id, {
            content: finalContent,
            title: finalTitle || '无标题',
            translatedContent: doc.translatedContent,
            goalExecutionLog: appendGoalExecutionLog(
              doc.goalExecutionLog,
              executionTrigger,
              ['content'],
              effectiveAiMode === 'append'
                ? '自动执行洞察并追加结果'
                : effectiveAiMode === 'prepend'
                  ? '自动执行洞察并插入到正文开头'
                  : effectiveAiMode === 'update_block'
                    ? (hasAppliedContentPatches
                        ? `自动执行正文段落 patch (${patchAppliedForContent.appliedPatchIds.length} 条)`
                        : '自动执行洞察并生成更新块')
                    : '自动执行洞察并更新正文'
            )
          });
          setAiResult(null);
        } else {
          const previewId = crypto.randomUUID();
          const previewTitleBase = getPreviewTitle(actions, prompt, executionTrigger);
          const nextPreview: PreviewQueueItem = {
            id: previewId,
            title: effectiveAiMode === 'update_block' && generatedPatches.length > 0
              ? `${previewTitleBase} (${generatedPatches.length} patches)`
              : previewTitleBase,
            content: resultText,
            mode: effectiveAiMode,
            target: effectiveTarget,
            createdAt: new Date().toISOString(),
            trigger: executionTrigger,
            patches: generatedPatches.length > 0 ? generatedPatches : undefined
          };
          setPreviewQueue(prev => [nextPreview, ...prev].slice(0, AUTO_PREVIEW_QUEUE_LIMIT));
          setActivePreviewId(previewId);
          setAiResult(resultText);
        }
      }
    } catch (error) {
      console.error("AI Error:", error);
      if (autoApply) {
        setAutoExecutionStatus({
          level: 'warning',
          message: '自动执行失败，已保留快照可回退。请手动重试。'
        });
      } else {
        setAiResult("An error occurred while processing your request.");
      }
    } finally {
      if (isTranslation) {
        translationStreamBufferRef.current = '';
      }
      setIsProcessing(false);
    }
  };

  const mapInsightItemToActions = (text: string): string[] => {
    const raw = (text || '').toLowerCase();
    if (!raw) return [];

    const mapped = new Set<string>();
    if (/(写作|续写|扩写|draft|write)/.test(raw)) mapped.add('write');
    if (/(润色|优化表达|polish|refine)/.test(raw)) mapped.add('polish');
    if (/(模板|template)/.test(raw)) mapped.add('template');
    if (/(总结|摘要|summary|summarize)/.test(raw)) mapped.add('summarize');
    if (/(格式|排版|format)/.test(raw)) mapped.add('format');
    if (/(段落|paragraph)/.test(raw)) mapped.add('paragraphs');
    if (/(逻辑|结构|organize|restructure)/.test(raw)) mapped.add('organize');
    if (/(语法|错别字|grammar|spelling)/.test(raw)) mapped.add('grammar');
    if (/(翻译|translate)/.test(raw)) mapped.add('translate');
    if (/(表格|table)/.test(raw)) mapped.add('generate_table');
    if (/(日程|时间线|计划表|schedule|timeline)/.test(raw)) mapped.add('generate_schedule');
    if (/(专业|正式|professional)/.test(raw)) mapped.add('tone_pro');
    if (/(友好|口语|casual|friendly)/.test(raw)) mapped.add('tone_casual');
    if (/(解释|说明|explain|code)/.test(raw)) mapped.add('explain');
    if (/(待办|任务|action item|todo)/.test(raw)) mapped.add('action_items');

    return Array.from(mapped);
  };

  const applyInsightItemToPanel = (item: string) => {
    const mapped = mapInsightItemToActions(item);
    if (mapped.length > 0) {
      setSelectedActions(prev => Array.from(new Set([...prev, ...mapped])));
      return;
    }
    setCustomPrompt(prev => (prev ? `${prev}\n${item}` : item));
  };

  const runInsightItemDirectly = async (item: string) => {
    if (isProcessing || isReadOnly) return;
    const mapped = mapInsightItemToActions(item);
    if (mapped.length > 0) {
      setSelectedActions(prev => Array.from(new Set([...prev, ...mapped])));
    }
    const executionTarget: 'original' | 'translated' = isDualColumn && aiTarget === 'translated' ? 'translated' : 'original';
    const prompt = mapped.length > 0
      ? `请优先执行以下自动洞察动作，先给出可预览结果：${item}`
      : item;
    await handleAiAction(mapped, prompt, {
      targetOverride: executionTarget,
      executionTrigger: 'manual_execute'
    });
  };

  const runTopInsightAutomation = async () => {
    if (isProcessing || isReadOnly || !doc.aiActionItems || doc.aiActionItems.length === 0) return;
    const topItems = doc.aiActionItems.slice(0, 3);
    const mapped = Array.from(new Set(topItems.flatMap(item => mapInsightItemToActions(item))));
    if (mapped.length > 0) {
      setSelectedActions(prev => Array.from(new Set([...prev, ...mapped])));
    }
    const executionTarget: 'original' | 'translated' = isDualColumn && aiTarget === 'translated' ? 'translated' : 'original';
    const prompt = `请按优先级处理以下自动洞察任务，先输出可预览的结果：\n${topItems.map((item, idx) => `${idx + 1}. ${item}`).join('\n')}`;
    await handleAiAction(mapped, prompt, {
      targetOverride: executionTarget,
      executionTrigger: 'manual_execute'
    });
  };

  const assessAutoExecutionBatch = (items: string[]) => {
    const mappedActions = new Set<string>();
    const reasons = new Set<string>();
    let riskScore = 0;

    for (const item of items) {
      const mapped = mapInsightItemToActions(item);
      mapped.forEach(action => mappedActions.add(action));

      if (AUTO_EXECUTION_RISKY_TEXT_PATTERN.test(item)) {
        riskScore += 3;
        reasons.add('文本包含高风险词');
      }
      if (mapped.length === 0) {
        riskScore += 2;
        reasons.add('存在无法识别的洞察动作');
      }
      if (mapped.includes('translate')) {
        riskScore += 3;
        reasons.add('包含翻译动作');
      }
      if (mapped.some(action => ['write', 'template', 'organize', 'format'].includes(action))) {
        riskScore += 2;
        reasons.add('包含高改写动作');
      }
    }

    const level: 'low' | 'medium' | 'high' = riskScore >= 4 ? 'high' : riskScore >= 2 ? 'medium' : 'low';
    return {
      level,
      mappedActions: Array.from(mappedActions),
      reasons: Array.from(reasons)
    };
  };

  useEffect(() => {
    if (!settings.aiAutomation || mode !== 'edit' || isReadOnly) return;
    if (isAutoAnalyzing || isProcessing || isPlanningGoal) return;
    if (selectedActions.length > 0 || customPrompt.trim()) return;
    if (previewQueue.length > 0 || aiResult) return;

    const topItems = (doc.aiActionItems || []).slice(0, automationStrategy.maxItems).filter(Boolean);
    if (topItems.length === 0) return;

    const signature = [
      doc.id,
      doc.autoInsightsUpdatedAt || '',
      automationStrategy.executionMode,
      automationStrategy.targetPreference,
      automationStrategy.riskTolerance,
      automationStrategy.maxItems,
      topItems.join('|')
    ].join(':');
    if (signature === lastAutoExecutionSignatureRef.current) return;
    if (Date.now() - lastAutoExecutionAtRef.current < AUTO_EXECUTION_COOLDOWN_MS) return;

    if (autoExecutionTimeoutRef.current) {
      clearTimeout(autoExecutionTimeoutRef.current);
      autoExecutionTimeoutRef.current = null;
    }

    autoExecutionTimeoutRef.current = setTimeout(async () => {
      const risk = assessAutoExecutionBatch(topItems);
      const executionTarget: 'original' | 'translated' = !isDualColumn
        ? 'original'
        : automationStrategy.targetPreference === 'translated'
          ? 'translated'
          : automationStrategy.targetPreference === 'original'
            ? 'original'
            : aiTarget === 'translated'
              ? 'translated'
              : 'original';
      const exceedsRiskTolerance = AUTO_EXECUTION_RISK_LEVEL_SCORE[risk.level] > AUTO_EXECUTION_RISK_LEVEL_SCORE[automationStrategy.riskTolerance];
      if (exceedsRiskTolerance || risk.mappedActions.length === 0) {
        lastAutoExecutionSignatureRef.current = signature;
        setAutoExecutionStatus({
          level: 'warning',
          message: `已拦截自动流程（风险超限）：${risk.reasons.join('、') || '请手动确认'}。`
        });
        return;
      }

      const shouldAutoApply = automationStrategy.executionMode === 'auto_apply';
      setAutoExecutionStatus({
        level: 'running',
        message: shouldAutoApply ? 'AI 自动执行中...' : 'AI 自动生成预览中...'
      });

      const prompt = shouldAutoApply
        ? `请按优先级执行以下自动洞察任务，直接输出可应用到文档的最终结果：\n${topItems.map((item, idx) => `${idx + 1}. ${item}`).join('\n')}`
        : `请按优先级处理以下自动洞察任务，先输出可预览的建议结果，不要直接修改文档正文：\n${topItems.map((item, idx) => `${idx + 1}. ${item}`).join('\n')}`;
      await handleAiAction(risk.mappedActions, prompt, {
        autoApply: shouldAutoApply,
        targetOverride: executionTarget,
        executionTrigger: 'auto_execute'
      });

      lastAutoExecutionAtRef.current = Date.now();
      lastAutoExecutionSignatureRef.current = signature;
      setAutoExecutionStatus({
        level: 'success',
        message: shouldAutoApply
          ? '自动执行已完成，内容已更新。'
          : '已生成自动预览，等待你确认替换或追加。'
      });

      setTimeout(() => {
        setAutoExecutionStatus(prev => (prev?.level === 'success' ? null : prev));
      }, 6000);
    }, automationStrategy.idleMs);

    return () => {
      if (autoExecutionTimeoutRef.current) {
        clearTimeout(autoExecutionTimeoutRef.current);
        autoExecutionTimeoutRef.current = null;
      }
    };
  }, [
    doc.id,
    doc.aiActionItems,
    doc.autoInsightsUpdatedAt,
    aiTarget,
    isDualColumn,
    settings.aiAutomation,
    mode,
    isReadOnly,
    isAutoAnalyzing,
    isProcessing,
    isPlanningGoal,
    selectedActions.length,
    customPrompt,
    aiResult,
    previewQueue.length,
    automationStrategy.executionMode,
    automationStrategy.targetPreference,
    automationStrategy.riskTolerance,
    automationStrategy.idleMs,
    automationStrategy.maxItems
  ]);

  const applyPreviewContent = (
    previewContent: string,
    applyMode: AiEditMode,
    applyTarget: 'original' | 'translated',
    patches?: ParagraphPatch[]
  ) => {
    const applyToTranslated = applyTarget === 'translated' && doc.translatedContent !== undefined;
    if (applyMode === 'update_block' && patches && patches.length > 0) {
      const currentHtml = applyToTranslated ? (doc.translatedContent || '') : doc.content;
      const patchResult = applyParagraphPatchesToHtml(currentHtml, patches);
      if (patchResult.appliedPatchIds.length === 0) {
        setAutoExecutionStatus({
          level: 'warning',
          message: '段落 patch 未命中当前内容，未执行写入。'
        });
        return;
      }

      onCreateSnapshot();
      if (applyToTranslated) {
        onUpdate(doc.id, { translatedContent: patchResult.html });
      } else {
        onUpdate(doc.id, { content: patchResult.html });
      }
      return;
    }

    if (applyToTranslated) {
      const currentTranslated = (doc.translatedContent || '').trim();
      const mergedTranslated = applyMode === 'append'
        ? (currentTranslated ? `${doc.translatedContent}<br/>${previewContent}` : previewContent)
        : applyMode === 'prepend'
          ? (currentTranslated ? `${previewContent}<br/>${doc.translatedContent}` : previewContent)
          : applyMode === 'update_block'
            ? (currentTranslated
                ? `${doc.translatedContent}${renderAiUpdateBlock(previewContent, 'translated')}`
                : renderAiUpdateBlock(previewContent, 'translated'))
            : previewContent;

      onCreateSnapshot();
      onUpdate(doc.id, {
        translatedContent: mergedTranslated
      });
      return;
    }

    let finalContent = previewContent;
    let finalTitle = doc.title;
    let baseContent = doc.content;

    if (doc.translatedContent) {
      baseContent = `<div class="bilingual-entry mb-8">
          <div class="original-section pb-4 border-b border-zinc-100 dark:border-zinc-800">
            <div class="text-[10px] font-bold text-zinc-400 uppercase mb-2">原文</div>
            ${doc.content}
          </div>
          <div class="translation-section pt-4">
            <div class="text-[10px] font-bold text-purple-400 uppercase mb-2">译文</div>
            ${doc.translatedContent}
          </div>
        </div>`;
    }

    if (applyMode === 'append') {
      finalContent = baseContent + '<br/>' + previewContent;
    } else if (applyMode === 'prepend') {
      finalContent = previewContent + '<br/>' + baseContent;
    } else if (applyMode === 'update_block') {
      finalContent = baseContent + renderAiUpdateBlock(previewContent, 'original');
    } else {
      const titleMatch = previewContent.match(/<(h1|h2)[^>]*>(.*?)<\/\1>/i);
      if (titleMatch && titleMatch[2]) {
        finalTitle = titleMatch[2].replace(/<[^>]*>/g, '').trim();
        finalContent = previewContent.replace(titleMatch[0], '').trim();
      }
    }

    onCreateSnapshot();
    onUpdate(doc.id, {
      content: finalContent,
      title: finalTitle || '无标题',
      translatedContent: doc.translatedContent
    });
  };

  const applyPreviewItem = (previewId?: string, forcedMode?: AiEditMode) => {
    const previewItem = previewId
      ? previewQueue.find(item => item.id === previewId) || null
      : activePreviewItem;
    const contentToApply = previewItem?.content || aiResult;
    if (!contentToApply) return;

    const modeToApply = forcedMode || previewItem?.mode || aiMode;
    const targetToApply = previewItem?.target || safeLastTarget;
    applyPreviewContent(contentToApply, modeToApply, targetToApply, previewItem?.patches);

    if (previewItem) {
      removePreviewItemFromQueue(previewItem.id);
    } else {
      setAiResult(null);
    }
  };

  const discardAiResult = () => {
    if (activePreviewItem) {
      removePreviewItemFromQueue(activePreviewItem.id);
      return;
    }
    setAiResult(null);
  };

  const handleCreateNewPageFromResult = (customContent?: string) => {
    const contentToUse = customContent || aiResult;
    if (!contentToUse) return;
    
    // 尝试解析 [CREATE_PAGE|Title|Content]
    const pageMatch = contentToUse.match(/\[CREATE_PAGE\|(.*?)\|(.*?)\]/);
    let title = '从 AI 生成';
    let content = contentToUse.replace(/\[CREATE_PAGE\|.*?\|.*?\]/g, '').trim();

    if (pageMatch) {
      title = pageMatch[1].trim();
      content = pageMatch[2].trim();
    } else {
      // 如果没有指令，尝试从正文中提取 H1/H2
      const titleMatch = contentToUse.match(/<(h1|h2)[^>]*>(.*?)<\/\1>/i);
      if (titleMatch && titleMatch[2]) {
        title = titleMatch[2].replace(/<[^>]*>/g, '').trim();
        content = contentToUse.replace(titleMatch[0], '').trim();
      }
    }

    onCreateDoc(null, { title, content });
    setAiResult(null);
    setIsAiMenuOpen(false);
  };

  const closeTranslation = () => {
    onUpdate(doc.id, { translatedContent: undefined });
    setIsTranslationTask(false);
    setTranslationStreamHtml('');
    translationStreamBufferRef.current = '';
  };

  const handleEditorUpdate = async (content: string) => {
    onUpdate(doc.id, { content });

    // 1. 魔法指令 (Magic Actions) 检测
    const currentPlainText = content.replace(/<[^>]*>/g, '').trim();
    const lastWord = currentPlainText.split(/[\s\n]+/).pop() || '';
    
    const MAGIC_TRIGGERS: Record<string, { name: string, prompt: string, action: string }> = {
      '#总结': { name: '全文总结', action: 'summarize', prompt: '请对以上内容进行简明扼要的总结，使用列表格式。' },
      '#待办': { name: '提取待办', action: 'action_items', prompt: '请从以上内容中提取出所有的待办事项 (Action Items)。' },
      '#润色': { name: '智能润色', action: 'polish', prompt: '请对以上内容进行专业润色，提升表达的流畅度和专业感。' },
      '#翻译': { name: '一键翻译', action: 'translate', prompt: '请将以上内容翻译成中文（如果是中文则翻译成英文）。' },
      '#表格': { name: '生成表格', action: 'generate_table', prompt: '请根据以上内容提取关键数据并整理成 HTML 表格。' },
      '#清单': { name: '待办清单', action: 'action_items', prompt: '请根据以上内容提取待办事项，并以 Notion 风格的待办列表格式返回（使用 <ul data-type="taskList"> 结构）。' },
      '#续写': { name: '长文续写', action: 'write', prompt: '请根据当前上下文内容，继续深入探讨并扩展写作，字数不少于 200 字。' }
    };

    if (MAGIC_TRIGGERS[lastWord]) {
      const magic = MAGIC_TRIGGERS[lastWord];
      // 移除触发词（支持从 HTML 中精确移除末尾的关键词）
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = content;
      const walker = document.createTreeWalker(tempDiv, NodeFilter.SHOW_TEXT, null);
      let lastTextNode = null;
      while(walker.nextNode()) lastTextNode = walker.currentNode;
      
      if (lastTextNode && lastTextNode.textContent?.includes(lastWord)) {
        lastTextNode.textContent = lastTextNode.textContent.replace(lastWord, '').trim();
        const contentWithoutTrigger = tempDiv.innerHTML;
        onUpdate(doc.id, { content: contentWithoutTrigger });
        
        setMagicActionStatus({ type: magic.name, status: 'processing' });
        
        try {
          const systemInstruction = `You are a magic workflow assistant. User triggered "${magic.name}". Execute the specific task. ALWAYS return result in HTML format. No commentary. No markdown code blocks. Use professional styling.`;
          const userPrompt = `Context content:\n${currentPlainText.replace(lastWord, '')}\n\nTask: ${magic.prompt}`;
          
          setAiResult(''); // 使用 aiResult 来展示魔法指令的流式过程
          const response = await callApi(systemInstruction, userPrompt, false, (chunk) => {
            setAiResult(prev => (prev || '') + chunk);
          });
          
          if (response) {
            let cleanResult = response.trim();
            if (cleanResult.startsWith('```')) {
              cleanResult = cleanResult.replace(/^```(html)?\n?/, '').replace(/\n?```$/, '');
            }

            const newContent = contentWithoutTrigger + `<div class="bg-purple-50/30 dark:bg-purple-900/10 p-4 rounded-xl border border-purple-100 dark:border-purple-900/30 my-4">
              <div class="flex items-center gap-2 mb-2 text-purple-600 dark:text-purple-400 font-bold text-xs uppercase">
                <span class="p-1 bg-purple-100 dark:bg-purple-900/50 rounded">✨ ${magic.name}结果</span>
              </div>
              ${cleanResult}
            </div><p></p>`;
            
            onUpdate(doc.id, { content: newContent });
            setAiResult(null); // 完成后清除预览
            setMagicActionStatus({ type: magic.name, status: 'done' });
            setTimeout(() => setMagicActionStatus(null), 3000);
          }
        } catch (err: any) {
          setMagicActionStatus({ type: magic.name, status: 'error', message: err.message });
          setTimeout(() => setMagicActionStatus(null), 5000);
        }
        return;
      }
    }

    // 2. AI 自动补全逻辑
    if (!settings.aiAutocomplete || isReadOnly) {
      setCompletion('');
      setCompletionError(null);
      setIsGettingCompletion(false);
      return;
    }

    const completionSignature = `${doc.id}:${currentPlainText.length}:${currentPlainText.slice(-200)}`;
    completionSignatureRef.current = completionSignature;
    setCompletion('');
    setCompletionError(null);
    setIsGettingCompletion(false);

    if (isProcessing) return;

    // 清除之前的定时器
    if (completionTimeoutRef.current) {
      clearTimeout(completionTimeoutRef.current);
      completionTimeoutRef.current = null;
    }

    // 如果内容太短，不触发
    if (currentPlainText.length < 2) {
      return;
    }

    const requestSeq = ++completionRequestSeqRef.current;

    // 设置短停顿后触发，接近 IDE 自动补全体验
    completionTimeoutRef.current = setTimeout(async () => {
      completionTimeoutRef.current = null;
      setIsGettingCompletion(true);
      try {
        const systemInstruction = "You are a ghostwriter assistant. Based on the provided context, predict and complete the next sentence or phrase. Keep it short (under 20 words), natural, and continue the user's flow. ONLY return the completion text, no commentary. Do not repeat the context.";
        const userPrompt = `Continue writing this text naturally:\n\n${currentPlainText}\n\nCompletion:`;

        const response = await callApi(systemInstruction, userPrompt);
        const isLatestRequest = requestSeq === completionRequestSeqRef.current;
        const isContextUnchanged = completionSignatureRef.current === completionSignature;
        if (!isLatestRequest || !isContextUnchanged) {
          return;
        }

        if (response && response.trim().length > 0) {
          let cleanResponse = response.trim();
          if (cleanResponse.toLowerCase().startsWith('completion:')) {
            cleanResponse = cleanResponse.substring(11).trim();
          }
          cleanResponse = cleanResponse.replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
          setCompletion(cleanResponse);
        }
      } catch (err: any) {
        if (requestSeq === completionRequestSeqRef.current) {
          setCompletionError(err.message);
        }
      } finally {
        if (requestSeq === completionRequestSeqRef.current) {
          setIsGettingCompletion(false);
        }
      }
    }, 900);
  };

  const applyChatResultToPage = (content: string) => {
    if (!isChatTaskMode) return;
    onUpdate(doc.id, { 
      content: doc.content + '<br/>' + content 
    });
    // 可以选自动关闭侧边栏或给出提示
  };

  const handleAcceptCompletion = () => {
    setCompletion('');
    setCompletionError(null);
  };

  const handleDismissCompletion = () => {
    setCompletion('');
    setCompletionError(null);
  };

  const exportToNotion = async (contentToExport: string, exportTitle: string) => {
    try {
      setIsProcessing(true);
      const response = await fetch('/api/notion/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          title: exportTitle || '无标题', 
          content: contentToExport,
          notionApiKey: settings.notionApiKey,
          notionPageId: settings.notionPageId
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '导出失败');
      }
      alert('成功导出到 Notion！\n\n链接: ' + data.url);
    } catch (err: any) {
      alert('导出失败: ' + err.message + '\n\n请确保:\n1. 已在设置中配置 Notion API Key 和 Page ID。\n2. 已将 Notion 集成邀请至目标页面 (Share -> Invite)。');
    } finally {
      setIsProcessing(false);
    }
  };

  const downloadHtmlAsFile = (htmlContent: string, filename: string, isBilingual: boolean = false) => {
    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${filename}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.tailwindcss.com?plugins=typography"></script>
  <style>
    body { background-color: #ffffff; padding: 2rem; font-family: system-ui, -apple-system, sans-serif; }
    .content-wrapper { max-width: ${isBilingual ? '1200px' : '800px'}; margin: 0 auto; }
    mark { background-color: #fef08a; padding: 0.125rem 0; border-radius: 0.125rem; }
  </style>
</head>
<body>
  <div class="content-wrapper">
    <h1 class="text-4xl font-bold text-zinc-900 mb-8">${filename}</h1>
    ${htmlContent}
  </div>
</body>
</html>`;
    const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename || 'document'}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`flex-1 flex h-full overflow-hidden bg-white dark:bg-zinc-900 relative ${isResizingAiSidebar ? 'cursor-col-resize select-none' : ''}`}>
      <div ref={scrollContainerRef} className={`flex-1 overflow-y-auto relative flex flex-col items-center scrollbar-hide ${isResizingAiSidebar ? 'pointer-events-none' : ''}`}>
        {/* Page Floating Toolbar */}
        <div className="w-full relative group/cover">
          {doc.coverImage ? (
            <div className="w-full h-[25vh] min-h-[180px] relative overflow-hidden">
              <img 
                src={doc.coverImage} 
                alt="Cover" 
                className="w-full h-full object-cover"
              />
              <div className="absolute bottom-4 right-4 flex items-center gap-2 opacity-0 group-hover/cover:opacity-100 transition-opacity">
                <button 
                  onClick={() => coverInputRef.current?.click()}
                  className="px-3 py-1.5 bg-white/90 dark:bg-zinc-800/90 hover:bg-white dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200 text-xs font-medium rounded shadow-sm backdrop-blur-sm transition-colors"
                >
                  更换封面
                </button>
                <button 
                  onClick={removeCover}
                  className="px-3 py-1.5 bg-white/90 dark:bg-zinc-800/90 hover:bg-white dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200 text-xs font-medium rounded shadow-sm backdrop-blur-sm transition-colors"
                >
                  移除
                </button>
              </div>
            </div>
          ) : (
            <div className="w-full h-24 group-hover/cover:h-32 transition-all duration-300 relative flex justify-center">
              <div className="w-full max-w-[800px] px-8 h-full relative">
                <div className="absolute bottom-4 left-8 flex gap-2 opacity-0 group-hover/cover:opacity-100 transition-all">
                  {!doc.icon && (
                    <button 
                      onClick={() => setShowIconPicker(true)}
                      className="px-3 py-1.5 flex items-center gap-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md"
                    >
                      <Smile className="w-4 h-4" />
                      添加图标
                    </button>
                  )}
                  <button 
                    onClick={() => coverInputRef.current?.click()}
                    className="px-3 py-1.5 flex items-center gap-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md"
                  >
                    <ImageIcon className="w-4 h-4" />
                    添加封面
                  </button>
                </div>
              </div>
            </div>
          )}
          <input 
            type="file" 
            ref={coverInputRef} 
            className="hidden" 
            accept="image/*"
            onChange={handleCoverUpload}
          />
        </div>

        {/* Scroll Progress Ruler (Notion style) */}
        {!doc.translatedContent && (
          <div className="absolute right-4 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1.5 z-50 pointer-events-none opacity-40 hover:opacity-100 transition-opacity">
            {[...Array(12)].map((_, i) => {
              // Calculate if this mark is the one closest to current scroll position
              const markPosition = (i / 11) * 100;
              const isActive = Math.abs(scrollPercentage - markPosition) < 4.5;
              return (
                <div 
                  key={i} 
                  className={`transition-all duration-300 ${
                    i % 3 === 0 
                      ? `w-3 h-[2px] ${isActive ? 'bg-zinc-800 dark:bg-zinc-200 w-4' : 'bg-zinc-300 dark:bg-zinc-700'}` 
                      : `w-1.5 h-[1.5px] ${isActive ? 'bg-zinc-600 dark:bg-zinc-400 w-2.5' : 'bg-zinc-200 dark:bg-zinc-800'}`
                  }`}
                />
              );
            })}
          </div>
        )}

        {/* Page Floating Toolbar */}
        <div className="absolute top-4 right-8 z-20 flex items-center gap-2">
          {/* Share Button & Menu */}
          <div className="relative">
            <button 
              onClick={() => setShowShareMenu(!showShareMenu)}
              className={`flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium border rounded-md transition-all shadow-sm backdrop-blur-sm ${doc.isPublic ? 'text-purple-600 bg-purple-50/80 border-purple-200 hover:bg-purple-100' : 'text-zinc-500 dark:text-zinc-400 bg-white/80 dark:bg-zinc-800/80 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-700'}`}
              title="分享文档"
            >
              <Share2 className="w-3.5 h-3.5" />
              <span>{doc.isPublic ? '已分享' : '分享'}</span>
            </button>

            {showShareMenu && (
              <div className="absolute right-0 mt-2 w-72 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl p-4 z-[70] animate-in fade-in slide-in-from-top-2 duration-200">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-xs font-bold text-zinc-400 uppercase">分享设置</span>
                  <button onClick={() => setShowShareMenu(false)} className="text-zinc-400 hover:text-zinc-600">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-lg ${doc.isPublic ? 'bg-purple-100 text-purple-600' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400'}`}>
                        {doc.isPublic ? <Globe className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                      </div>
                      <div>
                        <div className="text-xs font-bold text-zinc-700 dark:text-zinc-200">发布到网络</div>
                        <div className="text-[10px] text-zinc-400">任何人都可以通过链接访问</div>
                      </div>
                    </div>
                    <button 
                      onClick={toggleShare}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${doc.isPublic ? 'bg-purple-600' : 'bg-zinc-200 dark:bg-zinc-700'}`}
                    >
                      <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${doc.isPublic ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                  </div>

                  {doc.isPublic && (
                    <div className="space-y-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                      <button 
                        onClick={copyShareLink}
                        className="w-full flex items-center justify-center gap-2 py-2 text-xs font-medium text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded-lg transition-colors"
                      >
                        <Send className="w-3.5 h-3.5" />
                        复制分享链接
                      </button>
                      <button 
                        onClick={() => setIsReadOnly(!isReadOnly)}
                        className="w-full flex items-center justify-center gap-2 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        {isReadOnly ? '进入编辑模式' : '预览分享页面'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="relative">
            <button
              onClick={() => setShowSnapshotMenu(!showSnapshotMenu)}
              className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 bg-white/80 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 rounded-md hover:bg-zinc-50 dark:hover:bg-zinc-700 hover:text-zinc-900 dark:hover:text-zinc-200 transition-all shadow-sm backdrop-blur-sm"
              title="版本快照"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>版本</span>
              {snapshots.length > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-700 text-[10px]">
                  {snapshots.length}
                </span>
              )}
            </button>

            {showSnapshotMenu && (
              <div className="absolute right-0 mt-2 w-[320px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl p-3 z-[70] animate-in fade-in slide-in-from-top-2 duration-200">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-bold text-zinc-500 uppercase">版本快照</span>
                  <button
                    onClick={() => setShowSnapshotMenu(false)}
                    className="p-1 text-zinc-400 hover:text-zinc-600 rounded"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                <button
                  onClick={onCreateSnapshot}
                  className="w-full mb-3 py-2 rounded-lg text-xs font-medium text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/20 border border-purple-100 dark:border-purple-900/40 transition-colors"
                >
                  保存当前快照
                </button>

                <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                  {snapshots.length > 0 ? (
                    snapshots.map((snapshot) => (
                      <div key={snapshot.id} className="p-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-100 dark:border-zinc-800">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-zinc-700 dark:text-zinc-200 truncate">{snapshot.title || '无标题'}</div>
                            <div className="text-[10px] text-zinc-400">{formatSnapshotTime(snapshot.createdAt)}</div>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => onRestoreSnapshot(snapshot.id)}
                              className="px-2 py-1 text-[10px] rounded bg-zinc-200/70 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors"
                            >
                              恢复
                            </button>
                            <button
                              onClick={() => onDeleteSnapshot(snapshot.id)}
                              className="px-2 py-1 text-[10px] rounded text-zinc-400 hover:text-red-500 transition-colors"
                            >
                              删除
                            </button>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="py-4 text-center text-[11px] text-zinc-400">还没有保存的快照</div>
                  )}
                </div>
              </div>
            )}
          </div>

          <button 
            onClick={() => {
              if (doc.translatedContent) {
                const combinedHtml = `<h2>原文</h2>\n${doc.content}\n<h2>译文</h2>\n${doc.translatedContent}`;
                exportToNotion(combinedHtml, doc.title + ' (双语)');
              } else {
                exportToNotion(doc.content, doc.title);
              }
            }}
            className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 bg-white/80 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 rounded-md hover:bg-zinc-50 dark:hover:bg-zinc-700 hover:text-zinc-900 dark:hover:text-zinc-200 transition-all shadow-sm backdrop-blur-sm"
            title="导出至 Notion"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Notion</span>
          </button>
          <button 
            onClick={() => {
              if (doc.translatedContent) {
                const combinedHtml = `
                  <div class="flex gap-8">
                    <div class="flex-1">
                      <h2 class="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">原文</h2>
                      <div class="prose prose-zinc max-w-none prose-p:leading-relaxed prose-headings:font-semibold">${doc.content}</div>
                    </div>
                    <div class="flex-1">
                      <h2 class="text-xs font-semibold text-purple-500 uppercase tracking-wider mb-4">译文</h2>
                      <div class="prose prose-zinc max-w-none prose-p:leading-relaxed prose-headings:font-semibold">${doc.translatedContent}</div>
                    </div>
                  </div>
                `;
                downloadHtmlAsFile(combinedHtml, doc.title + ' (双语)', true);
              } else {
                const content = `<div class="prose prose-zinc max-w-none prose-p:leading-relaxed prose-headings:font-semibold">${doc.content}</div>`;
                downloadHtmlAsFile(content, doc.title);
              }
            }}
            className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 bg-white/80 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 rounded-md hover:bg-zinc-50 dark:hover:bg-zinc-700 hover:text-zinc-900 dark:hover:text-zinc-200 transition-all shadow-sm backdrop-blur-sm"
            title="下载文档"
          >
            <Download className="w-3.5 h-3.5" />
            <span>下载</span>
          </button>
        </div>

        {/* Page Header (Icon & Title) */}
        <div className={`w-full transition-all duration-300 relative ${doc.translatedContent ? 'px-8 lg:px-12 pt-8' : 'max-w-[800px] px-8 pt-8'}`}>
          <div className={`flex items-start gap-4 transition-all duration-500 ${doc.coverImage ? 'mt-4' : 'mt-8'}`}>
            {/* Icon Position - Now at the left of the title */}
            <div className="relative group/icon shrink-0">
              {doc.icon ? (
                <div 
                  className="text-5xl cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800 p-2 rounded-xl transition-colors leading-none"
                  onClick={() => setShowIconPicker(!showIconPicker)}
                >
                  {doc.icon}
                </div>
              ) : (
                <button 
                  onClick={() => setShowIconPicker(true)}
                  className="p-2 text-zinc-300 hover:text-zinc-500 dark:hover:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl transition-all"
                  title="添加图标"
                >
                  <Smile className="w-10 h-10" />
                </button>
              )}
              
              {doc.icon && (
                <button 
                  onClick={removeIcon}
                  className="absolute -top-1 -right-1 p-1 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-full shadow-sm opacity-0 group-hover/icon:opacity-100 transition-opacity"
                >
                  <X className="w-3 h-3 text-zinc-400" />
                </button>
              )}

              {showIconPicker && (
                <div className="absolute top-full left-0 mt-2 z-[60] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl p-4 w-72 animate-in zoom-in duration-200">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-bold text-zinc-400 uppercase">选择图标</span>
                    <button onClick={() => setShowIconPicker(false)} className="text-zinc-400 hover:text-zinc-600">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="grid grid-cols-5 gap-2 max-h-60 overflow-y-auto pr-1 custom-scrollbar">
                    {COMMON_EMOJIS.map((emoji, index) => (
                      <button 
                        key={`${emoji}-${index}`}
                        onClick={() => handleIconSelect(emoji)}
                        className="text-2xl p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <textarea
              ref={titleRef}
              value={doc.title}
              onChange={(e) => onUpdate(doc.id, { title: e.target.value })}
              placeholder="无标题"
              className="flex-1 text-5xl font-bold text-zinc-900 dark:text-zinc-100 bg-transparent border-none outline-none resize-none overflow-hidden placeholder:text-zinc-200 dark:placeholder:text-zinc-800 leading-tight pt-1"
              rows={1}
            />
          </div>
        </div>

        {(settings.aiAutomation || doc.aiSummary || (doc.aiTags && doc.aiTags.length > 0) || (doc.aiActionItems && doc.aiActionItems.length > 0)) && (
          <div className={`w-full transition-all duration-300 ${doc.translatedContent ? 'px-8 lg:px-12' : 'max-w-[800px] px-8'}`}>
            <div className="mt-3 mb-1 p-3 rounded-xl border border-purple-100 dark:border-purple-900/40 bg-purple-50/50 dark:bg-purple-900/10">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-purple-700 dark:text-purple-300 uppercase tracking-wider">
                  <Sparkles className={`w-3.5 h-3.5 ${isAutoAnalyzing ? 'animate-pulse' : ''}`} />
                  AI 自动洞察
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => runAutoInsights(true)}
                    disabled={isAutoAnalyzing || isProcessing}
                    className="px-2 py-1 text-[10px] rounded-md bg-white dark:bg-zinc-800 border border-purple-200 dark:border-purple-900/50 text-purple-600 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-900/20 disabled:opacity-60 transition-colors"
                  >
                    {isAutoAnalyzing ? '分析中...' : '立即更新'}
                  </button>
                  {doc.aiActionItems && doc.aiActionItems.length > 0 && (
                    <button
                      onClick={runTopInsightAutomation}
                      disabled={isAutoAnalyzing || isProcessing || isReadOnly}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded-md bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-60 transition-colors"
                    >
                      <Wand2 className="w-3 h-3" />
                      预览Top3
                    </button>
                  )}
                  <button
                    onClick={() => setIsAutoInsightCollapsed(prev => !prev)}
                    className="px-2 py-1 text-[10px] rounded-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-purple-600 dark:hover:text-purple-300 transition-colors"
                    title={isAutoInsightCollapsed ? '展开自动洞察' : '收起自动洞察'}
                  >
                    {isAutoInsightCollapsed ? (
                      <span className="inline-flex items-center gap-1"><ChevronDown className="w-3 h-3" /> 展开</span>
                    ) : (
                      <span className="inline-flex items-center gap-1"><ChevronUp className="w-3 h-3" /> 收起</span>
                    )}
                  </button>
                </div>
              </div>

              {isAutoInsightCollapsed ? (
                <div className="mt-2 text-[10px] text-zinc-400">
                  已收起自动洞察详情，点击“展开”查看摘要、策略和执行建议。
                </div>
              ) : (
                <>
              <div className="mt-2 rounded-lg border border-zinc-200/80 dark:border-zinc-700/70 bg-white/70 dark:bg-zinc-800/50 p-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">自动化策略中心</div>
                  <div className="text-[9px] text-zinc-400">
                    {automationStrategy.executionMode === 'auto_apply' ? '自动执行' : '预览优先'}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    onClick={() => updateAutomationStrategy(prev => ({ ...prev, executionMode: 'preview' }))}
                    className={`px-2 py-1 rounded text-[10px] font-bold transition-colors ${
                      automationStrategy.executionMode === 'preview'
                        ? 'bg-purple-600 text-white'
                        : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400'
                    }`}
                  >
                    自动预览
                  </button>
                  <button
                    onClick={() => updateAutomationStrategy(prev => ({ ...prev, executionMode: 'auto_apply' }))}
                    className={`px-2 py-1 rounded text-[10px] font-bold transition-colors ${
                      automationStrategy.executionMode === 'auto_apply'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400'
                    }`}
                  >
                    自动执行
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[10px] text-zinc-500 dark:text-zinc-400">
                    执行目标
                    <select
                      value={automationStrategy.targetPreference}
                      onChange={(e) => updateAutomationStrategy(prev => ({
                        ...prev,
                        targetPreference: e.target.value as AutomationStrategy['targetPreference']
                      }))}
                      className="mt-1 w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-[10px] text-zinc-700 dark:text-zinc-200"
                    >
                      <option value="follow_selector">跟随当前选择</option>
                      <option value="original">固定原文</option>
                      {isDualColumn && <option value="translated">固定译文</option>}
                    </select>
                  </label>

                  <label className="text-[10px] text-zinc-500 dark:text-zinc-400">
                    风险阈值
                    <select
                      value={automationStrategy.riskTolerance}
                      onChange={(e) => updateAutomationStrategy(prev => ({
                        ...prev,
                        riskTolerance: e.target.value as AutomationStrategy['riskTolerance']
                      }))}
                      className="mt-1 w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-[10px] text-zinc-700 dark:text-zinc-200"
                    >
                      <option value="low">仅低风险</option>
                      <option value="medium">低+中风险</option>
                      <option value="high">全部允许</option>
                    </select>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[10px] text-zinc-500 dark:text-zinc-400">
                    空闲触发
                    <select
                      value={String(automationStrategy.idleMs)}
                      onChange={(e) => updateAutomationStrategy(prev => ({ ...prev, idleMs: Number(e.target.value) }))}
                      className="mt-1 w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-[10px] text-zinc-700 dark:text-zinc-200"
                    >
                      {AUTO_EXECUTION_IDLE_OPTIONS.map(ms => (
                        <option key={ms} value={ms}>
                          {formatAutoIdleLabel(ms)}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="text-[10px] text-zinc-500 dark:text-zinc-400">
                    单次条数
                    <select
                      value={String(automationStrategy.maxItems)}
                      onChange={(e) => updateAutomationStrategy(prev => ({ ...prev, maxItems: Number(e.target.value) }))}
                      className="mt-1 w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-[10px] text-zinc-700 dark:text-zinc-200"
                    >
                      {[1, 2, 3, 4, 5].map(count => (
                        <option key={count} value={count}>{count} 条</option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="text-[9px] text-zinc-400">
                  当前策略：{automationStrategy.executionMode === 'auto_apply' ? '自动执行并写入' : '只生成预览'} ·
                  风险 {automationStrategy.riskTolerance} ·
                  空闲 {formatAutoIdleLabel(automationStrategy.idleMs)}
                </div>
              </div>

              {isDualColumn && (
                <div className="mt-2 rounded-lg border border-zinc-200/80 dark:border-zinc-700/70 bg-white/70 dark:bg-zinc-800/50 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[10px] text-zinc-500 dark:text-zinc-400">洞察执行目标</div>
                    <div className="flex p-0.5 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
                      <button
                        onClick={() => setAiTarget('original')}
                        className={`px-2 py-1 text-[10px] font-bold rounded-md transition-all ${safeActiveTarget === 'original' ? 'bg-white dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'}`}
                      >
                        原文
                      </button>
                      <button
                        onClick={() => setAiTarget('translated')}
                        className={`px-2 py-1 text-[10px] font-bold rounded-md transition-all ${safeActiveTarget === 'translated' ? 'bg-white dark:bg-zinc-700 text-purple-600 dark:text-purple-300 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'}`}
                      >
                        译文
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 text-[9px] text-zinc-400">
                    当前执行到：{safeActiveTarget === 'translated' ? '右侧译文栏' : '左侧原文栏'}。洞察执行会先出预览，再由你确认替换或追加。
                  </div>
                </div>
              )}

              {doc.aiSummary && (
                <div className="mt-2 text-sm text-zinc-700 dark:text-zinc-200 leading-relaxed">{doc.aiSummary}</div>
              )}

              {doc.aiTags && doc.aiTags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {doc.aiTags.map((tag, index) => (
                    <span key={`${tag}-${index}`} className="px-2 py-0.5 text-[10px] rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300">
                      #{tag}
                    </span>
                  ))}
                </div>
              )}

              {doc.aiActionItems && doc.aiActionItems.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {doc.aiActionItems.slice(0, 5).map((item, index) => (
                    <li key={`${item}-${index}`} className="text-[11px] text-zinc-600 dark:text-zinc-300 rounded-lg border border-zinc-200/70 dark:border-zinc-700/60 bg-white/80 dark:bg-zinc-800/60 px-2 py-1.5">
                      <div className="flex items-start gap-1.5">
                        <span className="mt-1 w-1 h-1 rounded-full bg-purple-500 shrink-0"></span>
                        <span className="flex-1">{item}</span>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <div className="flex flex-wrap gap-1">
                          {mapInsightItemToActions(item).slice(0, 3).map((action) => (
                            <span key={`${item}-${action}`} className="px-1.5 py-0.5 rounded-full text-[9px] bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300">
                              {actionLabelMap[action] || action}
                            </span>
                          ))}
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => applyInsightItemToPanel(item)}
                            className="px-1.5 py-0.5 rounded text-[9px] border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-purple-600 hover:border-purple-300"
                          >
                            加入动作
                          </button>
                          <button
                            onClick={() => runInsightItemDirectly(item)}
                            disabled={isProcessing || isReadOnly}
                            className="px-1.5 py-0.5 rounded text-[9px] bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-60"
                          >
                            生成预览
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {autoInsightError && (
                <div className="mt-2 text-[10px] text-red-500">{autoInsightError}</div>
              )}

              {autoExecutionStatus && (
                <div className={`mt-2 text-[10px] ${
                  autoExecutionStatus.level === 'warning'
                    ? 'text-amber-600 dark:text-amber-400'
                    : autoExecutionStatus.level === 'success'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : autoExecutionStatus.level === 'running'
                        ? 'text-purple-600 dark:text-purple-300'
                        : 'text-zinc-500'
                }`}>
                  {autoExecutionStatus.message}
                </div>
              )}

              {previewQueue.length > 0 && (
                <div className="mt-2 text-[10px] text-purple-600 dark:text-purple-300">
                  待确认预览：{previewQueue.length} 条（可在下方预览区逐条替换 / 追加 / 忽略）
                </div>
              )}

              {doc.autoInsightsUpdatedAt && (
                <div className="mt-2 text-[10px] text-zinc-400">
                  更新时间: {new Date(doc.autoInsightsUpdatedAt).toLocaleString()}
                </div>
              )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Main Editor Area */}
        <div className={`w-full pb-32 flex-1 flex flex-col transition-all duration-300 relative ${doc.translatedContent !== undefined ? 'px-8 lg:px-12 py-4' : 'max-w-[800px] px-8 py-4'}`}>
          {(aiResult || (isProcessing && !isTranslationTask && mode !== 'chat')) ? (
          <div className={`flex-1 flex gap-8 ${doc.translatedContent !== undefined ? 'flex-row items-start' : 'flex-col'}`}>
            <div className="flex-1 flex flex-col gap-4 min-w-0">
              <div className="bg-purple-50/50 dark:bg-purple-900/10 border border-purple-100 dark:border-purple-900/30 rounded-xl p-6 relative">
                {!isProcessing && aiResult && (
                  <div className="absolute top-4 right-4 flex items-center gap-2 z-10 animate-in fade-in duration-300">
                    <button onClick={() => handleCreateNewPageFromResult()} className="flex items-center gap-1 px-3 py-1.5 bg-white dark:bg-zinc-800 border border-purple-200 dark:border-purple-800 text-purple-600 dark:text-purple-400 text-xs font-bold rounded-md hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-colors shadow-sm">
                      <Plus className="w-3.5 h-3.5" /> 创建到新页面
                    </button>
                    <button onClick={() => exportToNotion(aiResult, doc.title + ' (优化版)')} className="flex items-center gap-1 px-3 py-1.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 text-xs font-medium rounded-md hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors">
                      <Send className="w-3.5 h-3.5" /> Notion
                    </button>
                    <button onClick={() => {
                      const content = `<div class="prose prose-zinc max-w-none prose-p:leading-relaxed prose-headings:font-semibold">${aiResult}</div>`;
                      downloadHtmlAsFile(content, doc.title + ' (优化版)');
                    }} className="flex items-center gap-1 px-3 py-1.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 text-xs font-medium rounded-md hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors">
                      <Download className="w-3.5 h-3.5" /> 下载
                    </button>
                    <button onClick={() => applyPreviewItem(activePreviewItem?.id)} className="flex items-center gap-1 px-3 py-1.5 bg-purple-600 text-white text-xs font-medium rounded-md hover:bg-purple-700 transition-colors shadow-sm">
                      <Check className="w-3.5 h-3.5" /> 按预设应用({getAiModeLabel(activePreviewItem?.mode || aiMode)})
                    </button>
                    {(activePreviewItem?.mode || aiMode) !== 'update_block' && (
                      <button onClick={() => applyPreviewItem(activePreviewItem?.id, 'append')} className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white text-xs font-medium rounded-md hover:bg-emerald-700 transition-colors shadow-sm">
                        <Plus className="w-3.5 h-3.5" /> 追加
                      </button>
                    )}
                    <button onClick={discardAiResult} className="flex items-center gap-1 px-3 py-1.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 text-xs font-medium rounded-md hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors">
                      <X className="w-3.5 h-3.5" /> 忽略
                    </button>
                  </div>
                )}
                <div className="flex items-center gap-2 mb-4 text-purple-700 dark:text-purple-400 font-medium text-sm">
                  <Sparkles className={`w-4 h-4 ${isProcessing ? 'animate-pulse' : ''}`} />
                  {isProcessing ? 'AI 正在生成内容...' : 'AI 生成结果'}
                </div>

                {previewQueue.length > 0 && (
                  <div className="mb-4 rounded-lg border border-purple-200/70 dark:border-purple-800/60 bg-white/80 dark:bg-zinc-800/70 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[10px] font-bold text-purple-600 dark:text-purple-300 uppercase tracking-wider">
                        预览队列 ({previewQueue.length})
                      </div>
                      <button
                        onClick={clearPreviewQueue}
                        className="text-[10px] text-zinc-500 hover:text-red-500"
                      >
                        清空
                      </button>
                    </div>
                    <div className="mt-2 max-h-40 overflow-y-auto custom-scrollbar space-y-1.5 pr-1">
                      {previewQueue.map(item => {
                        const isActive = activePreviewItem?.id === item.id;
                        return (
                          <div
                            key={item.id}
                            className={`rounded-lg border px-2 py-1.5 ${
                              isActive
                                ? 'border-purple-300 bg-purple-50/70 dark:border-purple-700 dark:bg-purple-900/20'
                                : 'border-zinc-200 dark:border-zinc-700 bg-white/90 dark:bg-zinc-900/40'
                            }`}
                          >
                            <button
                              onClick={() => activatePreviewItem(item.id)}
                              className="w-full text-left"
                            >
                              <div className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200 truncate">
                                {item.title}
                              </div>
                              <div className="mt-1 flex items-center flex-wrap gap-1 text-[9px] text-zinc-400">
                                <span>{item.trigger === 'auto_execute' ? '自动' : '手动'}</span>
                                <span>·</span>
                                <span>{item.target === 'translated' ? '译文目标' : '原文目标'}</span>
                                <span>·</span>
                                <span>{getAiModeLabel(item.mode)}</span>
                                <span>·</span>
                                <span>{new Date(item.createdAt).toLocaleTimeString()}</span>
                              </div>
                            </button>
                            <div className="mt-1.5 flex items-center gap-1">
                              <button
                                onClick={() => applyPreviewItem(item.id)}
                                className="px-1.5 py-0.5 rounded text-[9px] bg-purple-600 text-white hover:bg-purple-700"
                              >
                                预设
                              </button>
                              {item.mode !== 'update_block' && (
                                <>
                                  <button
                                    onClick={() => applyPreviewItem(item.id, 'replace')}
                                    className="px-1.5 py-0.5 rounded text-[9px] bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-200 hover:text-purple-600"
                                  >
                                    替换
                                  </button>
                                  <button
                                    onClick={() => applyPreviewItem(item.id, 'append')}
                                    className="px-1.5 py-0.5 rounded text-[9px] bg-emerald-600 text-white hover:bg-emerald-700"
                                  >
                                    追加
                                  </button>
                                </>
                              )}
                              <button
                                onClick={() => removePreviewItemFromQueue(item.id)}
                                className="px-1.5 py-0.5 rounded text-[9px] border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-red-500"
                              >
                                忽略
                              </button>
                            </div>

                            {isActive && item.mode === 'update_block' && item.patches && item.patches.length > 0 && (
                              <div className="mt-2 space-y-1.5 border-t border-zinc-200/70 dark:border-zinc-700/70 pt-2">
                                {item.patches.map((patch, patchIndex) => (
                                  <div key={patch.id} className="rounded-md border border-zinc-200/70 dark:border-zinc-700/70 bg-white/80 dark:bg-zinc-900/50 p-1.5">
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="min-w-0">
                                        <div className="text-[9px] font-bold text-purple-600 dark:text-purple-300">
                                          Patch {patchIndex + 1} · {getPatchActionLabel(patch.action)}
                                        </div>
                                        <div className="mt-0.5 text-[9px] text-zinc-500 dark:text-zinc-400 truncate">
                                          锚点：{patch.find}
                                        </div>
                                        {patch.reason && (
                                          <div className="mt-0.5 text-[9px] text-zinc-400 truncate">
                                            说明：{patch.reason}
                                          </div>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-1 shrink-0">
                                        <button
                                          onClick={() => applySinglePatchFromPreview(item.id, patch.id)}
                                          className="px-1.5 py-0.5 rounded text-[9px] bg-purple-600 text-white hover:bg-purple-700"
                                        >
                                          应用此段
                                        </button>
                                        <button
                                          onClick={() => dismissSinglePatchFromPreview(item.id, patch.id)}
                                          className="px-1.5 py-0.5 rounded text-[9px] border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-red-500"
                                        >
                                          忽略
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                 
                {isProcessing && !aiResult ? (
                  <div className="flex items-center gap-3 py-12 justify-center animate-in fade-in duration-500">
                    <Loader2 className="w-5 h-5 text-purple-500 animate-spin" />
                    <div className="text-xs text-zinc-400 font-medium animate-pulse uppercase tracking-widest">
                      AI 正在理解指令并准备输出...
                    </div>
                  </div>
                ) : (
                  <div className="prose prose-zinc dark:prose-invert max-w-none prose-p:leading-relaxed prose-headings:font-semibold select-text cursor-auto animate-in fade-in duration-700" dangerouslySetInnerHTML={{ __html: sanitizedAiResultHtml }} />
                )}
              </div>
              
              {!isProcessing && doc.translatedContent === undefined && (
                <>
                  <div className="text-xs font-medium text-zinc-400 uppercase tracking-wider mt-4 mb-2">原文</div>
                  <div className="opacity-50 pointer-events-none">
                    <div className="prose prose-zinc dark:prose-invert max-w-none prose-p:leading-relaxed prose-headings:font-semibold" dangerouslySetInnerHTML={{ __html: sanitizedDocPreviewHtml }} />
                  </div>
                </>
              )}
            </div>

            {doc.translatedContent !== undefined && (
              <div className="flex-1 flex flex-col gap-4 min-w-0">
                <div className="bg-zinc-50/50 dark:bg-zinc-800/20 border border-zinc-100 dark:border-zinc-800/50 rounded-xl p-6 relative opacity-60">
                  <div className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                    <div className={`w-1.5 h-1.5 rounded-full ${safeLastTarget === 'translated' ? 'bg-purple-400' : 'bg-zinc-300'}`} />
                    {safeLastTarget === 'translated' ? '当前译文 (对照)' : '当前原文 (对照)'}
                  </div>
                  <div className="prose prose-zinc dark:prose-invert max-w-none prose-p:leading-relaxed prose-headings:font-semibold select-text" dangerouslySetInnerHTML={{ __html: sanitizedAiComparePreviewHtml }} />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className={`flex-1 relative transition-all duration-500`}>
            {doc.translatedContent !== undefined ? (
              <div className="flex gap-8 h-full animate-in fade-in slide-in-from-bottom-2 duration-500">
                <div className="flex-1 border-r border-zinc-200 dark:border-zinc-800 pr-8">
                  <div className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-zinc-300" />
                    原文内容
                  </div>
                  <TiptapEditor 
                    content={doc.content} 
                    onChange={(content) => onUpdate(doc.id, { content })} 
                    onAskAi={handleAskAiAboutSelection}
                    isReadOnly={isReadOnly}
                  />
                </div>
                <div className="flex-1 pl-4 relative flex flex-col h-full">
                  <div className="text-[10px] font-bold text-purple-500 uppercase tracking-widest mb-4 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-2">
                      <div className={`w-1.5 h-1.5 rounded-full bg-purple-500 ${isProcessing ? 'animate-pulse' : ''}`} />
                      AI 译文对比
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => exportToNotion(doc.translatedContent || '', doc.title + ' (译文)')} className="text-zinc-400 hover:text-zinc-700 p-1 rounded-md hover:bg-zinc-100 transition-colors" title="导出译文至 Notion">
                        <Send className="w-4 h-4" />
                      </button>
                      <button onClick={() => {
                        const content = `<div class="prose prose-zinc max-w-none prose-p:leading-relaxed prose-headings:font-semibold">${doc.translatedContent}</div>`;
                        downloadHtmlAsFile(content, doc.title + ' (译文)');
                      }} className="text-zinc-400 hover:text-zinc-700 p-1 rounded-md hover:bg-zinc-100 transition-colors" title="下载译文">
                        <Download className="w-4 h-4" />
                      </button>
                      <button onClick={closeTranslation} className="text-zinc-400 hover:text-zinc-700 p-1 rounded-md hover:bg-zinc-100 transition-colors" title="关闭译文">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto custom-scrollbar">
                    {isProcessing && isTranslationTask ? (
                      <div className="h-full min-h-[400px] border border-purple-200/80 dark:border-purple-800/80 rounded-2xl bg-gradient-to-b from-purple-50/40 to-white dark:from-purple-900/20 dark:to-zinc-900/60 animate-in fade-in duration-300 overflow-hidden">
                        <div className="px-5 py-3 border-b border-purple-100 dark:border-purple-900/40 flex items-center gap-2 text-purple-600 dark:text-purple-300 text-[10px] font-bold uppercase tracking-widest">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          AI 正在逐段翻译中
                        </div>
                        <div ref={translationStreamContainerRef} className="h-[calc(100%-38px)] overflow-y-auto custom-scrollbar px-5 py-4">
                          {translationStreamHtml ? (
                            <div className="prose prose-zinc dark:prose-invert max-w-none prose-p:leading-relaxed prose-headings:font-semibold select-text animate-in fade-in duration-500" dangerouslySetInnerHTML={{ __html: sanitizedTranslationStreamingHtml }} />
                          ) : (
                            <div className="flex flex-col items-center justify-center h-full text-purple-500/70 dark:text-purple-400/70">
                              <div className="preloader-container scale-75 mb-3">
                                <div className="preloader">
                                  <div className="crack crack1 crack-animate"></div>
                                  <div className="crack crack2 crack-animate"></div>
                                  <div className="crack crack3 crack-animate"></div>
                                  <div className="crack crack4 crack-animate"></div>
                                  <div className="crack crack5 crack-animate"></div>
                                </div>
                              </div>
                              <span className="text-[10px] font-bold uppercase tracking-widest">正在准备首段译文...</span>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="relative">
                        <TiptapEditor 
                          content={doc.translatedContent} 
                          onChange={(content) => onUpdate(doc.id, { translatedContent: content })} 
                          onAskAi={handleAskAiAboutSelection}
                          isReadOnly={isReadOnly}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="relative w-full h-full flex flex-col">
                <div className="flex-1 pr-2 custom-scrollbar overflow-y-auto">
                  <TiptapEditor 
                    content={doc.content} 
                    onChange={handleEditorUpdate} 
                    onAskAi={handleAskAiAboutSelection}
                    isReadOnly={isReadOnly}
                    completionText={completion}
                    isGettingCompletion={isGettingCompletion}
                    onAcceptCompletion={handleAcceptCompletion}
                    onDismissCompletion={handleDismissCompletion}
                  />
                </div>
                
                {/* Magic Actions 状态提示 */}
                {magicActionStatus && (
                  <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[110] animate-in fade-in slide-in-from-top-4 duration-300">
                    <div className={`px-4 py-2 rounded-full shadow-2xl flex items-center gap-3 backdrop-blur-md border ${
                      magicActionStatus.status === 'error' 
                        ? 'bg-red-500/90 text-white border-red-400' 
                        : 'bg-purple-600/90 text-white border-purple-400'
                    }`}>
                      {magicActionStatus.status === 'processing' ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : magicActionStatus.status === 'done' ? (
                        <Check className="w-4 h-4" />
                      ) : (
                        <Zap className="w-4 h-4" />
                      )}
                      <span className="text-xs font-bold tracking-wide">
                        {magicActionStatus.status === 'processing' ? `正在执行魔法: ${magicActionStatus.type}...` : 
                         magicActionStatus.status === 'done' ? `${magicActionStatus.type}已完成！` : 
                         `错误: ${magicActionStatus.message}`}
                      </span>
                    </div>
                  </div>
                )}

                {completionError && !isReadOnly && (
                  <div className="absolute right-4 bottom-4 z-[100] bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/50 px-3 py-2 rounded-lg shadow-lg flex items-center gap-2">
                    <X className="w-3.5 h-3.5 text-red-500" />
                    <span className="text-xs text-red-600 dark:text-red-400">{completionError}</span>
                    <button onClick={() => setCompletionError(null)} className="p-0.5 hover:bg-red-100 dark:hover:bg-red-800 rounded">
                      <X className="w-3 h-3 text-red-400" />
                    </button>
                  </div>
                )}

              </div>
            )}
          </div>
        )}
      </div>
      </div>

      {/* AI Sidebar */}
      <aside 
        style={{ width: isAiMenuOpen ? `${aiSidebarWidth}px` : '0px' }}
        className={`flex flex-col h-full bg-[#FBFBFB] dark:bg-zinc-900 border-l border-zinc-200 dark:border-zinc-800 flex-shrink-0 relative group/ai-sidebar z-30 ${!isAiMenuOpen ? 'opacity-0 overflow-hidden' : 'opacity-100'} ${isResizingAiSidebar ? '' : 'transition-[width] duration-300 ease-in-out'}`}
      >
        {/* Resize Handle for AI Sidebar */}
        <div 
          onMouseDown={startResizingAiSidebar}
          className={`absolute top-0 -left-[1.5px] w-[3px] h-full cursor-col-resize hover:bg-purple-500/50 transition-all z-50 group-hover/ai-sidebar:w-[4px] ${isResizingAiSidebar ? 'bg-purple-500/80 w-[4px]' : 'bg-transparent'}`}
        >
          <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[1.5px] h-8 bg-zinc-300 dark:bg-zinc-600 rounded-full transition-opacity ${isResizingAiSidebar ? 'opacity-100' : 'opacity-0 group-hover/ai-sidebar:opacity-100'}`} />
        </div>
        <div className="w-full h-full flex flex-col overflow-hidden relative">
        {/* Close Button - Moved to a more discreet floating position if needed, or just remove as requested */}
        {!isResizingAiSidebar && (
          <button 
            onClick={() => setIsAiMenuOpen(false)} 
            className="absolute top-2 right-2 p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 rounded-full hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 transition-all z-50 opacity-0 group-hover/ai-sidebar:opacity-100"
            title="关闭侧边栏"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        
        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col scrollbar-hide pt-8">
          <div className="flex p-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg mb-6 flex-shrink-0">
            <button 
              onClick={() => setMode('edit')}
              className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-all ${mode === 'edit' ? 'bg-white dark:bg-zinc-700 text-zinc-800 dark:text-zinc-200 shadow-sm' : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'}`}
            >
              针对页面
            </button>
            <button 
              onClick={() => setMode('chat')}
              className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-all ${mode === 'chat' ? 'bg-white dark:bg-zinc-700 text-zinc-800 dark:text-zinc-200 shadow-sm' : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'}`}
            >
              自由对话
            </button>
          </div>

          {mode === 'edit' ? (
            <>
              <div className="flex flex-col items-center mt-3 mb-4">
                <div className="w-10 h-10 bg-white dark:bg-zinc-800 rounded-full shadow-sm flex items-center justify-center mb-3 border border-zinc-200 dark:border-zinc-700">
                  <div className="preloader-container scale-75">
                    <div className="preloader">
                      <div className="crack crack1 crack-animate"></div>
                      <div className="crack crack2 crack-animate"></div>
                      <div className="crack crack3 crack-animate"></div>
                      <div className="crack crack4 crack-animate"></div>
                      <div className="crack crack5 crack-animate"></div>
                    </div>
                  </div>
                </div>
                <h2 className="text-lg font-bold text-zinc-800 dark:text-zinc-100">今日事，我来帮。</h2>
              </div>

              <div className="px-3 mb-4">
                <div className="rounded-xl border border-purple-200 dark:border-purple-900/50 bg-purple-50/40 dark:bg-purple-900/10 p-3">
                  <button
                    onClick={() => setShowGoalHub(prev => !prev)}
                    className="w-full flex items-center justify-between gap-2 text-left"
                  >
                    <div>
                      <div className="text-[10px] font-bold text-purple-600 dark:text-purple-300 uppercase tracking-wider">AI Goal Hub</div>
                      <div className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-400">
                        {showGoalHub ? '收起目标拆解配置' : '展开目标拆解配置'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-zinc-400">
                      {doc.goalPlanUpdatedAt && (
                        <div className="text-[9px]">更新于 {new Date(doc.goalPlanUpdatedAt).toLocaleTimeString()}</div>
                      )}
                      {showGoalHub ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </div>
                  </button>

                  {!showGoalHub && (goalPlanDraft || doc.goalPlan) && (
                    <div className="mt-3 rounded-lg border border-zinc-200/80 dark:border-zinc-700/70 bg-white/80 dark:bg-zinc-800/80 p-2 text-[10px] text-zinc-500 dark:text-zinc-400 space-y-1">
                      <div>里程碑 {(goalPlanDraft || doc.goalPlan)?.milestones.length || 0} 项 · 任务 {(goalPlanDraft || doc.goalPlan)?.tasks.length || 0} 项</div>
                      <div>今日动作 {(goalPlanDraft || doc.goalPlan)?.nextActions.length || 0} 项</div>
                    </div>
                  )}

                  {showGoalHub && (
                    <div className="mt-3 space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
                      <textarea
                        value={goalInput}
                        onChange={(e) => setGoalInput(e.target.value)}
                        className="w-full min-h-[56px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2.5 py-2 text-xs text-zinc-700 dark:text-zinc-200 outline-none focus:border-purple-400"
                        placeholder="输入你的目标，例如：30天完成产品内测并获得首批20位种子用户"
                      />

                      <input
                        value={goalConstraintsInput}
                        onChange={(e) => setGoalConstraintsInput(e.target.value)}
                        className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-700 dark:text-zinc-200 outline-none focus:border-purple-400"
                        placeholder="约束（可选）：预算、时间、人力、风格"
                      />

                      <input
                        value={goalDeadlineInput}
                        onChange={(e) => setGoalDeadlineInput(e.target.value)}
                        className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-700 dark:text-zinc-200 outline-none focus:border-purple-400"
                        placeholder="截止时间（可选）：2026-03-31"
                      />

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => runGoalPlanner(doc.goalPlan ? 'manual_replan' : 'init')}
                          disabled={isPlanningGoal}
                          className="flex-1 px-2 py-1.5 rounded-lg bg-purple-600 text-white text-[10px] font-bold hover:bg-purple-700 disabled:opacity-60 transition-colors"
                        >
                          {isPlanningGoal ? '拆解中...' : (doc.goalPlan ? '重新规划' : '开始自动拆解')}
                        </button>
                        <button
                          onClick={applyGoalPlanToPage}
                          disabled={!goalPlanDraft && !doc.goalPlan}
                          className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-[10px] font-bold text-zinc-600 dark:text-zinc-300 hover:border-purple-300 disabled:opacity-50 transition-colors"
                        >
                          应用计划
                        </button>
                      </div>

                      {(goalPlanDraft || doc.goalPlan) && (
                        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/80 dark:bg-zinc-800/80 p-2 text-[10px] text-zinc-500 dark:text-zinc-400 space-y-1">
                          <div>里程碑 {(goalPlanDraft || doc.goalPlan)?.milestones.length || 0} 项</div>
                          <div>任务 {(goalPlanDraft || doc.goalPlan)?.tasks.length || 0} 项</div>
                          <div>今日动作 {(goalPlanDraft || doc.goalPlan)?.nextActions.length || 0} 项</div>
                          {latestGoalExecutionLog && (
                            <div className="pt-1 border-t border-zinc-200/80 dark:border-zinc-700/80">
                              最近执行：{formatExecutionTrigger(latestGoalExecutionLog.trigger)} · {new Date(latestGoalExecutionLog.at).toLocaleTimeString()}
                            </div>
                          )}
                        </div>
                      )}

                      {goalPlanError && (
                        <div className="text-[10px] text-red-500">{goalPlanError}</div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* AI 模式切换：针对页面改动方式 */}
              <div className="px-3 mb-4">
                <div className="grid grid-cols-2 gap-1 p-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
                  <button 
                    onClick={() => setAiMode('replace')}
                    className={`flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold rounded-md transition-all ${aiMode === 'replace' ? 'bg-white dark:bg-zinc-700 text-purple-600 dark:text-purple-400 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'}`}
                  >
                    <LayoutTemplate className="w-3 h-3" />
                    全量替换
                  </button>
                  <button 
                    onClick={() => setAiMode('append')}
                    className={`flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold rounded-md transition-all ${aiMode === 'append' ? 'bg-white dark:bg-zinc-700 text-purple-600 dark:text-purple-400 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'}`}
                  >
                    <Plus className="w-3 h-3" />
                    追加到末尾
                  </button>
                  <button
                    onClick={() => setAiMode('prepend')}
                    className={`flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold rounded-md transition-all ${aiMode === 'prepend' ? 'bg-white dark:bg-zinc-700 text-purple-600 dark:text-purple-400 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'}`}
                  >
                    <ChevronUp className="w-3 h-3" />
                    插入到开头
                  </button>
                  <button
                    onClick={() => setAiMode('update_block')}
                    className={`flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold rounded-md transition-all ${aiMode === 'update_block' ? 'bg-white dark:bg-zinc-700 text-purple-600 dark:text-purple-400 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'}`}
                  >
                    <Wand2 className="w-3 h-3" />
                    生成更新块
                  </button>
                </div>
                <div className="mt-1.5 px-1 text-[9px] text-zinc-400 italic">
                  {getAiModeHint(aiMode)}
                </div>
              </div>

              {isDualColumn && (
                <div className="px-3 mb-4">
                  <div className="flex p-0.5 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
                    <button
                      onClick={() => setAiTarget('original')}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold rounded-md transition-all ${safeActiveTarget === 'original' ? 'bg-white dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'}`}
                    >
                      <AlignLeft className="w-3 h-3" />
                      优化原文
                    </button>
                    <button
                      onClick={() => setAiTarget('translated')}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold rounded-md transition-all ${safeActiveTarget === 'translated' ? 'bg-white dark:bg-zinc-700 text-purple-600 dark:text-purple-400 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'}`}
                    >
                      <Languages className="w-3 h-3" />
                      优化译文
                    </button>
                  </div>
                  <div className="mt-1.5 px-1 text-[9px] text-zinc-400 italic">
                    {selectedActions.includes('translate')
                      ? '🌐 选择了“翻译页面”时，将始终基于原文生成译文。'
                      : `🎯 当前处理目标：${safeActiveTarget === 'translated' ? '右侧译文' : '左侧原文'}`}
                  </div>
                </div>
              )}

              {/* 引用页面选择器 */}
              <div className="px-3 mb-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
                    <FileSearch className="w-3 h-3" />
                    引用参考页面 ({referencedPageIds.length})
                  </div>
                  <button 
                    onClick={() => setShowPageSelector(!showPageSelector)}
                    className="text-[10px] text-purple-600 hover:text-purple-700 font-bold"
                  >
                    {showPageSelector ? '收起' : '添加引用'}
                  </button>
                </div>
                
                {showPageSelector && (
                  <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg p-2 mb-2 max-h-48 overflow-y-auto custom-scrollbar animate-in fade-in slide-in-from-top-1">
                    <div className="space-y-1">
                      {documents.filter(d => d.id !== doc.id && !d.isDeleted).map(d => (
                        <button
                          key={d.id}
                          onClick={() => {
                            setReferencedPageIds(prev => 
                              prev.includes(d.id) ? prev.filter(id => id !== d.id) : [...prev, d.id]
                            );
                          }}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded transition-colors ${referencedPageIds.includes(d.id) ? 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
                        >
                          <div className={`w-3 h-3 border rounded-sm flex items-center justify-center ${referencedPageIds.includes(d.id) ? 'bg-purple-600 border-purple-600 text-white' : 'border-zinc-300 dark:border-zinc-600'}`}>
                            {referencedPageIds.includes(d.id) && <Check className="w-2 h-2" />}
                          </div>
                          <span className="truncate">{d.title || '无标题'}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {referencedPageIds.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {referencedPageIds.map(id => {
                      const refDoc = documents.find(d => d.id === id);
                      return (
                        <div key={id} className="flex items-center gap-1 px-2 py-0.5 bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 rounded-full text-[10px] group">
                          <span className="max-w-[80px] truncate">{refDoc?.title || '已删除页面'}</span>
                          <button onClick={() => setReferencedPageIds(prev => prev.filter(pid => pid !== id))} className="hover:text-red-500">
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="px-3 mb-3">
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white/80 dark:bg-zinc-800/60 p-3 space-y-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">页面动作</div>
                      <div className="mt-1 text-[10px] text-zinc-400">{activeActionPanelHint}</div>
                    </div>
                    {selectedActions.length > 0 && (
                      <button
                        onClick={clearSelectedActions}
                        className="text-[10px] font-bold text-purple-600 hover:text-purple-700"
                      >
                        清空
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-3 p-0.5 bg-zinc-100 dark:bg-zinc-800 rounded-lg gap-0.5">
                    {actionPanelTabs.map(tab => (
                      <button
                        key={tab.key}
                        onClick={() => setActiveActionPanel(tab.key)}
                        className={`py-1.5 text-[10px] font-bold rounded-md transition-all ${
                          activeActionPanel === tab.key
                            ? 'bg-white dark:bg-zinc-700 text-purple-600 dark:text-purple-300 shadow-sm'
                            : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  {selectedActions.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {selectedActions.map(actionKey => (
                        <button
                          key={actionKey}
                          onClick={() => toggleAction(actionKey)}
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800/60"
                        >
                          <span>{actionLabelMap[actionKey] || actionKey}</span>
                          <X className="w-2.5 h-2.5" />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[10px] text-zinc-400">未选择动作，可勾选多个后一次执行。</div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {activeActionItems.map((action) => {
                      const isActive = selectedActions.includes(action.key);
                      const ActionIcon = action.icon;
                      return (
                        <button
                          key={action.key}
                          onClick={() => toggleAction(action.key)}
                          className={`min-h-[30px] px-2.5 rounded-lg text-[11px] font-medium border transition-all inline-flex items-center gap-1.5 ${
                            isActive
                              ? 'bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-900/40 dark:text-purple-200 dark:border-purple-700/60'
                              : 'bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-purple-300 dark:hover:border-purple-700'
                          }`}
                        >
                          <ActionIcon className="w-3.5 h-3.5 shrink-0" />
                          <span>{action.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>            </>
          ) : (
            <div className="flex-1 flex flex-col gap-4 min-h-0">
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/80 dark:bg-zinc-800/70 px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">对话模式</div>
                    <div className="mt-0.5 text-[10px] text-zinc-400">
                      {isChatTaskMode ? '任务模式：允许执行创建页面与内容落地' : '讨论模式：只聊天分析，不自动执行任务'}
                    </div>
                  </div>
                  <button
                    onClick={() => setIsChatTaskMode(prev => !prev)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-bold transition-colors ${
                      isChatTaskMode
                        ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                        : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 hover:text-purple-600 dark:hover:text-purple-300'
                    }`}
                    title={isChatTaskMode ? '关闭任务模式' : '开启任务模式'}
                  >
                    <Zap className="w-3 h-3" />
                    {isChatTaskMode ? '任务模式: 开' : '任务模式: 关'}
                  </button>
                </div>
              </div>

              {messages.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500">
                  <div className="preloader-container scale-50 opacity-50 mb-2">
                    <div className="preloader">
                      <div className="crack crack1 crack-animate"></div>
                      <div className="crack crack2 crack-animate"></div>
                      <div className="crack crack3 crack-animate"></div>
                      <div className="crack crack4 crack-animate"></div>
                      <div className="crack crack5 crack-animate"></div>
                    </div>
                  </div>
                  <p className="text-sm">开始一段新对话...</p>
                </div>
              ) : (
                <div ref={chatContainerRef} className="flex-1 space-y-6 pb-4 overflow-y-auto custom-scrollbar">
                  {messages.map((msg, i) => (
                    <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                      {msg.role === 'assistant' && (
                        <div className="flex items-center gap-1.5 mb-1 ml-1">
                          <div className="w-5 h-5 bg-purple-100 dark:bg-purple-900/30 rounded-full flex items-center justify-center">
                            <Sparkles className="w-3 h-3 text-purple-600 dark:text-purple-400" />
                          </div>
                          <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-tight">AI 助手</span>
                        </div>
                      )}
                      <div className={`px-4 py-3 rounded-2xl text-sm max-w-[95%] shadow-sm transition-all relative group/msg ${
                        msg.role === 'user' 
                          ? 'bg-purple-600 text-white rounded-br-none' 
                          : 'bg-white dark:bg-zinc-800 border border-zinc-100 dark:border-zinc-800 text-zinc-700 dark:text-zinc-200 rounded-bl-none prose prose-sm dark:prose-invert prose-p:leading-relaxed prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-800'
                      }`}>
                        {msg.role === 'user' ? (
                          <div className="whitespace-pre-wrap">{msg.content}</div>
                        ) : (
                          msg.content ? (
                            <>
                              <ReactMarkdown>{msg.content}</ReactMarkdown>
                              {!isProcessing && isChatTaskMode && (
                                <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-700 flex items-center gap-2 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                                  <button 
                                    onClick={() => applyChatResultToPage(msg.content)}
                                    className="flex items-center gap-1 px-2 py-1 bg-zinc-50 dark:bg-zinc-900 hover:bg-purple-50 dark:hover:bg-purple-900/20 text-zinc-500 hover:text-purple-600 text-[10px] font-bold rounded transition-colors"
                                    title="追加到当前页面"
                                  >
                                    <Plus className="w-3 h-3" /> 追加到页面
                                  </button>
                                  <button 
                                    onClick={() => handleCreateNewPageFromResult(msg.content)}
                                    className="flex items-center gap-1 px-2 py-1 bg-zinc-50 dark:bg-zinc-900 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-zinc-500 hover:text-blue-600 text-[10px] font-bold rounded transition-colors"
                                    title="以此内容创建新页面"
                                  >
                                    <LayoutTemplate className="w-3 h-3" /> 存为新页面
                                  </button>
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="flex items-center gap-3 py-1">
                              <div className="relative flex items-center justify-center">
                                <div className="absolute inset-0 bg-purple-500 rounded-full blur-md opacity-20 animate-pulse"></div>
                                <Sparkles className="w-4 h-4 text-purple-600 dark:text-purple-400 animate-pulse relative z-10" />
                              </div>
                              <div className="flex gap-1">
                                <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                                <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                                <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce"></span>
                              </div>
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Input */}
        <div className="p-3 border-t border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 mt-auto">
          <div className={`relative border rounded-xl shadow-sm bg-white dark:bg-zinc-800 transition-all ${customPrompt || selectedActions.length > 0 ? 'border-purple-400 ring-2 ring-purple-100 dark:ring-purple-900/30' : 'border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600'}`}>
            <textarea 
              placeholder={mode === 'chat' ? "输入消息..." : "使用 AI 处理各种任务..."} 
              className="w-full px-3 py-2 text-sm bg-transparent border-none outline-none resize-none min-h-[40px] max-h-[120px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
              rows={1}
              value={customPrompt}
              onChange={(e) => {
                setCustomPrompt(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (customPrompt.trim() || selectedActions.length > 0) {
                    handleRunAi();
                  }
                }
              }}
            />

            {selectionContext && (
              <div className="mx-3 mb-2 p-2 bg-purple-50 dark:bg-purple-900/10 border border-purple-100 dark:border-purple-800 rounded-lg animate-in slide-in-from-bottom-2">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-purple-600 dark:text-purple-400 uppercase leading-none">
                    <MessageSquare className="w-3 h-3" />
                    引用选中内容
                  </div>
                  <button onClick={() => setSelectionContext(null)} className="text-zinc-400 hover:text-red-500">
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <p className="text-[10px] text-zinc-500 dark:text-zinc-400 italic truncate px-1">“{selectionContext}”</p>
              </div>
            )}

            {attachedFiles.length > 0 && (
              <div className="mx-3 mb-2 bg-purple-50 dark:bg-purple-900/10 border border-purple-100 dark:border-purple-800 rounded-lg p-2 max-h-48 overflow-y-auto custom-scrollbar">
                <div className="flex items-center justify-between mb-2 pb-1 border-b border-purple-100 dark:border-purple-800">
                  <span className="text-[10px] font-bold text-purple-600 dark:text-purple-400 uppercase">已加载资源</span>
                  <button onClick={() => setAttachedFiles([])} className="text-[10px] text-zinc-400 hover:text-red-500">清空全部</button>
                </div>
                <div className="space-y-1">
                  {attachedFiles.map((item, idx) => (
                    <div key={item.id || idx} className="flex items-center justify-between gap-2 group">
                      <div className="flex items-center gap-1.5 overflow-hidden">
                        {item.type === 'folder' ? (
                          <Folder className="w-3 h-3 text-purple-500 shrink-0" />
                        ) : (
                          <Paperclip className="w-3 h-3 text-purple-400 shrink-0" />
                        )}
                        <div className="flex flex-col min-w-0">
                          <span className="text-[10px] text-zinc-600 dark:text-zinc-400 truncate font-medium">{item.name}</span>
                          {item.type === 'folder' && (
                            <span className="text-[8px] text-zinc-400">包含 {item.files?.length} 个文件</span>
                          )}
                        </div>
                      </div>
                      <button 
                        onClick={() => setAttachedFiles(prev => prev.filter((_, i) => i !== idx))}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-400 hover:text-red-500 transition-all"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {attachedLinks.length > 0 && (
              <div className="mx-3 mb-2 bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-800 rounded-lg p-2 max-h-32 overflow-y-auto custom-scrollbar">
                <div className="flex items-center justify-between mb-2 pb-1 border-b border-blue-100 dark:border-blue-800">
                  <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase">已加载 {attachedLinks.length} 个网页链接</span>
                  <button onClick={() => setAttachedLinks([])} className="text-[10px] text-zinc-400 hover:text-red-500">清空全部</button>
                </div>
                <div className="space-y-1">
                  {attachedLinks.map((link, idx) => (
                    <div key={idx} className="flex items-center justify-between gap-2 group">
                      <div className="flex items-center gap-1.5 overflow-hidden">
                        {link.status === 'loading' ? (
                          <Loader2 className="w-3 h-3 text-blue-500 animate-spin shrink-0" />
                        ) : link.status === 'error' ? (
                          <X className="w-3 h-3 text-red-500 shrink-0" />
                        ) : (
                          <Globe className="w-3 h-3 text-blue-400 shrink-0" />
                        )}
                        <span className="text-[10px] text-zinc-600 dark:text-zinc-400 truncate">
                          {link.status === 'loading' ? '正在抓取内容...' : link.title || link.url}
                        </span>
                      </div>
                      <button 
                        onClick={() => setAttachedLinks(prev => prev.filter((_, i) => i !== idx))}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-400 hover:text-red-500 transition-all"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {showLinkInput && (
              <div className="mx-3 mb-2 p-2 bg-white dark:bg-zinc-800 border border-blue-200 dark:border-blue-900/50 rounded-lg animate-in slide-in-from-bottom-2">
                <div className="flex items-center gap-2">
                  <input 
                    type="url"
                    placeholder="粘贴网页链接 (https://...)"
                    className="flex-1 bg-transparent border-none outline-none text-[11px] text-zinc-600 dark:text-zinc-300 placeholder:text-zinc-400"
                    value={newLinkUrl}
                    onChange={(e) => setNewLinkUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddLink(newLinkUrl);
                      }
                      if (e.key === 'Escape') setShowLinkInput(false);
                    }}
                    autoFocus
                  />
                  <button 
                    onClick={() => handleAddLink(newLinkUrl)}
                    className="p-1 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                  >
                    <Check className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )}

            {showApiSettings && (
              <div className="mx-3 mb-2 p-3 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg animate-in slide-in-from-bottom-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-bold text-zinc-500 uppercase">Tavily API 配置</span>
                  <button onClick={() => setShowApiSettings(false)} className="text-zinc-400 hover:text-zinc-600"><X className="w-3 h-3" /></button>
                </div>
                <div className="flex items-center gap-2">
                  <input 
                    type="password"
                    placeholder="粘贴你的 API Key"
                    className="flex-1 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 text-xs"
                    value={tavilyApiKey}
                    onChange={(e) => setTavilyApiKey(e.target.value)}
                  />
                  <button 
                    onClick={() => {
                      if(tavilyApiKey) {
                        setShowApiSettings(false);
                        setIsSearchEnabled(true);
                      }
                    }}
                    className="p-1 bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
                  >
                    <Check className="w-3 h-3" />
                  </button>
                </div>
                <p className="mt-2 text-[9px] text-zinc-400">联网搜索由 Tavily 提供支持，可获取最新资讯。</p>
              </div>
            )}

            {/* Page/Knowledge Base Selector Menu (Expanding Upwards) */}
            {showChatDocSelector && (
              <div className="absolute bottom-[100%] left-4 mb-2 w-72 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl rounded-2xl overflow-hidden animate-in slide-in-from-bottom-2 duration-200 z-[60]">
                <div className="p-3 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/50 flex items-center justify-between">
                  <div className="flex p-1 bg-zinc-200/50 dark:bg-zinc-700/50 rounded-xl">
                    <button 
                      onClick={() => setChatDocFilter('kb')}
                      className={`px-3 py-1 text-xs font-bold rounded-lg transition-all ${chatDocFilter === 'kb' ? 'bg-white dark:bg-zinc-600 text-purple-600 dark:text-purple-400 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
                    >
                      知识库
                    </button>
                    <button 
                      onClick={() => setChatDocFilter('all')}
                      className={`px-3 py-1 text-xs font-bold rounded-lg transition-all ${chatDocFilter === 'all' ? 'bg-white dark:bg-zinc-600 text-purple-600 dark:text-purple-400 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
                    >
                      全部
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    {referencedPageIds.length > 0 && (
                      <span className="text-[10px] bg-purple-100 dark:bg-purple-900/40 text-purple-600 px-1.5 py-0.5 rounded-full font-bold">
                        已选 {referencedPageIds.length}
                      </span>
                    )}
                    <button onClick={() => setShowChatDocSelector(false)} className="p-1 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-lg transition-colors">
                      <X className="w-3.5 h-3.5 text-zinc-400" />
                    </button>
                  </div>
                </div>
                <div className="max-h-60 overflow-y-auto custom-scrollbar p-1">
                  {documents
                    .filter(d => !d.isDeleted && d.id !== doc.id && (chatDocFilter === 'all' || d.isInKnowledgeBase))
                    .map(d => (
                      <button
                        key={d.id}
                        onClick={() => {
                          setReferencedPageIds(prev => 
                            prev.includes(d.id) ? prev.filter(id => id !== d.id) : [...prev, d.id]
                          );
                        }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-lg transition-all mb-0.5 group ${referencedPageIds.includes(d.id) ? 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 font-medium' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
                      >
                        <div className={`w-4 h-4 border rounded flex items-center justify-center shrink-0 transition-colors ${referencedPageIds.includes(d.id) ? 'bg-purple-600 border-purple-600 text-white' : 'border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800'}`}>
                          {referencedPageIds.includes(d.id) && <Check className="w-2.5 h-2.5" />}
                        </div>
                        <span className="truncate flex-1 text-left">{d.title || '无标题'}</span>
                        {d.isInKnowledgeBase && (
                          <Zap className="w-3 h-3 text-purple-400 fill-current opacity-50" />
                        )}
                      </button>
                    ))}
                  {documents.filter(d => !d.isDeleted && d.id !== doc.id && (chatDocFilter === 'all' || d.isInKnowledgeBase)).length === 0 && (
                    <div className="py-8 text-center text-zinc-400">
                      <div className="text-[10px] uppercase font-bold tracking-widest mb-1">未找到页面</div>
                      <div className="text-[9px]">
                        {chatDocFilter === 'kb' ? '请先在侧边栏将页面加入知识库' : '暂无其他可选页面'}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between px-2 pb-2">
              <div className="flex items-center gap-1">
                <input 
                  type="file" 
                  ref={chatFileInputRef} 
                  className="hidden" 
                  onChange={handleChatFileUpload}
                  multiple
                  accept=".txt,.md,.markdown,.html,.htm,.docx,.doc,.pdf,.csv,.js,.ts,.tsx,.jsx,.json,.css,.py,.java,.c,.cpp,.go,.rs,.rb,.php,.sql,.yaml,.yml,.toml"
                />
                <button 
                  onClick={() => setShowChatDocSelector(!showChatDocSelector)}
                  className={`p-1.5 rounded-lg transition-all ${showChatDocSelector ? 'bg-purple-50 text-purple-600 dark:bg-purple-900/20' : 'text-zinc-400 hover:text-purple-500 hover:bg-zinc-100 dark:hover:bg-zinc-700'}`}
                  title="引用页面或知识库"
                >
                  <Library className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => chatFileInputRef.current?.click()}
                  className="p-1.5 text-zinc-400 hover:text-purple-500 dark:hover:text-purple-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 rounded-lg transition-all"
                  title="上传文件夹或多个文件"
                >
                  <FolderSync className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => setShowLinkInput(!showLinkInput)}
                  className={`p-1.5 rounded-lg transition-all ${showLinkInput ? 'bg-blue-50 text-blue-500' : 'text-zinc-400 hover:text-blue-500 hover:bg-zinc-100 dark:hover:bg-zinc-700'}`}
                  title="添加网页链接"
                >
                  <LinkIcon className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => setIsSearchEnabled(!isSearchEnabled)}
                  className={`p-1.5 rounded-lg transition-all ${isSearchEnabled ? 'bg-green-50 text-green-600 dark:bg-green-900/20' : 'text-zinc-400 hover:text-green-500 hover:bg-zinc-100 dark:hover:bg-zinc-700'}`}
                  title={isSearchEnabled ? "已开启联网搜索" : "开启联网搜索 (Tavily)"}
                >
                  <Globe className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => setShowApiSettings(!showApiSettings)}
                  className={`p-1.5 rounded-lg transition-all ${tavilyApiKey ? 'text-zinc-400 hover:text-zinc-600' : 'text-orange-400 animate-pulse'}`}
                  title="配置搜索 API Key"
                >
                  <SettingsIcon className="w-4 h-4" />
                </button>
                {mode === 'chat' && (
                  <button 
                    onClick={handleNewChat} 
                    className="p-1.5 text-zinc-400 hover:text-purple-600 dark:hover:text-purple-400 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                    title="新开对话"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                )}
                <div className="text-xs text-zinc-400 ml-1">
                  {(selectedActions.length > 0 || attachedLinks.length > 0 || referencedPageIds.length > 0) && (
                    <span className="flex items-center gap-1 bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 px-2 py-0.5 rounded-full">
                      {selectedActions.length + attachedLinks.length + referencedPageIds.length} 个资源
                    </span>
                  )}
                </div>
              </div>
              <button 
                onClick={handleRunAi}
                disabled={selectedActions.length === 0 && !customPrompt.trim() && attachedFiles.length === 0 && attachedLinks.length === 0}
                className={`p-1.5 rounded-lg transition-colors ${selectedActions.length > 0 || customPrompt.trim() || attachedFiles.length > 0 || attachedLinks.length > 0 ? 'bg-purple-600 text-white hover:bg-purple-700' : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-300 dark:text-zinc-500 cursor-not-allowed'}`}
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </aside>

      {/* Floating Button (when sidebar is closed) */}
      <button 
        onClick={() => setIsAiMenuOpen(true)}
        className={`absolute bottom-8 right-8 w-14 h-14 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-purple-600 dark:text-purple-400 shadow-xl rounded-full hover:bg-purple-50 dark:hover:bg-purple-900/20 hover:shadow-2xl transition-all z-10 flex items-center justify-center group ${isAiMenuOpen && !isProcessing ? 'opacity-0 pointer-events-none scale-90' : 'opacity-100 scale-100 hover:-translate-y-1'}`}
        title={isProcessing ? "AI 正在工作中..." : "AI 助手"}
      >
        <div className="preloader-container relative">
          <div className="preloader">
            <div className="crack crack1 crack-animate"></div>
            <div className="crack crack2 crack-animate"></div>
            <div className="crack crack3 crack-animate"></div>
            <div className="crack crack4 crack-animate"></div>
            <div className="crack crack5 crack-animate"></div>
          </div>
          {isProcessing && (
            <div className="absolute inset-0 bg-purple-500 rounded-full blur-md opacity-10 animate-pulse"></div>
          )}
        </div>
      </button>
    </div>
  );
}
