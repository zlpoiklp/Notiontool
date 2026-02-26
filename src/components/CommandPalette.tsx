import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { FileText, Search, Plus, Library, Zap, Trash2, Settings, Moon, Sun, Command } from 'lucide-react';
import { Document } from '../App';

type CommandPaletteProps = {
  isOpen: boolean;
  documents: Document[];
  theme: 'light' | 'dark';
  onClose: () => void;
  onSelectDoc: (id: string) => void;
  onCreateDoc: () => void;
  onOpenSearch: () => void;
  onOpenLibrary: () => void;
  onOpenKnowledgeBase: () => void;
  onOpenTrash: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
};

type ActionItem = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  icon: ComponentType<{ className?: string }>;
  run: () => void;
};

type ResultItem =
  | ({ kind: 'action' } & ActionItem)
  | {
      kind: 'doc';
      id: string;
      title: string;
      description: string;
      icon?: string;
      run: () => void;
    };

export default function CommandPalette({
  isOpen,
  documents,
  theme,
  onClose,
  onSelectDoc,
  onCreateDoc,
  onOpenSearch,
  onOpenLibrary,
  onOpenKnowledgeBase,
  onOpenTrash,
  onOpenSettings,
  onToggleTheme,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setActiveIndex(0);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [isOpen]);

  const actions = useMemo<ActionItem[]>(
    () => [
      {
        id: 'new-doc',
        title: '新建页面',
        description: '创建一个新的空白页面',
        keywords: ['new', 'create', 'page', '新建', '页面', '文档'],
        icon: Plus,
        run: () => {
          onCreateDoc();
          onClose();
        },
      },
      {
        id: 'search',
        title: '打开搜索',
        description: '显示搜索面板',
        keywords: ['search', 'find', '搜索'],
        icon: Search,
        run: () => {
          onOpenSearch();
          onClose();
        },
      },
      {
        id: 'library',
        title: '打开模板库',
        description: '显示模板与资源库',
        keywords: ['library', 'template', '模板', '库'],
        icon: Library,
        run: () => {
          onOpenLibrary();
          onClose();
        },
      },
      {
        id: 'kb',
        title: '打开知识库',
        description: '管理 AI 知识库内容',
        keywords: ['kb', 'knowledge', '知识库'],
        icon: Zap,
        run: () => {
          onOpenKnowledgeBase();
          onClose();
        },
      },
      {
        id: 'trash',
        title: '打开废纸篓',
        description: '查看已删除页面',
        keywords: ['trash', 'deleted', '废纸篓', '删除'],
        icon: Trash2,
        run: () => {
          onOpenTrash();
          onClose();
        },
      },
      {
        id: 'settings',
        title: '打开设置',
        description: '打开 API 和 Notion 配置',
        keywords: ['settings', 'config', '设置'],
        icon: Settings,
        run: () => {
          onOpenSettings();
          onClose();
        },
      },
      {
        id: 'theme',
        title: theme === 'dark' ? '切换到浅色模式' : '切换到深色模式',
        description: '切换当前界面主题',
        keywords: ['theme', 'dark', 'light', '主题', '深色', '浅色'],
        icon: theme === 'dark' ? Sun : Moon,
        run: () => {
          onToggleTheme();
          onClose();
        },
      },
    ],
    [onClose, onCreateDoc, onOpenKnowledgeBase, onOpenLibrary, onOpenSearch, onOpenSettings, onOpenTrash, onToggleTheme, theme]
  );

  const results = useMemo<ResultItem[]>(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const liveDocs = documents.filter((doc) => !doc.isDeleted);

    const actionResults = actions
      .filter((action) => {
        if (!normalizedQuery) return true;
        return (
          action.title.toLowerCase().includes(normalizedQuery) ||
          action.description.toLowerCase().includes(normalizedQuery) ||
          action.keywords.some((word) => word.includes(normalizedQuery))
        );
      })
      .map((action) => ({ kind: 'action' as const, ...action }));

    const docResults = liveDocs
      .filter((doc) => {
        if (!normalizedQuery) return true;
        const plainText = doc.content.replace(/<[^>]*>/g, '').toLowerCase();
        return doc.title.toLowerCase().includes(normalizedQuery) || plainText.includes(normalizedQuery);
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, normalizedQuery ? 12 : 6)
      .map((doc) => ({
        kind: 'doc' as const,
        id: `doc-${doc.id}`,
        title: doc.title || '无标题',
        description: doc.content.replace(/<[^>]*>/g, '').slice(0, 56) || '空白页面',
        icon: doc.icon,
        run: () => {
          onSelectDoc(doc.id);
          onClose();
        },
      }));

    if (!normalizedQuery) {
      return [...actionResults.slice(0, 6), ...docResults];
    }
    return [...actionResults, ...docResults];
  }, [actions, documents, onClose, onSelectDoc, query]);

  useEffect(() => {
    if (activeIndex >= results.length) {
      setActiveIndex(Math.max(0, results.length - 1));
    }
  }, [activeIndex, results.length]);

  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % Math.max(results.length, 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev - 1 + Math.max(results.length, 1)) % Math.max(results.length, 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      results[activeIndex]?.run();
    }
  };

  return (
    <div className="fixed inset-0 z-[120] bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="max-w-2xl mx-auto mt-[10vh] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <Command className="w-4 h-4 text-zinc-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入命令或搜索页面..."
            className="flex-1 bg-transparent border-none outline-none text-sm text-zinc-700 dark:text-zinc-200 placeholder:text-zinc-400"
          />
          <span className="text-[10px] text-zinc-400 border border-zinc-200 dark:border-zinc-700 rounded px-1.5 py-0.5">ESC</span>
        </div>

        <div className="max-h-[56vh] overflow-y-auto p-2">
          {results.length === 0 ? (
            <div className="p-6 text-center text-xs text-zinc-400">没有匹配结果</div>
          ) : (
            results.map((item, index) => {
              const isActive = index === activeIndex;
              if (item.kind === 'action') {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={item.run}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl transition-colors text-left ${isActive ? 'bg-purple-50 dark:bg-purple-900/20' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'}`}
                  >
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${isActive ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-300' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500'}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100 truncate">{item.title}</div>
                      <div className="text-[11px] text-zinc-400 truncate">{item.description}</div>
                    </div>
                  </button>
                );
              }

              return (
                <button
                  key={item.id}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={item.run}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl transition-colors text-left ${isActive ? 'bg-zinc-100 dark:bg-zinc-800/70' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/40'}`}
                >
                  <div className="w-7 h-7 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-500">
                    {item.icon ? <span className="text-sm leading-none">{item.icon}</span> : <FileText className="w-4 h-4" />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm text-zinc-800 dark:text-zinc-100 truncate">{item.title}</div>
                    <div className="text-[11px] text-zinc-400 truncate">{item.description}</div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
