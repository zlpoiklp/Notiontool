import { Plus, FileText, Trash2, Upload, Search, Settings as SettingsIcon, ChevronRight, X, Loader2, Sun, Moon, Home, Calendar, Inbox, Library, Sparkles, ChevronLeft, MoreHorizontal, User, PanelLeftClose, SquarePen, Pin, RefreshCw, Zap, FolderSync } from 'lucide-react';
import { Document, Settings, MigrationSummary } from '../App';
import { useRef, useState, useEffect } from 'react';
import { SUPPORTED_IMPORT_ACCEPT } from '../utils/fileImport';

type SidebarProps = {
  documents: Document[];
  activeDocId: string | null;
  onSelectDoc: (id: string) => void;
  onCreateDoc: (parentId?: string | null, initialData?: { title?: string, content?: string }) => void;
  onDeleteDoc: (id: string) => void;
  onRestoreDoc: (id: string) => void;
  onPermanentDeleteDoc: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onToggleKnowledgeBase: (id: string) => void;
  onImportFile: (file: File) => void | Promise<void>;
  settings: Settings;
  onUpdateSettings: (settings: Settings) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onCloseSidebar: () => void;
  isPeek?: boolean;
  onPin?: () => void;
  isAiWorkspaceActive?: boolean;
  onOpenAiWorkspace?: () => void;
  migration: {
    status: 'checking' | 'needed' | 'conflict' | 'ready' | 'done' | 'error';
    local: MigrationSummary;
    server: MigrationSummary;
    error?: string;
  };
  onCheckMigration: () => void;
  onResolveMigration: (strategy: 'local' | 'server') => void;
};

const API_PROVIDERS = [
  { id: 'gemini', name: '内置 Gemini (默认)', url: '' },
  { id: 'siliconflow', name: '硅基流动 (SiliconFlow)', url: 'https://api.siliconflow.cn/v1' },
  { id: 'qwen', name: '通义千问 (Qwen)', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'moonshot', name: 'Kimi (Moonshot)', url: 'https://api.moonshot.cn/v1' },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
  { id: 'zhipu', name: '智谱清言 (Zhipu)', url: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'xiaomi', name: '小米 (MiLM)', url: 'https://api.xiaoai.mi.com/v1' },
  { id: 'custom', name: '自定义 API', url: '' }
];

type CustomTemplate = {
  id: string;
  title: string;
  description: string;
  content: string;
  createdAt: string;
};

const CUSTOM_TEMPLATES_KEY = 'notion-clone-custom-templates';

