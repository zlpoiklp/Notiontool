import { useState, useEffect, useRef } from 'react';
import { Menu } from 'lucide-react';
import Sidebar from './components/Sidebar';
import Editor from './components/Editor';
import AIWorkflowStudio from './components/AIWorkflowStudio';
import CommandPalette from './components/CommandPalette';
import { importFileToDocument } from './utils/fileImport';
import { fetchJson } from './utils/apiClient';
import { Skill, DEFAULT_SKILLS } from './types/skill';

export type Document = {
  id: string;
  title: string;
  content: string;
  translatedContent?: string;
  coverImage?: string;
  icon?: string;
  fontFamily?: string;
  updatedAt: Date;
  parentId?: string | null;
  isFavorite?: boolean;
  isDeleted?: boolean;
  isPublic?: boolean;
  isInKnowledgeBase?: boolean;
  aiSummary?: string;
  aiTags?: string[];
  aiActionItems?: string[];
  autoInsightsUpdatedAt?: string;
  goalSource?: GoalSource;
  goalPlan?: GoalPlan;
  goalPlanUpdatedAt?: string;
  goalExecutionLog?: GoalExecutionLog[];
  automationStrategy?: AutomationStrategy;
};

export type AutomationStrategy = {
  executionMode: 'preview' | 'auto_apply';
  targetPreference: 'follow_selector' | 'original' | 'translated';
  riskTolerance: 'low' | 'medium' | 'high';
  idleMs: number;
  maxItems: number;
};

export type GoalSource = {
  goal: string;
  constraints?: string;
  deadline?: string;
};

export type GoalPlan = {
  version: 'v1';
  summary: string;
  milestones: Array<{
    id: string;
    title: string;
    due?: string;
    status: 'todo' | 'doing' | 'done' | 'blocked';
  }>;
  tasks: Array<{
    id: string;
    title: string;
    priority: 'p0' | 'p1' | 'p2';
    milestoneId?: string;
    status: 'todo' | 'doing' | 'done' | 'blocked';
    owner?: 'me';
  }>;
  nextActions: Array<{
    id: string;
    title: string;
    reason: string;
  }>;
  risks: Array<{
    id: string;
    title: string;
    level: 'low' | 'medium' | 'high';
    mitigation?: string;
  }>;
};

export type GoalExecutionLog = {
  id: string;
  at: string;
  trigger: 'init' | 'manual_replan' | 'auto_replan' | 'auto_execute' | 'manual_execute';
  changedSections: string[];
  summary: string;
};

export type Settings = {
  notionApiKey: string;
  notionPageId: string;
  apiProvider: string;
  apiUrl: string;
  apiKey: string;
  selectedModel: string;
  aiAutocomplete: boolean;
  aiAutomation: boolean;
};

type DocumentBackup = {
  createdAt: string;
  payload: string;
};

export type DocumentSnapshot = {
  id: string;
  docId: string;
  title: string;
  content: string;
  createdAt: string;
  reason: 'manual' | 'auto';
};

export type MigrationSummary = {
  documents: number;
  skills: number;
  settings: boolean;
  snapshots: number;
  backups: number;
};

const DOCS_STORAGE_KEY = 'notion-clone-docs';
const DOCS_BACKUPS_KEY = 'notion-clone-docs-backups';
const DOCS_LAST_BACKUP_AT_KEY = 'notion-clone-last-backup-at';
const DOC_SNAPSHOTS_KEY = 'notion-clone-doc-snapshots';
const SKILLS_STORAGE_KEY = 'notion-clone-skills';
const DOCS_BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_DOC_BACKUPS = 7;
const MAX_SNAPSHOTS_PER_DOC = 20;
const AUTO_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_SNAPSHOT_MIN_DIFF = 160;
const MIGRATION_FLAG_KEY = 'notion-clone-migration-done';

const DEFAULT_SETTINGS: Settings = {
  notionApiKey: '',
  notionPageId: '',
  apiProvider: 'gemini',
  apiUrl: '',
  apiKey: '',
  selectedModel: '',
  aiAutocomplete: true,
  aiAutomation: true
};

function parseStoredDocuments(raw: string): Document[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((d: any) => ({ ...d, updatedAt: new Date(d.updatedAt) }));
  } catch {
    return null;
  }
}

