import { useRef, useState } from 'react';
import { X, Plus, Trash2, Import, Check, AlertCircle, Files } from 'lucide-react';
import { Skill, DEFAULT_SKILLS, WorkflowScope, WorkflowOutput, WorkflowCadence, WorkflowRisk } from '../types/skill';
import { parseSkillsFromFile, parseSkillsFromText } from '../utils/skillImport';

type SkillsManagerProps = {
  isOpen: boolean;
  onClose: () => void;
  skills: Skill[];
  onAddSkill: (skill: Skill) => void;
  onDeleteSkill: (id: string) => void;
};

export default function SkillsManager({ isOpen, onClose, skills, onAddSkill, onDeleteSkill }: SkillsManagerProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [showImportForm, setShowImportForm] = useState(false);
  const [importContent, setImportContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Form state
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [newScope, setNewScope] = useState<WorkflowScope>('current_doc');
  const [newOutput, setNewOutput] = useState<WorkflowOutput>('plan');
  const [newCadence, setNewCadence] = useState<WorkflowCadence>('manual');
  const [newRisk, setNewRisk] = useState<WorkflowRisk>('low');

  if (!isOpen) return null;

  const isDefaultSkill = (id: string) => DEFAULT_SKILLS.some(s => s.id === id);

  const handleSaveNewSkill = () => {
    if (!newName.trim() || !newPrompt.trim()) {
      setError('名称和提示词不能为空');
      return;
    }
    const newSkill: Skill = {
      id: `custom_${Date.now()}`,
      name: newName.trim(),
      description: newDesc.trim() || '自定义技能',
      prompt: newPrompt.trim(),
      scope: newScope,
      output: newOutput,
      cadence: newCadence,
      risk: newRisk
    };
    onAddSkill(newSkill);
    setShowAddForm(false);
    resetForm();
    setNotice(`已创建技能：${newSkill.name}`);
  };

  const applyImportedSkills = (incomingSkills: Skill[], sourceLabel: string) => {
    const existingIdSet = new Set(skills.map(item => item.id));
    const existingSignatureSet = new Set(skills.map(item => `${item.name}::${item.prompt}`));
    let added = 0;
    let skipped = 0;

    incomingSkills.forEach((skill, index) => {
      const signature = `${skill.name}::${skill.prompt}`;
      if (existingSignatureSet.has(signature)) {
        skipped += 1;
        return;
      }

      let finalId = skill.id || `imported_${Date.now()}_${index}`;
      while (existingIdSet.has(finalId)) {
        finalId = `${finalId}_${Math.random().toString(36).slice(2, 6)}`;
      }

      const normalized: Skill = {
        ...skill,
        id: finalId,
        description: skill.description || '导入技能'
      };

      onAddSkill(normalized);
      existingIdSet.add(finalId);
      existingSignatureSet.add(signature);
      added += 1;
    });

    if (added > 0) {
      const summary = skipped > 0
        ? `${sourceLabel}成功：新增 ${added} 个，跳过 ${skipped} 个重复技能`
        : `${sourceLabel}成功：新增 ${added} 个技能`;
      setNotice(summary);
      setError(null);
    } else {
      setNotice(null);
      setError(`${sourceLabel}未新增技能（可能全部重复）`);
    }
  };

  const handleImportFromText = () => {
    try {
      const parsedSkills = parseSkillsFromText(importContent);
      applyImportedSkills(parsedSkills, '文本导入');
      setImportContent('');
      setShowImportForm(false);
    } catch (e: any) {
      setNotice(null);
      setError(`导入失败: ${e.message}`);
    }
  };

  const handleImportFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;

    const allSkills: Skill[] = [];
    const fileErrors: string[] = [];

    for (const file of Array.from(fileList)) {
      try {
        const parsed = await parseSkillsFromFile(file);
        allSkills.push(...parsed);
      } catch (e: any) {
        fileErrors.push(e?.message || `${file.name} 导入失败`);
      }
    }

    if (allSkills.length > 0) {
      applyImportedSkills(allSkills, '文件导入');
      setShowImportForm(false);
    } else {
      setNotice(null);
      setError(fileErrors.join('；') || '未读取到可导入技能');
    }

    if (fileErrors.length > 0) {
      const message = fileErrors.join('；');
      setError(prev => (prev ? `${prev}；${message}` : message));
    }
  };

  const resetForm = () => {
    setNewName('');
    setNewDesc('');
    setNewPrompt('');
    setNewScope('current_doc');
    setNewOutput('plan');
    setNewCadence('manual');
    setNewRisk('low');
    setError(null);
    setNotice(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
        <div className="mb-6 flex items-center justify-between border-b border-zinc-800 pb-4">
          <h2 className="text-xl font-semibold text-zinc-100">技能管理 (Skills)</h2>
          <button onClick={onClose} className="rounded-full p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-rose-500/10 p-3 text-sm text-rose-200">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}
        {notice && (
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-200">
            <Check className="h-4 w-4" />
            {notice}
          </div>
        )}

        {!showAddForm && !showImportForm ? (
          <div className="space-y-4">
            <div className="flex gap-2">
              <button
                onClick={() => setShowAddForm(true)}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
              >
                <Plus className="h-4 w-4" /> 新建技能
              </button>
              <button
                onClick={() => setShowImportForm(true)}
                className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-700"
              >
                <Import className="h-4 w-4" /> 导入技能
              </button>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-medium text-zinc-200">技能目录（可删减）</div>
                <div className="text-xs text-zinc-500">共 {skills.length} 项</div>
              </div>
            <div className="max-h-[400px] space-y-2 overflow-y-auto pr-2 custom-scrollbar">
              {skills.map(skill => (
                <div key={skill.id} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                  <div>
                    <div className="font-medium text-zinc-200">{skill.name}</div>
                    <div className="text-xs text-zinc-500">{skill.description}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isDefaultSkill(skill.id) && <span className="text-xs text-zinc-600">系统预设</span>}
                    <button
                      onClick={() => onDeleteSkill(skill.id)}
                      className="rounded-lg p-2 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-400"
                      title="删除技能"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
              {skills.length === 0 && (
                <div className="rounded-lg border border-dashed border-zinc-700 p-4 text-center text-xs text-zinc-500">
                  当前没有技能，点击“导入技能”或“新建技能”开始配置。
                </div>
              )}
            </div>
            </div>
          </div>
        ) : showAddForm ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs text-zinc-400">技能名称</label>
                <input
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-blue-500"
                  placeholder="例如：周报生成器"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-zinc-400">描述</label>
                <input
                  value={newDesc}
                  onChange={e => setNewDesc(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-blue-500"
                  placeholder="简短描述功能"
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-zinc-400">提示词 (Prompt)</label>
              <textarea
                value={newPrompt}
                onChange={e => setNewPrompt(e.target.value)}
                rows={4}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-blue-500"
                placeholder="输入给 AI 的完整指令..."
              />
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="space-y-1">
                <label className="text-xs text-zinc-400">作用范围</label>
                <select
                  value={newScope}
                  onChange={e => setNewScope(e.target.value as WorkflowScope)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-zinc-200 outline-none"
                >
                  <option value="current_doc">当前页面</option>
                  <option value="new_page">新页面</option>
                  <option value="knowledge_base">知识库</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-zinc-400">输出类型</label>
                <select
                  value={newOutput}
                  onChange={e => setNewOutput(e.target.value as WorkflowOutput)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-zinc-200 outline-none"
                >
                  <option value="plan">计划/拆解</option>
                  <option value="rewrite">重写/润色</option>
                  <option value="translate">翻译</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => {
                  setShowAddForm(false);
                  resetForm();
                }}
                className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200"
              >
                取消
              </button>
              <button
                onClick={handleSaveNewSkill}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
              >
                保存技能
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-xs text-zinc-400">粘贴 JSON 或 Markdown 配置</label>
              <textarea
                value={importContent}
                onChange={e => setImportContent(e.target.value)}
                rows={6}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs font-mono text-zinc-200 outline-none focus:border-blue-500"
                placeholder={'JSON: {"name":"...", "prompt":"..."}\n或 Markdown: # 技能名\\n这里写提示词'}
              />
            </div>
            <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-900/40 p-3">
              <div className="mb-2 text-xs text-zinc-400">文件导入：支持 .json / .md，可一次选择多个文件。</div>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
              >
                <Files className="h-4 w-4" />
                一键导入多文件
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".json,.md,.markdown,application/json,text/markdown,text/plain"
                className="hidden"
                onChange={async (event) => {
                  await handleImportFiles(event.target.files);
                  event.target.value = '';
                }}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => {
                  setShowImportForm(false);
                  setImportContent('');
                  setError(null);
                  setNotice(null);
                }}
                className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200"
              >
                取消
              </button>
              <button
                onClick={handleImportFromText}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
              >
                确认导入
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