export default function Sidebar({ 
  documents, 
  activeDocId, 
  onSelectDoc, 
  onCreateDoc, 
  onDeleteDoc, 
  onImportFile, 
  settings, 
  onUpdateSettings, 
  theme, 
  onToggleTheme, 
  onCloseSidebar,
  onRestoreDoc,
  onPermanentDeleteDoc,
  onToggleFavorite,
  onToggleKnowledgeBase,
  isPeek = false,
  onPin,
  isAiWorkspaceActive = false,
  onOpenAiWorkspace,
  migration,
  onCheckMigration,
  onResolveMigration
}: SidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'notion' | 'api'>('api');
  const [availableModels, setAvailableModels] = useState<{id: string, name: string}[]>([]);
  const [isDetecting, setIsDetecting] = useState(false);
  const [showMigrationDialog, setShowMigrationDialog] = useState(false);
  const [migrationChoice, setMigrationChoice] = useState<'local' | 'server'>('local');
  const localSummaryText = `本地：文档 ${migration.local.documents} · 技能 ${migration.local.skills} · 设置 ${migration.local.settings ? '有' : '无'} · 快照 ${migration.local.snapshots} · 备份 ${migration.local.backups}`;
  const serverSummaryText = `服务器：文档 ${migration.server.documents} · 技能 ${migration.server.skills} · 设置 ${migration.server.settings ? '有' : '无'} · 快照 ${migration.server.snapshots} · 备份 ${migration.server.backups}`;

  useEffect(() => {
    if (settings.apiProvider !== 'gemini' && settings.apiKey && settings.apiUrl) {
      // Try to fetch models if we have key and url
      fetchModels();
    }
  }, [settings.apiProvider, settings.apiUrl]);

  useEffect(() => {
    if (isSettingsOpen) {
      onCheckMigration();
    }
  }, [isSettingsOpen]);

  const fetchModels = async () => {
    if (!settings.apiUrl || !settings.apiKey) return;
    setIsDetecting(true);
    try {
      const response = await fetch(`${settings.apiUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${settings.apiKey}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        if (data.data && Array.isArray(data.data)) {
          setAvailableModels(data.data.map((m: any) => ({ id: m.id, name: m.id })));
        }
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
    } finally {
      setIsDetecting(false);
    }
  };

  const handleProviderChange = (providerId: string) => {
    const provider = API_PROVIDERS.find(p => p.id === providerId);
    onUpdateSettings({
      ...settings,
      apiProvider: providerId,
      apiUrl: provider?.url || '',
      selectedModel: ''
    });
    setAvailableModels([]);
  };

  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showHome, setShowHome] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showKB, setShowKB] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [customTemplates, setCustomTemplates] = useState<CustomTemplate[]>(() => {
    const raw = localStorage.getItem(CUSTOM_TEMPLATES_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item: any) => typeof item?.content === 'string' && typeof item?.title === 'string');
    } catch {
      return [];
    }
  });

  const closeAllPanels = () => {
    setShowSearch(false);
    setShowHome(false);
    setShowLibrary(false);
    setShowKB(false);
    setShowTrash(false);
  };

  useEffect(() => {
    const handleOpenSearch = () => {
      closeAllPanels();
      setShowSearch(true);
    };
    const handleOpenHome = () => {
      closeAllPanels();
      setShowHome(true);
    };
    const handleOpenLibrary = () => {
      closeAllPanels();
      setShowLibrary(true);
    };
    const handleOpenKnowledgeBase = () => {
      closeAllPanels();
      setShowKB(true);
    };
    const handleOpenTrash = () => {
      closeAllPanels();
      setShowTrash(true);
    };
    const handleOpenSettings = () => {
      setIsSettingsOpen(true);
    };

    window.addEventListener('open-global-search', handleOpenSearch);
    window.addEventListener('sidebar-open-search', handleOpenSearch);
    window.addEventListener('sidebar-open-home', handleOpenHome);
    window.addEventListener('sidebar-open-library', handleOpenLibrary);
    window.addEventListener('sidebar-open-kb', handleOpenKnowledgeBase);
    window.addEventListener('sidebar-open-trash', handleOpenTrash);
    window.addEventListener('sidebar-open-settings', handleOpenSettings);

    return () => {
      window.removeEventListener('open-global-search', handleOpenSearch);
      window.removeEventListener('sidebar-open-search', handleOpenSearch);
      window.removeEventListener('sidebar-open-home', handleOpenHome);
      window.removeEventListener('sidebar-open-library', handleOpenLibrary);
      window.removeEventListener('sidebar-open-kb', handleOpenKnowledgeBase);
      window.removeEventListener('sidebar-open-trash', handleOpenTrash);
      window.removeEventListener('sidebar-open-settings', handleOpenSettings);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(CUSTOM_TEMPLATES_KEY, JSON.stringify(customTemplates));
  }, [customTemplates]);

  const filteredDocs = documents.filter(doc => 
    !doc.isDeleted && (
      doc.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
      doc.content.toLowerCase().includes(searchQuery.toLowerCase())
    )
  );

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const activeDoc = documents.find((doc) => doc.id === activeDocId && !doc.isDeleted) || null;

  const ALL_TEMPLATES = [
    { title: '📅 会议纪要', description: '记录会议时间、参与者及关键决策', content: '<h1>会议纪要</h1><p><strong>日期:</strong> ' + new Date().toLocaleDateString() + '</p><p><strong>参与者:</strong> </p><h2>议程</h2><ul><li></li></ul><h2>关键决策</h2><p>✅ </p><h2>待办事项</h2><ul><li>[ ] </li></ul>' },
    { title: '📝 周报模板', description: '结构化展示本周工作与下周计划', content: '<h1>本周工作总结</h1><h2>✨ 本周成就</h2><ul><li></li></ul><h2>🚧 遇到问题</h2><ul><li></li></ul><h2>🗓️ 下周计划</h2><ul><li></li></ul>' },
    { title: '🚀 项目启动书', description: '定义项目目标、范围及里程碑', content: '<h1>项目启动书</h1><h2>🎯 项目目标</h2><p></p><h2>👥 团队成员</h2><ul><li>项目负责人: </li></ul><h2>📍 里程碑</h2><ul><li>Q1: </li></ul>' },
    { title: '💡 创意脑暴', description: '捕捉瞬间灵感与发散性思维', content: '<h1>创意脑暴</h1><h2>🌟 核心概念</h2><p></p><h2>🌈 灵感碎片</h2><ul><li></li></ul><h2>🔍 下一步验证</h2><p></p>' },
    { title: '📚 读书笔记', description: '沉淀书中的精华内容与个人思考', content: '<h1>读书笔记</h1><p><strong>书名:</strong> </p><p><strong>评分:</strong> ⭐⭐⭐⭐⭐</p><h2>📌 核心观点</h2><p></p><h2>💭 个人感悟</h2><p></p>' },
    { title: '🏃 训练计划', description: '规划每日运动量与健康目标', content: '<h1>训练计划</h1><h2>💪 今日目标</h2><p></p><h2>🏋️ 训练内容</h2><ul><li></li></ul><h2>🥗 饮食记录</h2><p></p>' },
    { title: '✈️ 旅行规划', description: '整理目的地、行程及必备清单', content: '<h1>旅行规划</h1><h2>🌍 目的地</h2><p></p><h2>🗓️ 行程安排</h2><p>Day 1: </p><h2>🎒 必备清单</h2><ul><li>[ ] 护照/证件</li></ul>' },
    { title: '🎨 设计规范', description: '统一项目色调、字体与组件风格', content: '<h1>设计规范</h1><h2>🎨 调色板</h2><p>Primary: #</p><h2>Typography</h2><p>Font: </p><h2>🧱 组件说明</h2><p></p>' }
  ];

  const [displayTemplates, setDisplayTemplates] = useState(ALL_TEMPLATES.slice(0, 3));

  const refreshTemplates = () => {
    const shuffled = [...ALL_TEMPLATES].sort(() => 0.5 - Math.random());
    setDisplayTemplates(shuffled.slice(0, 3));
  };

  const handleSaveCurrentAsTemplate = () => {
    if (!activeDoc) {
      alert('请先选择一个页面再保存模板。');
      return;
    }

    const plainText = activeDoc.content.replace(/<[^>]*>/g, '').trim();
    if (!plainText) {
      alert('当前页面内容为空，无法保存为模板。');
      return;
    }

    const title = window.prompt('模板名称', activeDoc.title || '我的模板');
    if (!title || !title.trim()) return;

    const template: CustomTemplate = {
      id: crypto.randomUUID(),
      title: title.trim(),
      description: plainText.slice(0, 40) || '自定义模板',
      content: activeDoc.content,
      createdAt: new Date().toISOString(),
    };

    setCustomTemplates(prev => [template, ...prev].slice(0, 30));
  };

  const handleDeleteCustomTemplate = (templateId: string) => {
    setCustomTemplates(prev => prev.filter(template => template.id !== templateId));
  };

  const toggleExpand = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newExpanded = new Set(expandedIds);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedIds(newExpanded);
  };

  const favoriteDocs = documents.filter(doc => doc.isFavorite && !doc.isDeleted);
  const trashDocs = documents.filter(doc => doc.isDeleted);
  const recentDocs = [...documents]
    .filter(doc => !doc.isDeleted)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5);

  const [suggestedDocs, setSuggestedDocs] = useState<Document[]>([]);

  useEffect(() => {
    if (!activeDocId) {
      setSuggestedDocs([]);
      return;
    }

    const activeDoc = documents.find(d => d.id === activeDocId);
    if (!activeDoc) return;

    // Simple keyword-based suggestion logic
    const titleKeywords = (activeDoc.title || '').toLowerCase().split(/\s+/).filter(k => k.length > 1);
    
    const suggestions = documents
      .filter(doc => doc.id !== activeDocId && !doc.isDeleted)
      .filter(doc => {
        const docTitle = (doc.title || '').toLowerCase();
        return titleKeywords.some(k => docTitle.includes(k));
      })
      .slice(0, 3);

    setSuggestedDocs(suggestions);
  }, [activeDocId, documents]);

  const renderTree = (parentId: string | null = null, level = 0) => {
    return documents
      .filter(doc => doc.parentId === parentId && !doc.isDeleted)
      .map(doc => {
        const hasChildren = documents.some(d => d.parentId === doc.id && !d.isDeleted);
        const isExpanded = expandedIds.has(doc.id);

        return (
          <div key={doc.id} className="flex flex-col">
            <div 
              onClick={() => onSelectDoc(doc.id)}
              className={`group flex items-center justify-between px-2 py-1 rounded cursor-pointer text-sm transition-colors ${activeDocId === doc.id ? 'bg-zinc-200/70 dark:bg-zinc-800 font-medium text-zinc-900 dark:text-zinc-100' : 'hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 text-zinc-700 dark:text-zinc-400'}`}
              style={{ paddingLeft: `${level * 12 + 8}px` }}
            >
              <div className="flex items-center gap-1.5 truncate flex-1">
                <button 
                  onClick={(e) => toggleExpand(doc.id, e)}
                  className={`p-0.5 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700 transition-transform ${isExpanded ? 'rotate-90' : ''} ${!hasChildren ? 'invisible' : ''}`}
                >
                  <ChevronRight className="w-3 h-3 text-zinc-400" />
                </button>
                {doc.icon ? (
                  <span className="w-4 h-4 flex items-center justify-center text-sm shrink-0 leading-none">{doc.icon}</span>
                ) : (
                  <FileText className="w-4 h-4 text-zinc-400 shrink-0" />
                )}
                <span className="truncate">{doc.title || '无标题'}</span>
              </div>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button 
                  onClick={(e) => { e.stopPropagation(); onCreateDoc(doc.id); if (!isExpanded) toggleExpand(doc.id, e); }}
                  className="p-1 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded text-zinc-500"
                  title="添加子页面"
                >
                  <Plus className="w-3 h-3" />
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); onToggleFavorite(doc.id); }}
                  className={`p-1 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded transition-colors ${doc.isFavorite ? 'text-yellow-500' : 'text-zinc-500'}`}
                  title={doc.isFavorite ? "取消收藏" : "添加收藏"}
                >
                  <Sparkles className={`w-3 h-3 ${doc.isFavorite ? 'fill-current' : ''}`} />
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); onToggleKnowledgeBase(doc.id); }}
                  className={`p-1 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded transition-colors ${doc.isInKnowledgeBase ? 'text-purple-500' : 'text-zinc-500'}`}
                  title={doc.isInKnowledgeBase ? "从知识库移除" : "加入知识库"}
                >
                  <Zap className={`w-3 h-3 ${doc.isInKnowledgeBase ? 'fill-current' : ''}`} />
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); onDeleteDoc(doc.id); }}
                  className="p-1 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded text-zinc-500 hover:text-red-500 transition-colors"
                  title="移至废纸篓"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
            {isExpanded && renderTree(doc.id, level + 1)}
          </div>
        );
      });
  };

  return (
    <div className={`w-full bg-[#f7f7f5] dark:bg-zinc-900 ${isPeek ? '' : 'border-r'} border-zinc-200 dark:border-zinc-800 flex flex-col h-full flex-shrink-0 transition-colors duration-300 relative`}>
      {/* Workspace Header */}
      <div className="p-3 flex items-center justify-between group cursor-pointer transition-colors">
        <div className="flex items-center gap-2 overflow-hidden flex-1">
          <div className="w-5 h-5 rounded bg-zinc-600 dark:bg-zinc-500 flex items-center justify-center text-[10px] font-bold text-white uppercase">
            {settings.apiProvider === 'gemini' ? 'G' : settings.apiProvider?.charAt(0) || 'U'}
          </div>
          <span className="text-sm font-semibold truncate text-zinc-700 dark:text-zinc-200">
            {settings.apiProvider === 'gemini' ? 'Gemini 工作区' : '用户工作区'}
          </span>
          <ChevronRight className="w-3 h-3 text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {isPeek && onPin && (
            <button 
              onClick={onPin}
              className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-500"
              title="固定侧边栏"
            >
              <Pin className="w-3.5 h-3.5 rotate-45" />
            </button>
          )}
          {!isPeek && (
            <button 
              onClick={onCloseSidebar}
              className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-500"
              title="隐藏侧边栏"
            >
              <PanelLeftClose className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={() => onCreateDoc(null)} className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-500">
            <SquarePen className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Primary Navigation */}
      <div className="px-2 space-y-0.5 mt-1">
        <button 
          onClick={() => { setShowSearch(true); setShowHome(false); setShowLibrary(false); setShowTrash(false); }}
          className={`w-full flex items-center gap-2 px-2.5 py-1 text-sm rounded transition-colors group ${showSearch ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60'}`}
        >
          <Search className="w-4 h-4 text-zinc-500" />
          <span>搜索</span>
        </button>
        <button 
          onClick={() => { setShowHome(true); setShowSearch(false); setShowLibrary(false); setShowTrash(false); }}
          className={`w-full flex items-center gap-2 px-2.5 py-1 text-sm rounded transition-colors group ${showHome ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60'}`}
        >
          <Home className="w-4 h-4 text-zinc-500" />
          <span>主页</span>
        </button>
        <button
          onClick={() => {
            closeAllPanels();
            onOpenAiWorkspace?.();
          }}
          className={`w-full flex items-center justify-between gap-2 px-2.5 py-1 text-sm rounded transition-colors group ${
            isAiWorkspaceActive
              ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300'
              : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60'
          }`}
        >
          <div className="flex items-center gap-2">
            <Sparkles className={`w-4 h-4 ${isAiWorkspaceActive ? 'text-purple-500' : 'text-zinc-500'}`} />
            <span>Inspriation AI</span>
          </div>
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
            isAiWorkspaceActive
              ? 'bg-purple-200/80 dark:bg-purple-900/60 text-purple-700 dark:text-purple-300'
              : 'bg-zinc-200 dark:bg-zinc-800 text-zinc-500'
          }`}>
            A
          </span>
        </button>
        <button 
          onClick={() => { setShowLibrary(true); setShowSearch(false); setShowHome(false); setShowTrash(false); }}
          className={`w-full flex items-center gap-2 px-2.5 py-1 text-sm rounded transition-colors group ${showLibrary ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60'}`}
        >
          <Library className="w-4 h-4 text-zinc-500" />
          <span>库</span>
        </button>
        <button 
          onClick={() => { setShowKB(true); setShowLibrary(false); setShowSearch(false); setShowHome(false); setShowTrash(false); }}
          className={`w-full flex items-center justify-between px-2.5 py-1 text-sm rounded transition-colors group ${showKB ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60'}`}
        >
          <div className="flex items-center gap-2">
            <Zap className={`w-4 h-4 ${showKB ? 'text-purple-500' : 'text-zinc-500'}`} />
            <span>知识库</span>
          </div>
          <span className="text-[10px] font-bold bg-purple-100 dark:bg-purple-900/50 px-1.5 py-0.5 rounded-full text-purple-600 dark:text-purple-400">
            {documents.filter(d => !d.isDeleted && d.isInKnowledgeBase).length}
          </span>
        </button>
        <button 
          onClick={() => { setShowTrash(true); setShowKB(false); setShowSearch(false); setShowHome(false); setShowLibrary(false); }}
          className={`w-full flex items-center gap-2 px-2.5 py-1 text-sm rounded transition-colors group ${showTrash ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60'}`}
        >
          <Trash2 className="w-4 h-4 text-zinc-500" />
          <span>废纸篓</span>
        </button>
      </div>

      {/* Search Overlay */}
      {showSearch && (
        <div className="absolute inset-x-0 top-[140px] bottom-0 bg-[#f7f7f5] dark:bg-zinc-900 z-20 flex flex-col border-t border-zinc-200 dark:border-zinc-800">
          <div className="p-3 flex items-center gap-2 border-b border-zinc-200 dark:border-zinc-800">
            <Search className="w-4 h-4 text-zinc-400" />
            <input 
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索文档..."
              className="flex-1 bg-transparent border-none outline-none text-sm text-zinc-700 dark:text-zinc-200 placeholder:text-zinc-400"
            />
            <button onClick={() => setShowSearch(false)} className="text-zinc-400 hover:text-zinc-600">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {filteredDocs.length > 0 ? (
              filteredDocs.map(doc => (
                <div 
                  key={doc.id}
                  onClick={() => { onSelectDoc(doc.id); setShowSearch(false); }}
                  className="p-2 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded cursor-pointer group flex items-center gap-2"
                >
                  {doc.icon ? (
                    <span className="w-4 h-4 flex items-center justify-center text-sm shrink-0">{doc.icon}</span>
                  ) : (
                    <FileText className="w-4 h-4 text-zinc-400 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-zinc-700 dark:text-zinc-200 truncate">{doc.title || '无标题'}</div>
                    <div className="text-xs text-zinc-400 truncate opacity-0 group-hover:opacity-100 transition-opacity">
                      {doc.content.replace(/<[^>]*>/g, '').substring(0, 50)}...
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="p-4 text-center text-xs text-zinc-400">未找到相关文档</div>
            )}
          </div>
        </div>
      )}

      {/* Home Overlay (Dashboard Style) */}
      {showHome && (
        <div className="absolute inset-x-0 top-[140px] bottom-0 bg-[#f7f7f5] dark:bg-zinc-900 z-20 flex flex-col border-t border-zinc-200 dark:border-zinc-800">
          <div className="p-3 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800">
            <span className="text-xs font-bold text-zinc-500 uppercase">概览</span>
            <button onClick={() => setShowHome(false)} className="text-zinc-400 hover:text-zinc-600">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <div className="p-3 bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 shadow-sm">
                <div className="text-[10px] text-zinc-400 uppercase font-bold mb-1">文档总数</div>
                <div className="text-xl font-bold text-zinc-700 dark:text-zinc-200">{documents.length}</div>
              </div>
              <div className="p-3 bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 shadow-sm">
                <div className="text-[10px] text-zinc-400 uppercase font-bold mb-1">今日更新</div>
                <div className="text-xl font-bold text-zinc-700 dark:text-zinc-200">
                  {documents.filter(d => new Date(d.updatedAt).toDateString() === new Date().toDateString()).length}
                </div>
              </div>
            </div>
            <div>
              <div className="text-[10px] text-zinc-400 uppercase font-bold mb-2">快速操作</div>
              <div className="space-y-1">
                <button onClick={() => { onCreateDoc(); setShowHome(false); }} className="w-full flex items-center gap-2 p-2 text-xs text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded transition-colors">
                  <Plus className="w-3 h-3" /> 新建空白文档
                </button>
                <button onClick={() => { fileInputRef.current?.click(); setShowHome(false); }} className="w-full flex items-center gap-2 p-2 text-xs text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded transition-colors">
                  <Upload className="w-3 h-3" /> 导入本地文件
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Library Overlay (Templates & Resources) */}
      {showLibrary && (
        <div className="absolute inset-x-0 top-[140px] bottom-0 bg-[#f7f7f5] dark:bg-zinc-900 z-20 flex flex-col border-t border-zinc-200 dark:border-zinc-800">
          <div className="p-3 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800">
            <span className="text-xs font-bold text-zinc-500 uppercase">库 (Templates)</span>
            <div className="flex items-center gap-2">
              <button
                onClick={handleSaveCurrentAsTemplate}
                className="px-2 py-1 text-[10px] font-medium text-zinc-500 hover:text-purple-600 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded transition-all"
                title="将当前页面保存为模板"
              >
                保存模板
              </button>
              <button 
                onClick={refreshTemplates}
                className="p-1 text-zinc-400 hover:text-purple-500 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded transition-all"
                title="换一批模板"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setShowLibrary(false)} className="text-zinc-400 hover:text-zinc-600">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-hide">
            <div className="space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">推荐模板</div>
              {displayTemplates.map((template, idx) => (
                <button 
                  key={idx}
                  onClick={() => { onCreateDoc(null, { title: template.title, content: template.content }); setShowLibrary(false); }} 
                  className="w-full p-2.5 text-left bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg hover:shadow-md hover:border-purple-500/50 transition-all group"
                >
                  <div className="text-xs font-bold text-zinc-700 dark:text-zinc-200 group-hover:text-purple-600 dark:group-hover:text-purple-400">{template.title}</div>
                  <div className="text-[10px] text-zinc-400 mt-1 leading-relaxed">{template.description}</div>
                </button>
              ))}
            </div>
            <div className="space-y-2 pt-2">
              <div className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">我的模板</div>
              {customTemplates.length > 0 ? (
                customTemplates.map((template) => (
                  <div
                    key={template.id}
                    className="w-full p-2.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg group"
                  >
                    <button
                      onClick={() => { onCreateDoc(null, { title: template.title, content: template.content }); setShowLibrary(false); }}
                      className="w-full text-left"
                    >
                      <div className="text-xs font-bold text-zinc-700 dark:text-zinc-200 group-hover:text-purple-600 dark:group-hover:text-purple-400">{template.title}</div>
                      <div className="text-[10px] text-zinc-400 mt-1 leading-relaxed">{template.description}</div>
                    </button>
                    <div className="mt-2 flex justify-end">
                      <button
                        onClick={() => handleDeleteCustomTemplate(template.id)}
                        className="text-[10px] text-zinc-400 hover:text-red-500 transition-colors"
                      >
                        删除模板
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="px-2 py-3 border border-dashed border-zinc-200 dark:border-zinc-700 rounded-lg text-[10px] text-zinc-400 text-center">
                  还没有自定义模板。打开任意页面后点击“保存模板”即可创建。
                </div>
              )}
            </div>
            <div className="pt-2">
              <p className="text-[10px] text-zinc-400 text-center italic">点击模板即可快速创建页面</p>
            </div>
          </div>
        </div>
      )}

      {/* Knowledge Base Overlay */}
      {showKB && (
        <div className="absolute inset-x-0 top-[140px] bottom-0 bg-[#f7f7f5] dark:bg-zinc-900 z-20 flex flex-col border-t border-zinc-200 dark:border-zinc-800 animate-in fade-in slide-in-from-right-2 duration-300">
          <div className="p-3 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-purple-500" />
              <span className="text-xs font-bold text-zinc-500 uppercase">AI 知识库管理</span>
            </div>
            <button onClick={() => setShowKB(false)} className="text-zinc-400 hover:text-zinc-600">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-hide">
            <div className="bg-purple-50/50 dark:bg-purple-900/10 p-4 rounded-xl border border-purple-100 dark:border-purple-900/30">
              <div className="text-[10px] text-purple-500 font-bold uppercase mb-2">知识库状态</div>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">{documents.filter(d => !d.isDeleted && d.isInKnowledgeBase).length}</div>
                  <div className="text-[10px] text-zinc-400">已索引文档</div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">
                    {documents.filter(d => !d.isDeleted && d.isInKnowledgeBase).reduce((acc, d) => acc + (d.content.length || 0), 0).toLocaleString()}
                  </div>
                  <div className="text-[10px] text-zinc-400">总字符数</div>
                </div>
              </div>
              <p className="text-[10px] text-zinc-500 leading-relaxed italic">
                AI 助手仅会索引您手动加入知识库的文档。在侧边栏点击闪电图标即可加入。
              </p>
            </div>

            <div className="space-y-2">
              <div className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider mb-2">已选知识库内容</div>
              {documents
                .filter(d => !d.isDeleted && d.isInKnowledgeBase)
                .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
                .slice(0, 10)
                .map(doc => (
                  <div key={doc.id} className="flex items-center justify-between p-2 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded transition-colors group">
                    <div className="flex items-center gap-2 truncate flex-1">
                      <div className="w-1.5 h-1.5 rounded-full bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.5)]"></div>
                      <span className="text-xs text-zinc-700 dark:text-zinc-200 truncate">{doc.title || '无标题'}</span>
                    </div>
                    <button 
                      onClick={(e) => { e.stopPropagation(); onToggleKnowledgeBase(doc.id); }}
                      className="text-[9px] text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-red-500 transition-all"
                    >
                      移除
                    </button>
                  </div>
                ))}
            </div>
            
            <div className="pt-4 border-t border-zinc-200 dark:border-zinc-800">
              <div className="text-[10px] text-zinc-400 uppercase font-bold mb-2">使用技巧</div>
              <div className="p-2 bg-zinc-100 dark:bg-zinc-800/50 rounded text-[10px] text-zinc-500 leading-relaxed">
                输入 <code className="bg-zinc-200 dark:bg-zinc-700 px-1 rounded text-purple-600">#总结</code> 可以在文档末尾快速生成全文摘要。
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Recent Documents Section / Tree Section */}
      <div className="flex-1 overflow-y-auto py-2 scrollbar-hide relative">
        {/* Trash Overlay */}
        {showTrash && (
          <div className="absolute inset-0 bg-[#f7f7f5] dark:bg-zinc-900 z-30 flex flex-col">
            <div className="p-3 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800">
              <span className="text-xs font-bold text-zinc-500 uppercase">废纸篓</span>
              <button onClick={() => setShowTrash(false)} className="text-zinc-400 hover:text-zinc-600">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {trashDocs.length > 0 ? (
                trashDocs.map(doc => (
                  <div key={doc.id} className="group flex items-center justify-between p-2 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded transition-colors">
                    <div className="flex items-center gap-2 truncate flex-1">
                      {doc.icon ? (
                        <span className="w-4 h-4 flex items-center justify-center text-sm shrink-0">{doc.icon}</span>
                      ) : (
                        <FileText className="w-4 h-4 text-zinc-400" />
                      )}
                      <span className="text-sm text-zinc-700 dark:text-zinc-200 truncate">{doc.title || '无标题'}</span>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button 
                        onClick={() => onRestoreDoc(doc.id)}
                        className="p-1 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded text-green-600"
                        title="恢复"
                      >
                        <ChevronLeft className="w-3.5 h-3.5 rotate-90" />
                      </button>
                      <button 
                        onClick={() => onPermanentDeleteDoc(doc.id)}
                        className="p-1 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded text-red-600"
                        title="彻底删除"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="p-4 text-center text-xs text-zinc-400">废纸篓是空的</div>
              )}
            </div>
          </div>
        )}

        {favoriteDocs.length > 0 && (
          <div className="mb-4">
            <div className="px-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 mb-1 uppercase tracking-wider">
              收藏
            </div>
            <div className="space-y-0.5 px-2">
              {favoriteDocs.map(doc => (
                <div 
                  key={doc.id}
                  onClick={() => onSelectDoc(doc.id)}
                  className={`group flex items-center justify-between px-2.5 py-1 rounded cursor-pointer text-sm transition-colors ${activeDocId === doc.id ? 'bg-zinc-200 dark:bg-zinc-800 font-medium text-zinc-900 dark:text-zinc-100' : 'hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 text-zinc-600 dark:text-zinc-400'}`}
                >
                  <div className="flex items-center gap-2 truncate">
                    {doc.icon ? (
                      <span className="w-4 h-4 flex items-center justify-center text-sm shrink-0 leading-none">{doc.icon}</span>
                    ) : (
                      <FileText className="w-4 h-4 text-zinc-400 shrink-0" />
                    )}
                    <span className="truncate">{doc.title || '无标题'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      {/* 个人知识库 */}
      <div className="mb-6 px-3">
        <div className="flex items-center justify-between mb-2 group/title">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 bg-purple-100 dark:bg-purple-900/30 rounded-md flex items-center justify-center">
              <FolderSync className="w-3 h-3 text-purple-600 dark:text-purple-400" />
            </div>
            <span className="text-[11px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">个人知识库</span>
          </div>
          <button 
            onClick={() => onCreateDoc()}
            className="opacity-0 group-hover/title:opacity-100 p-1 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded transition-all"
            title="新建知识库页面"
          >
            <Plus className="w-3 h-3 text-zinc-400" />
          </button>
        </div>
        <div className="space-y-0.5">
          {documents.filter(d => !d.isDeleted && d.isInKnowledgeBase).slice(0, 15).map(doc => (
            <div 
              key={doc.id}
              onClick={() => onSelectDoc(doc.id)}
              className={`group flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer text-sm transition-all ${activeDocId === doc.id ? 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 font-medium' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/50 text-zinc-600 dark:text-zinc-400'}`}
            >
              <div className="flex items-center gap-2.5 truncate">
                {doc.icon ? (
                  <span className="w-4 h-4 flex items-center justify-center text-sm shrink-0 leading-none">{doc.icon}</span>
                ) : (
                  <FileText className="w-4 h-4 text-zinc-400 shrink-0" />
                )}
                <span className="truncate">{doc.title || '无标题'}</span>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button 
                  onClick={(e) => { e.stopPropagation(); onToggleKnowledgeBase(doc.id); }}
                  className="p-1 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded text-purple-500"
                  title="从知识库移除"
                >
                  <Zap className="w-3 h-3 fill-current" />
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); onCreateDoc(doc.id); }}
                  className="p-1 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded text-zinc-400 hover:text-purple-500"
                  title="添加子页面"
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))}
          {documents.filter(d => !d.isDeleted && d.isInKnowledgeBase).length === 0 && (
            <div className="px-2.5 py-4 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl flex flex-col items-center justify-center gap-2">
              <p className="text-[10px] text-zinc-400 text-center">暂无手动指定的知识库内容</p>
              <p className="text-[9px] text-zinc-500 text-center px-4">在文档列表中点击闪电图标即可将其加入知识库</p>
            </div>
          )}
        </div>
      </div>

        {suggestedDocs.length > 0 && (
          <div className="mb-4 bg-purple-50/30 dark:bg-purple-900/10 py-2 mx-2 rounded-lg border border-purple-100/50 dark:border-purple-900/20">
            <div className="px-2 text-[10px] font-bold text-purple-600 dark:text-purple-400 mb-1 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-3 h-3" />
              智能建议
            </div>
            <div className="space-y-0.5 px-1">
              {suggestedDocs.map(doc => (
                <div 
                  key={doc.id}
                  onClick={() => onSelectDoc(doc.id)}
                  className="group flex items-center justify-between px-2 py-1 rounded cursor-pointer text-[13px] text-zinc-600 dark:text-zinc-400 hover:bg-purple-100/50 dark:hover:bg-purple-900/20 transition-colors"
                >
                  <div className="flex items-center gap-2 truncate">
                    {doc.icon ? (
                      <span className="w-3.5 h-3.5 flex items-center justify-center text-xs shrink-0 leading-none">{doc.icon}</span>
                    ) : (
                      <FileText className="w-3.5 h-3.5 text-purple-400/70" />
                    )}
                    <span className="truncate">{doc.title || '无标题'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="px-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 mb-1 uppercase tracking-wider flex items-center group cursor-pointer hover:text-zinc-600 dark:hover:text-zinc-300">
          <ChevronRight className="w-3 h-3 mr-1" />
          私密
        </div>
        <div className="space-y-0.5 px-2">
          {renderTree(null)}
        </div>
      </div>

      {/* Bottom Actions */}
      <div className="px-2 py-3 space-y-0.5">
        <input 
          type="file" 
          ref={fileInputRef} 
          className="hidden" 
          accept={SUPPORTED_IMPORT_ACCEPT}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              void onImportFile(file);
              e.target.value = '';
            }
          }}
        />
        <button 
          onClick={() => fileInputRef.current?.click()}
          className="w-full flex items-center gap-2 px-2.5 py-1 text-sm text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 rounded transition-colors group"
        >
          <Upload className="w-4 h-4 text-zinc-500" />
          <span>导入</span>
        </button>
        <button 
          onClick={() => onCreateDoc(null)}
          className="w-full flex items-center gap-2 px-2.5 py-1 text-sm text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 rounded transition-colors group"
        >
          <Plus className="w-4 h-4 text-zinc-500" />
          <span>新建页面</span>
        </button>
        <button 
          onClick={() => setIsSettingsOpen(true)}
          className="w-full flex items-center justify-between px-2.5 py-1 text-sm text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 rounded transition-colors group"
        >
          <div className="flex items-center gap-2">
            <MoreHorizontal className="w-4 h-4 text-zinc-500" />
            <span>更多</span>
          </div>
          <button 
            onClick={(e) => {
              e.stopPropagation();
              onToggleTheme();
            }}
            className="p-1 rounded text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 transition-colors"
          >
            {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
        </button>
      </div>

      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="relative bg-white dark:bg-zinc-900 rounded-xl shadow-xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh] border border-zinc-200 dark:border-zinc-800 animate-in fade-in zoom-in duration-200">
            <div className="flex items-center justify-between p-4 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">设置</h2>
              <button 
                onClick={() => setIsSettingsOpen(false)}
                className="p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="flex border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
              <button 
                className={`flex-1 py-3 text-sm font-medium transition-colors ${activeTab === 'api' ? 'text-purple-600 border-b-2 border-purple-600' : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'}`}
                onClick={() => setActiveTab('api')}
              >
                API 配置
              </button>
              <button 
                className={`flex-1 py-3 text-sm font-medium transition-colors ${activeTab === 'notion' ? 'text-purple-600 border-b-2 border-purple-600' : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'}`}
                onClick={() => setActiveTab('notion')}
              >
                Notion 导出
              </button>
            </div>

            <div className="p-4 space-y-4 overflow-y-auto flex-1 scrollbar-hide">
              {activeTab === 'api' ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-3 bg-zinc-50 dark:bg-zinc-800/50 rounded-lg border border-zinc-200 dark:border-zinc-700">
                    <div>
                      <div className="text-sm font-medium text-zinc-700 dark:text-zinc-200 flex items-center gap-2">
                        <Zap className="w-4 h-4 text-purple-500" />
                        AI 自动补全 (Ghost Writing)
                      </div>
                      <div className="text-[10px] text-zinc-400">输入停顿时自动预测下文，Tab 键采纳</div>
                    </div>
                    <button 
                      onClick={() => onUpdateSettings({ ...settings, aiAutocomplete: !settings.aiAutocomplete })}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${settings.aiAutocomplete ? 'bg-purple-600' : 'bg-zinc-200 dark:bg-zinc-700'}`}
                    >
                      <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${settings.aiAutocomplete ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between p-3 bg-zinc-50 dark:bg-zinc-800/50 rounded-lg border border-zinc-200 dark:border-zinc-700">
                    <div>
                      <div className="text-sm font-medium text-zinc-700 dark:text-zinc-200 flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-purple-500" />
                        AI 自动洞察 (后台)
                      </div>
                      <div className="text-[10px] text-zinc-400">自动生成摘要、标签与行动项，减少手动整理</div>
                    </div>
                    <button
                      onClick={() => onUpdateSettings({ ...settings, aiAutomation: !settings.aiAutomation })}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${settings.aiAutomation ? 'bg-purple-600' : 'bg-zinc-200 dark:bg-zinc-700'}`}
                    >
                      <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${settings.aiAutomation ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                  </div>

                  {migration.status !== 'ready' && (
                    <div className="rounded-lg border border-zinc-200 bg-white p-3 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/70 dark:text-zinc-200">
                      <div className="text-sm font-medium">数据迁移</div>
                      <div className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-400">
                        {migration.status === 'checking' ? '正在检测本地与服务器数据…' : '检测到可迁移的数据，可迁移至本地服务端。'}
                      </div>
                      <div className="mt-2 text-[10px] text-zinc-500 dark:text-zinc-400">{localSummaryText}</div>
                      {migration.status === 'conflict' && (
                        <div className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">{serverSummaryText}</div>
                      )}
                      {migration.status === 'error' && migration.error && (
                        <div className="mt-1 text-[10px] text-rose-600 dark:text-rose-400">{migration.error}</div>
                      )}
                      {migration.status === 'done' && (
                        <div className="mt-1 text-[10px] text-emerald-600 dark:text-emerald-400">迁移完成</div>
                      )}
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          onClick={() => {
                            setMigrationChoice('local');
                            setShowMigrationDialog(true);
                          }}
                          disabled={migration.status === 'checking'}
                          className="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-50"
                        >
                          开始迁移
                        </button>
                        {migration.status === 'error' && (
                          <button
                            onClick={onCheckMigration}
                            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-200"
                          >
                            重试检测
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">服务商</label>
                    <select 
                      value={settings.apiProvider || 'gemini'}
                      onChange={(e) => handleProviderChange(e.target.value)}
                      className="w-full px-3 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all bg-white dark:bg-zinc-800 dark:text-zinc-200"
                    >
                      {API_PROVIDERS.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>

                  {settings.apiProvider !== 'gemini' && (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">API URL</label>
                        <input 
                          type="text"
                          value={settings.apiUrl}
                          onChange={(e) => onUpdateSettings({ ...settings, apiUrl: e.target.value })}
                          placeholder="https://api.example.com/v1"
                          className="w-full px-3 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all bg-white dark:bg-zinc-800 dark:text-zinc-200"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">API Key</label>
                        <input 
                          type="password"
                          value={settings.apiKey}
                          onChange={(e) => onUpdateSettings({ ...settings, apiKey: e.target.value })}
                          placeholder="sk-..."
                          className="w-full px-3 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all bg-white dark:bg-zinc-800 dark:text-zinc-200"
                        />
                      </div>
                      
                      <div className="pt-2">
                        <div className="flex items-center justify-between mb-1">
                          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">模型</label>
                          <button 
                            onClick={fetchModels}
                            disabled={isDetecting || !settings.apiUrl || !settings.apiKey}
                            className="text-xs text-purple-600 hover:text-purple-700 dark:text-purple-400 dark:hover:text-purple-300 font-medium disabled:opacity-50 flex items-center gap-1"
                          >
                            {isDetecting && <Loader2 className="w-3 h-3 animate-spin" />}
                            检测模型
                          </button>
                        </div>
                        {availableModels.length > 0 ? (
                          <div className="space-y-2">
                            <select 
                              value={availableModels.some(m => m.id === settings.selectedModel) ? settings.selectedModel : 'custom'}
                              onChange={(e) => {
                                const value = e.target.value;
                                if (value !== 'custom') {
                                  onUpdateSettings({ ...settings, selectedModel: value });
                                } else {
                                  // Keep current model if switching to custom to allow editing, or clear if it was a preset
                                  if (availableModels.some(m => m.id === settings.selectedModel)) {
                                     onUpdateSettings({ ...settings, selectedModel: '' });
                                  }
                                }
                              }}
                              className="w-full px-3 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all bg-white dark:bg-zinc-800 dark:text-zinc-200"
                            >
                              <option value="">请选择模型...</option>
                              {availableModels.map(m => (
                                <option key={m.id} value={m.id}>{m.name}</option>
                              ))}
                              <option value="custom">手动输入...</option>
                            </select>
                            
                            {(!settings.selectedModel || !availableModels.some(m => m.id === settings.selectedModel)) && (
                              <input 
                                type="text"
                                value={settings.selectedModel}
                                onChange={(e) => onUpdateSettings({ ...settings, selectedModel: e.target.value })}
                                placeholder="输入模型名称 (如 qwen-turbo)"
                                className="w-full px-3 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all bg-white dark:bg-zinc-800 dark:text-zinc-200 animate-in fade-in slide-in-from-top-1"
                              />
                            )}
                          </div>
                        ) : (
                          <input 
                            type="text"
                            value={settings.selectedModel}
                            onChange={(e) => onUpdateSettings({ ...settings, selectedModel: e.target.value })}
                            placeholder="手动输入模型名称 (如 qwen-turbo)"
                            className="w-full px-3 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all bg-white dark:bg-zinc-800 dark:text-zinc-200"
                          />
                        )}
                      </div>
                    </>
                  )}
                  {settings.apiProvider === 'gemini' && (
                    <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-100 dark:border-purple-900/30">
                      <p className="text-sm text-purple-800 dark:text-purple-300">
                        当前使用内置的 Gemini 模型，无需额外配置。
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Notion API Key</label>
                    <input 
                      type="password"
                      value={settings.notionApiKey}
                      onChange={(e) => onUpdateSettings({ ...settings, notionApiKey: e.target.value })}
                      placeholder="secret_..."
                      className="w-full px-3 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all bg-white dark:bg-zinc-800 dark:text-zinc-200"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Notion Page ID</label>
                    <input 
                      type="text"
                      value={settings.notionPageId}
                      onChange={(e) => onUpdateSettings({ ...settings, notionPageId: e.target.value })}
                      placeholder="e.g. 1234567890abcdef1234567890abcdef"
                      className="w-full px-3 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all bg-white dark:bg-zinc-800 dark:text-zinc-200"
                    />
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      要导出到 Notion，请确保您的 Notion 集成已邀请到目标页面。
                    </p>
                  </div>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-zinc-100 dark:border-zinc-800 flex justify-end flex-shrink-0">
              <button 
                onClick={() => setIsSettingsOpen(false)}
                className="px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 transition-colors"
              >
                保存并关闭
              </button>
            </div>
            {showMigrationDialog && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
                <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
                  <div className="text-base font-semibold text-zinc-900 dark:text-zinc-100">数据迁移确认</div>
                  <div className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">{localSummaryText}</div>
                  {migration.status === 'conflict' && (
                    <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{serverSummaryText}</div>
                  )}
                  <div className="mt-3 space-y-2 text-sm text-zinc-700 dark:text-zinc-200">
                    <label className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700">
                      <input
                        type="radio"
                        name="migration-choice"
                        checked={migrationChoice === 'local'}
                        onChange={() => setMigrationChoice('local')}
                      />
                      <span>本地覆盖服务器</span>
                    </label>
                    <label className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700">
                      <input
                        type="radio"
                        name="migration-choice"
                        checked={migrationChoice === 'server'}
                        onChange={() => setMigrationChoice('server')}
                      />
                      <span>服务器覆盖本地</span>
                    </label>
                  </div>
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      onClick={() => setShowMigrationDialog(false)}
                      className="rounded-lg px-3 py-2 text-sm text-zinc-500 transition-colors hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                    >
                      取消
                    </button>
                    <button
                      onClick={() => {
                        setShowMigrationDialog(false);
                        onResolveMigration(migrationChoice);
                      }}
                      disabled={migration.status === 'checking'}
                      className="rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-50"
                    >
                      确认迁移
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