function loadDocumentBackups(): DocumentBackup[] {
  const raw = localStorage.getItem(DOCS_BACKUPS_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry: any) => typeof entry?.payload === 'string');
  } catch {
    return [];
  }
}

function getLatestBackupDocuments(): Document[] | null {
  const backups = loadDocumentBackups();
  if (backups.length === 0) return null;
  return parseStoredDocuments(backups[0].payload);
}

function loadDocumentSnapshots(): Record<string, DocumentSnapshot[]> {
  const raw = localStorage.getItem(DOC_SNAPSHOTS_KEY);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};

    const safeEntries = Object.entries(parsed).map(([docId, snapshots]) => {
      if (!Array.isArray(snapshots)) return [docId, []];
      const safeSnapshots = snapshots.filter((item: any) => (
        typeof item?.id === 'string' &&
        typeof item?.docId === 'string' &&
        typeof item?.title === 'string' &&
        typeof item?.content === 'string' &&
        typeof item?.createdAt === 'string'
      ));
      return [docId, safeSnapshots];
    });

    return Object.fromEntries(safeEntries);
  } catch {
    return {};
  }
}

export default function App() {
  const [documents, setDocuments] = useState<Document[]>(() => {
    const saved = localStorage.getItem(DOCS_STORAGE_KEY);
    if (saved) {
      const parsedDocs = parseStoredDocuments(saved);
      if (parsedDocs) {
        return parsedDocs;
      }
      console.error('Failed to parse primary documents, trying latest backup...');
    }

    const backupDocs = getLatestBackupDocuments();
    if (backupDocs) {
      console.warn('Primary documents unavailable. Recovered from latest local backup.');
      return backupDocs;
    }

    return [];
  });

  const [activeDocId, setActiveDocId] = useState<string | null>(() => {
    return localStorage.getItem('notion-clone-active-id');
  });

  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    const saved = localStorage.getItem('notion-clone-sidebar-open');
    return saved !== null ? saved === 'true' : true;
  });
  const [activeWorkspaceView, setActiveWorkspaceView] = useState<'document' | 'inspriation_ai'>(() => {
    const saved = localStorage.getItem('notion-clone-active-workspace-view');
    return saved === 'inspriation_ai' ? 'inspriation_ai' : 'document';
  });

  const [isPeekOpen, setIsPeekOpen] = useState(false);
  const peekTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleMouseEnterPeek = () => {
    if (peekTimeoutRef.current) clearTimeout(peekTimeoutRef.current);
    setIsPeekOpen(true);
  };

  const handleMouseLeavePeek = () => {
    peekTimeoutRef.current = setTimeout(() => {
      setIsPeekOpen(false);
    }, 300); // 300ms 延迟，给用户足够的移动和点击时间
  };

  useEffect(() => {
    return () => {
      if (peekTimeoutRef.current) clearTimeout(peekTimeoutRef.current);
    };
  }, []);

  const [sidebarWidth, setSidebarOpenWidth] = useState(() => {
    const saved = localStorage.getItem('notion-clone-sidebar-width');
    return saved ? parseInt(saved, 10) : 256;
  });

  const [isResizingSidebar, setIsResizingSidebar] = useState(false);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return localStorage.getItem('writer_theme') as 'light' | 'dark' || 'light';
  });

  const startResizingSidebar = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingSidebar(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingSidebar) return;
      const newWidth = Math.min(Math.max(e.clientX, 160), 480);
      setSidebarOpenWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizingSidebar(false);
    };

    if (isResizingSidebar) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingSidebar]);
  
  const [settings, setSettings] = useState<Settings>(() => {
    const saved = localStorage.getItem('writer_settings');
    if (!saved) return DEFAULT_SETTINGS;

    try {
      const parsed = JSON.parse(saved);
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
      };
    } catch {
      return DEFAULT_SETTINGS;
    }
  });
  const [docSnapshots, setDocSnapshots] = useState<Record<string, DocumentSnapshot[]>>(() => loadDocumentSnapshots());
  const [skills, setSkills] = useState<Skill[]>(() => {
    const saved = localStorage.getItem(SKILLS_STORAGE_KEY);
    if (!saved) return DEFAULT_SKILLS;
    try {
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return DEFAULT_SKILLS;
      // Merge with default skills to ensure new default skills are present if not already custom
      const loadedSkills = parsed as Skill[];
      // Simple strategy: use loaded skills. If user deleted a default skill, it stays deleted.
      // But we might want to ensure IDs are unique.
      return loadedSkills.length > 0 ? loadedSkills : DEFAULT_SKILLS;
    } catch {
      return DEFAULT_SKILLS;
    }
  });

  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const previousDocContentRef = useRef<Record<string, string>>({});
  const lastAutoSnapshotAtRef = useRef<Record<string, number>>({});
  const isSnapshotScanInitializedRef = useRef(false);
  const serverSyncReadyRef = useRef(false);
  const serverSeedRef = useRef<{
    documents: Document[];
    skills: Skill[];
    settings: Settings | null;
    snapshots: Record<string, DocumentSnapshot[]>;
    backups: DocumentBackup[];
  } | null>(null);
  const [migrationState, setMigrationState] = useState<{
    status: 'checking' | 'needed' | 'conflict' | 'ready' | 'done' | 'error';
    local: MigrationSummary;
    server: MigrationSummary;
    error?: string;
  }>({
    status: 'checking',
    local: { documents: 0, skills: 0, settings: false, snapshots: 0, backups: 0 },
    server: { documents: 0, skills: 0, settings: false, snapshots: 0, backups: 0 }
  });

  const normalizeDocuments = (items: Document[]) => (
    items.map(doc => ({ ...doc, updatedAt: new Date(doc.updatedAt) }))
  );

  const getSettingsHasData = (value: Settings) => {
    return Boolean(
      value.notionApiKey ||
      value.notionPageId ||
      value.apiKey ||
      value.apiUrl ||
      value.selectedModel ||
      value.apiProvider !== DEFAULT_SETTINGS.apiProvider ||
      value.aiAutocomplete !== DEFAULT_SETTINGS.aiAutocomplete ||
      value.aiAutomation !== DEFAULT_SETTINGS.aiAutomation
    );
  };

  const countSnapshots = (snapshots: Record<string, DocumentSnapshot[]>) => (
    Object.values(snapshots || {}).reduce((total, list) => total + list.length, 0)
  );

  const buildSummary = (input: {
    documents: Document[];
    skills: Skill[];
    settings: Settings | null;
    snapshots: Record<string, DocumentSnapshot[]>;
    backups: DocumentBackup[];
  }): MigrationSummary => ({
    documents: input.documents.length,
    skills: input.skills.length,
    settings: input.settings ? getSettingsHasData(input.settings) : false,
    snapshots: countSnapshots(input.snapshots),
    backups: input.backups.length
  });

  const hasAnyData = (summary: MigrationSummary) => (
    summary.documents > 0 ||
    summary.skills > 0 ||
    summary.settings ||
    summary.snapshots > 0 ||
    summary.backups > 0
  );

  const applyServerSeed = (seed: {
    documents: Document[];
    skills: Skill[];
    settings: Settings | null;
    snapshots: Record<string, DocumentSnapshot[]>;
    backups: DocumentBackup[];
  }) => {
    setDocuments(normalizeDocuments(seed.documents));
    setSkills(seed.skills.length > 0 ? seed.skills : DEFAULT_SKILLS);
    if (seed.settings) {
      setSettings({ ...DEFAULT_SETTINGS, ...seed.settings });
    }
    setDocSnapshots(seed.snapshots || {});
    const safeBackups = Array.isArray(seed.backups) ? seed.backups : [];
    localStorage.setItem(DOCS_BACKUPS_KEY, JSON.stringify(safeBackups));
    localStorage.setItem(DOCS_LAST_BACKUP_AT_KEY, new Date().toISOString());
  };

  const syncLocalToServer = async () => {
    await fetchJson('/api/documents/bulk', {
      method: 'POST',
      body: JSON.stringify({ documents })
    });
    await fetchJson('/api/skills/bulk', {
      method: 'POST',
      body: JSON.stringify({ skills })
    });
    await fetchJson('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ settings })
    });
    await fetchJson('/api/snapshots', {
      method: 'POST',
      body: JSON.stringify({ snapshots: docSnapshots })
    });
    await fetchJson('/api/backups', {
      method: 'POST',
      body: JSON.stringify({ backups: loadDocumentBackups() })
    });
  };

  const checkMigration = async () => {
    setMigrationState(prev => ({ ...prev, status: 'checking', error: undefined }));
    try {
      const [docsResponse, skillsResponse, settingsResponse, snapshotsResponse, backupsResponse] = await Promise.all([
        fetchJson<{ documents: Document[] }>('/api/documents'),
        fetchJson<{ skills: Skill[] }>('/api/skills'),
        fetchJson<{ settings: Settings | null }>('/api/settings'),
        fetchJson<{ snapshots: Record<string, DocumentSnapshot[]> }>('/api/snapshots'),
        fetchJson<{ backups: DocumentBackup[] }>('/api/backups')
      ]);

      const serverSeed = {
        documents: Array.isArray(docsResponse.documents) ? docsResponse.documents : [],
        skills: Array.isArray(skillsResponse.skills) ? skillsResponse.skills : [],
        settings: settingsResponse.settings || null,
        snapshots: snapshotsResponse.snapshots || {},
        backups: Array.isArray(backupsResponse.backups) ? backupsResponse.backups : []
      };

      serverSeedRef.current = serverSeed;

      const localSeed = {
        documents,
        skills,
        settings,
        snapshots: docSnapshots,
        backups: loadDocumentBackups()
      };

      const localSummary = buildSummary(localSeed);
      const serverSummary = buildSummary(serverSeed);

      const hasLocal = hasAnyData(localSummary);
      const hasServer = hasAnyData(serverSummary);

      if (!hasLocal && !hasServer) {
        serverSyncReadyRef.current = true;
        setMigrationState({ status: 'ready', local: localSummary, server: serverSummary });
        return;
      }

      if (hasServer && !hasLocal) {
        applyServerSeed(serverSeed);
        serverSyncReadyRef.current = true;
        setMigrationState({ status: 'ready', local: localSummary, server: serverSummary });
        return;
      }

      if (hasLocal && !hasServer) {
        serverSyncReadyRef.current = false;
        setMigrationState({ status: 'needed', local: localSummary, server: serverSummary });
        return;
      }

      serverSyncReadyRef.current = false;
      setMigrationState({ status: 'conflict', local: localSummary, server: serverSummary });
    } catch (error: any) {
      serverSyncReadyRef.current = false;
      setMigrationState(prev => ({
        ...prev,
        status: 'error',
        error: error?.message || '检测失败'
      }));
    }
  };

  const resolveMigration = async (strategy: 'local' | 'server') => {
    setMigrationState(prev => ({ ...prev, status: 'checking', error: undefined }));
    try {
      if (strategy === 'local') {
        await syncLocalToServer();
      } else {
        if (!serverSeedRef.current) {
          await checkMigration();
        }
        if (serverSeedRef.current) {
          applyServerSeed(serverSeedRef.current);
        }
      }
      serverSyncReadyRef.current = true;
      localStorage.setItem(MIGRATION_FLAG_KEY, new Date().toISOString());
      setMigrationState(prev => ({ ...prev, status: 'done' }));
    } catch (error: any) {
      setMigrationState(prev => ({
        ...prev,
        status: 'error',
        error: error?.message || '迁移失败'
      }));
    }
  };

  useEffect(() => {
    void checkMigration();
  }, []);

  useEffect(() => {
    localStorage.setItem(SKILLS_STORAGE_KEY, JSON.stringify(skills));
    if (!serverSyncReadyRef.current) return;
    void fetchJson('/api/skills/bulk', {
      method: 'POST',
      body: JSON.stringify({ skills })
    }).catch(() => {});
  }, [skills]);

  useEffect(() => {
    const serializedDocs = JSON.stringify(documents);
    localStorage.setItem(DOCS_STORAGE_KEY, serializedDocs);

    const now = Date.now();
    const lastBackupAt = Number(localStorage.getItem(DOCS_LAST_BACKUP_AT_KEY) || '0');
    if (now - lastBackupAt < DOCS_BACKUP_INTERVAL_MS) {
      return;
    }

    const backups = loadDocumentBackups();
    if (backups[0]?.payload === serializedDocs) {
      localStorage.setItem(DOCS_LAST_BACKUP_AT_KEY, now.toString());
      return;
    }

    const nextBackups: DocumentBackup[] = [
      { createdAt: new Date().toISOString(), payload: serializedDocs },
      ...backups,
    ].slice(0, MAX_DOC_BACKUPS);

    localStorage.setItem(DOCS_BACKUPS_KEY, JSON.stringify(nextBackups));
    localStorage.setItem(DOCS_LAST_BACKUP_AT_KEY, now.toString());

    if (!serverSyncReadyRef.current) return;
    void fetchJson('/api/documents/bulk', {
      method: 'POST',
      body: JSON.stringify({ documents })
    }).catch(() => {});
    void fetchJson('/api/backups', {
      method: 'POST',
      body: JSON.stringify({ backups: nextBackups })
    }).catch(() => {});
  }, [documents]);

  useEffect(() => {
    localStorage.setItem(DOC_SNAPSHOTS_KEY, JSON.stringify(docSnapshots));
    if (!serverSyncReadyRef.current) return;
    void fetchJson('/api/snapshots', {
      method: 'POST',
      body: JSON.stringify({ snapshots: docSnapshots })
    }).catch(() => {});
  }, [docSnapshots]);

  useEffect(() => {
    if (activeDocId) {
      localStorage.setItem('notion-clone-active-id', activeDocId);
    } else {
      localStorage.removeItem('notion-clone-active-id');
    }
  }, [activeDocId]);

  useEffect(() => {
    localStorage.setItem('notion-clone-sidebar-open', isSidebarOpen.toString());
  }, [isSidebarOpen]);

  useEffect(() => {
    localStorage.setItem('notion-clone-active-workspace-view', activeWorkspaceView);
  }, [activeWorkspaceView]);

  useEffect(() => {
    localStorage.setItem('notion-clone-sidebar-width', sidebarWidth.toString());
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem('writer_settings', JSON.stringify(settings));
    if (!serverSyncReadyRef.current) return;
    void fetchJson('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ settings })
    }).catch(() => {});
  }, [settings]);

  useEffect(() => {
    localStorage.setItem('writer_theme', theme);
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  const activeDoc = documents.find(d => d.id === activeDocId) || null;
  const handleSelectDoc = (id: string) => {
    setActiveDocId(id);
    setActiveWorkspaceView('document');
  };

  const createDocSnapshot = (docId: string, reason: 'manual' | 'auto' = 'manual') => {
    const targetDoc = documents.find(doc => doc.id === docId);
    if (!targetDoc) return;

    const snapshot: DocumentSnapshot = {
      id: crypto.randomUUID(),
      docId,
      title: targetDoc.title || '无标题',
      content: targetDoc.content,
      createdAt: new Date().toISOString(),
      reason,
    };

    setDocSnapshots(prev => {
      const prevList = prev[docId] || [];
      const latest = prevList[0];
      if (latest && latest.content === snapshot.content && latest.title === snapshot.title) {
        return prev;
      }
      return {
        ...prev,
        [docId]: [snapshot, ...prevList].slice(0, MAX_SNAPSHOTS_PER_DOC),
      };
    });

    if (reason === 'auto') {
      lastAutoSnapshotAtRef.current[docId] = Date.now();
    }
  };

  const restoreDocSnapshot = (docId: string, snapshotId: string) => {
    const snapshot = (docSnapshots[docId] || []).find(item => item.id === snapshotId);
    if (!snapshot) return;

    const currentDoc = documents.find(doc => doc.id === docId);
    if (currentDoc && (currentDoc.content !== snapshot.content || currentDoc.title !== snapshot.title)) {
      createDocSnapshot(docId, 'manual');
    }

    setDocuments(prev => prev.map(doc => (
      doc.id === docId
        ? { ...doc, title: snapshot.title, content: snapshot.content, updatedAt: new Date() }
        : doc
    )));
  };

  const deleteDocSnapshot = (docId: string, snapshotId: string) => {
    setDocSnapshots(prev => {
      const nextList = (prev[docId] || []).filter(snapshot => snapshot.id !== snapshotId);
      if (nextList.length === 0) {
        const { [docId]: _, ...rest } = prev;
        return rest;
      }
      return {
        ...prev,
        [docId]: nextList
      };
    });
  };

  const handleCreateDoc = (parentId: string | null = null, initialData?: { title?: string, content?: string }) => {
    const newDoc: Document = {
      id: crypto.randomUUID(),
      title: initialData?.title || '无标题',
      content: initialData?.content || '',
      updatedAt: new Date(),
      parentId: parentId,
      isFavorite: false,
      isDeleted: false,
    };
    setDocuments(prev => [newDoc, ...prev]);
    setActiveDocId(newDoc.id);
    setActiveWorkspaceView('document');
    if (!isSidebarOpen) setIsSidebarOpen(true);
  };

  const handleUpdateDoc = (id: string, updates: Partial<Document>) => {
    setDocuments(docs => docs.map(d => d.id === id ? { ...d, ...updates, updatedAt: new Date() } : d));
  };

  useEffect(() => {
    if (!isSnapshotScanInitializedRef.current) {
      previousDocContentRef.current = Object.fromEntries(
        documents.map(doc => [doc.id, doc.content || ''])
      );
      const now = Date.now();
      lastAutoSnapshotAtRef.current = Object.fromEntries(
        documents.map(doc => [doc.id, now])
      );
      isSnapshotScanInitializedRef.current = true;
      return;
    }

    const now = Date.now();
    const contentById = previousDocContentRef.current;
    const docIds = new Set(documents.map(doc => doc.id));

    for (const doc of documents) {
      const previousContent = contentById[doc.id] || '';
      const currentContent = doc.content || '';
      const hasContentChanged = previousContent !== currentContent;
      const changeSize = Math.abs(currentContent.length - previousContent.length);
      const lastSnapshotAt = lastAutoSnapshotAtRef.current[doc.id] || 0;
      const shouldSnapshot = hasContentChanged &&
        changeSize >= AUTO_SNAPSHOT_MIN_DIFF &&
        now - lastSnapshotAt >= AUTO_SNAPSHOT_INTERVAL_MS;

      if (shouldSnapshot) {
        createDocSnapshot(doc.id, 'auto');
      }

      contentById[doc.id] = currentContent;
    }

    for (const existingId of Object.keys(contentById)) {
      if (!docIds.has(existingId)) {
        delete contentById[existingId];
        delete lastAutoSnapshotAtRef.current[existingId];
      }
    }
  }, [documents]);

  const handleDeleteDoc = (id: string) => {
    // 逻辑删除：移入废纸篓
    setDocuments(docs => docs.map(d => d.id === id ? { ...d, isDeleted: true, updatedAt: new Date() } : d));
  };

  const handleRestoreDoc = (id: string) => {
    setDocuments(docs => docs.map(d => d.id === id ? { ...d, isDeleted: false, updatedAt: new Date() } : d));
  };

  const handlePermanentDeleteDoc = (id: string) => {
    // 彻底删除
    setDocuments(docs => {
      const childrenByParent = new Map<string, string[]>();
      for (const doc of docs) {
        if (!doc.parentId) continue;
        const siblings = childrenByParent.get(doc.parentId) || [];
        siblings.push(doc.id);
        childrenByParent.set(doc.parentId, siblings);
      }

      const toDelete = new Set<string>();
      const stack = [id];
      while (stack.length > 0) {
        const currentId = stack.pop() as string;
        if (toDelete.has(currentId)) continue;
        toDelete.add(currentId);

        const children = childrenByParent.get(currentId) || [];
        for (const childId of children) {
          if (!toDelete.has(childId)) {
            stack.push(childId);
          }
        }
      }

      setDocSnapshots(prev => {
        let changed = false;
        const next: Record<string, DocumentSnapshot[]> = {};
        for (const [docId, snapshots] of Object.entries(prev)) {
          if (toDelete.has(docId)) {
            changed = true;
            continue;
          }
          next[docId] = snapshots;
        }
        return changed ? next : prev;
      });
      
      const newDocs = docs.filter(d => !toDelete.has(d.id));
      if (activeDocId && toDelete.has(activeDocId)) {
        setActiveDocId(null);
      }
      return newDocs;
    });
  };

  const handleToggleFavorite = (id: string) => {
    setDocuments(docs => docs.map(d => d.id === id ? { ...d, isFavorite: !d.isFavorite, updatedAt: new Date() } : d));
  };

  const handleToggleKnowledgeBase = (id: string) => {
    setDocuments(docs => docs.map(d => d.id === id ? { ...d, isInKnowledgeBase: !d.isInKnowledgeBase, updatedAt: new Date() } : d));
  };

  const handleImportFile = async (file: File) => {
    try {
      const imported = await importFileToDocument(file);
      const newDoc: Document = {
        id: crypto.randomUUID(),
        title: imported.title,
        content: imported.content,
        fontFamily: '"SimSun", "STSong", serif',
        updatedAt: new Date(),
        isFavorite: false,
        isDeleted: false,
        parentId: null
      };
      setDocuments(prev => [newDoc, ...prev]);
      setActiveDocId(newDoc.id);
      setActiveWorkspaceView('document');
    } catch (error) {
      console.error('Failed to import file:', error);
      const message = error instanceof Error ? error.message : '文件导入失败，请稍后重试。';
      alert(message);
    }
  };

  const handleAddSkill = (skill: Skill) => {
    const incomingName = skill.name.trim().toLowerCase();
    const incomingPrompt = skill.prompt.trim();
    setSkills(prev => {
      const exists = prev.some(item => (
        item.id === skill.id ||
        (item.name.trim().toLowerCase() === incomingName && item.prompt.trim() === incomingPrompt)
      ));
      if (exists) return prev;
      return [...prev, skill];
    });
  };

  const handleDeleteSkill = (id: string) => {
    setSkills(prev => prev.filter(s => s.id !== id));
  };

  const handleCheckMigration = () => {
    void checkMigration();
  };

  const handleResolveMigration = (strategy: 'local' | 'server') => {
    void resolveMigration(strategy);
  };

  const emitSidebarCommand = (eventName: string) => {
    if (!isSidebarOpen) {
      setIsSidebarOpen(true);
    }
    window.dispatchEvent(new CustomEvent(eventName));
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className={`flex h-screen w-full bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100 font-sans overflow-hidden ${isResizingSidebar ? 'cursor-col-resize select-none' : ''}`}>
      {/* 边缘唤出检测区域 - 增加宽度到 12px 以提高感应灵敏度 */}
      {!isSidebarOpen && (
        <div 
          className="fixed left-0 top-0 w-3 h-full z-[40] transition-all" 
          onMouseEnter={handleMouseEnterPeek}
        />
      )}

      {/* 自动吸附唤出的迷你窗口 (Peek Sidebar) */}
      {isPeekOpen && !isSidebarOpen && (
        <div 
          className="fixed left-0 top-0 bottom-0 w-[280px] z-[100] flex items-center pl-3 pointer-events-none"
          onMouseEnter={handleMouseEnterPeek}
          onMouseLeave={handleMouseLeavePeek}
        >
          <div className="w-64 h-[calc(100%-24px)] bg-[#f7f7f5] dark:bg-zinc-900 rounded-2xl shadow-[0_0_50px_-12px_rgba(0,0,0,0.3)] border border-zinc-200 dark:border-zinc-800 overflow-hidden ring-1 ring-black/5 dark:ring-white/10 animate-in fade-in slide-in-from-left-2 duration-300 ease-out pointer-events-auto">
            <Sidebar 
              documents={documents} 
              activeDocId={activeDocId} 
              onSelectDoc={(id) => { handleSelectDoc(id); setIsPeekOpen(false); }} 
              onCreateDoc={(parentId, initialData) => { handleCreateDoc(parentId ?? null, initialData); setIsPeekOpen(false); }}
            onDeleteDoc={handleDeleteDoc}
            onRestoreDoc={handleRestoreDoc}
            onPermanentDeleteDoc={handlePermanentDeleteDoc}
            onToggleFavorite={handleToggleFavorite}
            onToggleKnowledgeBase={handleToggleKnowledgeBase}
            onImportFile={(file) => { handleImportFile(file); setIsPeekOpen(false); }}
              settings={settings}
              onUpdateSettings={setSettings}
              theme={theme}
              onToggleTheme={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
              onCloseSidebar={() => setIsSidebarOpen(false)}
              isPeek={true}
              isAiWorkspaceActive={activeWorkspaceView === 'inspriation_ai'}
              onOpenAiWorkspace={() => {
                if (!isSidebarOpen) setIsSidebarOpen(true);
                setActiveWorkspaceView('inspriation_ai');
                setIsPeekOpen(false);
              }}
              onPin={() => {
                setIsSidebarOpen(true);
                setIsPeekOpen(false);
              }}
              migration={migrationState}
              onCheckMigration={handleCheckMigration}
              onResolveMigration={handleResolveMigration}
            />
          </div>
        </div>
      )}

      <aside 
        style={{ width: isSidebarOpen ? `${sidebarWidth}px` : '0px' }}
        className={`flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 relative group z-30 ${isResizingSidebar ? '' : 'transition-[width] duration-300 ease-in-out'}`}
      >
        <div className="w-full h-full overflow-hidden">
          <Sidebar 
            documents={documents} 
            activeDocId={activeDocId} 
            onSelectDoc={handleSelectDoc} 
            onCreateDoc={(parentId, initialData) => handleCreateDoc(parentId ?? null, initialData)}
            onDeleteDoc={handleDeleteDoc}
            onRestoreDoc={handleRestoreDoc}
            onPermanentDeleteDoc={handlePermanentDeleteDoc}
            onToggleFavorite={handleToggleFavorite}
            onToggleKnowledgeBase={handleToggleKnowledgeBase}
            onImportFile={handleImportFile}
            settings={settings}
            onUpdateSettings={setSettings}
            theme={theme}
            onToggleTheme={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
            onCloseSidebar={() => setIsSidebarOpen(false)}
            isAiWorkspaceActive={activeWorkspaceView === 'inspriation_ai'}
            onOpenAiWorkspace={() => setActiveWorkspaceView('inspriation_ai')}
            migration={migrationState}
            onCheckMigration={handleCheckMigration}
            onResolveMigration={handleResolveMigration}
          />
        </div>
        {/* Resize Handle for Left Sidebar */}
        <div 
          onMouseDown={startResizingSidebar}
          className={`absolute top-0 -right-[1.5px] w-[3px] h-full cursor-col-resize hover:bg-purple-500/50 transition-all z-50 group-hover:w-[4px] ${isResizingSidebar ? 'bg-purple-500/80 w-[4px]' : 'bg-transparent'}`}
        >
          <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[1.5px] h-8 bg-zinc-300 dark:bg-zinc-600 rounded-full transition-opacity ${isResizingSidebar ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} />
        </div>
      </aside>
      <main className={`flex-1 flex flex-col relative overflow-hidden bg-white dark:bg-zinc-900 ${isResizingSidebar ? 'pointer-events-none' : ''}`}>
        {!isSidebarOpen && !isPeekOpen && (
          <div className="absolute top-4 left-4 z-20">
            <button 
              onClick={() => setIsSidebarOpen(true)}
              className="p-2 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 rounded-lg transition-colors"
              title="Expand Sidebar"
            >
              <Menu className="w-5 h-5" />
            </button>
          </div>
        )}
        {activeWorkspaceView === 'inspriation_ai' ? (
          <AIWorkflowStudio
            documents={documents}
            activeDocId={activeDocId}
            onSelectDoc={handleSelectDoc}
            onCreateDoc={(parentId, initialData) => handleCreateDoc(parentId ?? null, initialData)}
            onUpdateDoc={handleUpdateDoc}
            onOpenDocumentArea={() => setActiveWorkspaceView('document')}
            settings={settings}
            skills={skills}
            onAddSkill={handleAddSkill}
            onDeleteSkill={handleDeleteSkill}
          />
        ) : activeDoc ? (
            <Editor 
              doc={activeDoc} 
              documents={documents}
              onUpdate={handleUpdateDoc} 
              onCreateDoc={handleCreateDoc}
              settings={settings}
              snapshots={docSnapshots[activeDoc.id] || []}
              onCreateSnapshot={() => createDocSnapshot(activeDoc.id, 'manual')}
              onRestoreSnapshot={(snapshotId) => restoreDocSnapshot(activeDoc.id, snapshotId)}
              onDeleteSnapshot={(snapshotId) => deleteDocSnapshot(activeDoc.id, snapshotId)}
              skills={skills}
            />
        ) : (
          <div className="flex-1 flex items-center justify-center text-zinc-400 dark:text-zinc-600">
            选择或创建一个文档开始
          </div>
        )}
      </main>
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        documents={documents}
        theme={theme}
        onClose={() => setIsCommandPaletteOpen(false)}
        onSelectDoc={(id) => {
          handleSelectDoc(id);
          if (!isSidebarOpen) setIsSidebarOpen(true);
        }}
        onCreateDoc={() => handleCreateDoc(null)}
        onOpenSearch={() => emitSidebarCommand('sidebar-open-search')}
        onOpenLibrary={() => emitSidebarCommand('sidebar-open-library')}
        onOpenKnowledgeBase={() => emitSidebarCommand('sidebar-open-kb')}
        onOpenTrash={() => emitSidebarCommand('sidebar-open-trash')}
        onOpenSettings={() => emitSidebarCommand('sidebar-open-settings')}
        onToggleTheme={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
      />
    </div>
  );
}
