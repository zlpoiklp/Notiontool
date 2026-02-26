import { useEditor, EditorContent } from '@tiptap/react';
import { BubbleMenu, FloatingMenu } from '@tiptap/react/menus';
import type { Editor as TiptapCoreEditor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import Youtube from '@tiptap/extension-youtube';
import Link from '@tiptap/extension-link';
import { Bold, Italic, Underline as UnderlineIcon, Strikethrough, Highlighter, Palette, AlignLeft, AlignCenter, AlignRight, Heading1, Heading2, Heading3, List, ListOrdered, Quote, Table as TableIcon, Plus, Trash2, CheckSquare, MessageSquare, Check, Image as ImageIcon, Video, Music, Code as CodeIcon, Paperclip, Bookmark, Loader2, Sparkles } from 'lucide-react';
import { useEffect, useState, useRef } from 'react';

type TiptapEditorProps = {
  content: string;
  onChange: (content: string) => void;
  onAskAi?: (selection: string) => void;
  placeholder?: string;
  isReadOnly?: boolean;
  fontFamily?: string;
  completionText?: string;
  isGettingCompletion?: boolean;
  onAcceptCompletion?: () => void;
  onDismissCompletion?: () => void;
};

const COLORS = [
  '#000000', // Black
  '#ef4444', // Red-500
  '#f97316', // Orange-500
  '#eab308', // Yellow-500
  '#22c55e', // Green-500
  '#3b82f6', // Blue-500
  '#a855f7', // Purple-500
  '#ec4899'  // Pink-500
];

const HIGHLIGHTS = [
  '#ffffff', // Default/White
  '#fee2e2', // Red-100
  '#ffedd5', // Orange-100
  '#fef08a', // Yellow-100
  '#dcfce7', // Green-100
  '#dbeafe', // Blue-100
  '#f3e8ff', // Purple-100
  '#fce7f3'  // Pink-100
];

export default function TiptapEditor({
  content,
  onChange,
  onAskAi,
  placeholder = "Press '/' for commands, or start typing...",
  isReadOnly = false,
  fontFamily,
  completionText = '',
  isGettingCompletion = false,
  onAcceptCompletion,
  onDismissCompletion
}: TiptapEditorProps) {
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showHighlightPicker, setShowHighlightPicker] = useState(false);
  const [plusButtonPos, setPlusButtonPos] = useState<{ top: number, show: boolean }>({ top: 0, show: false });
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, show: boolean }>({ x: 0, y: 0, show: false });
  const [ghostPosition, setGhostPosition] = useState<{ top: number, left: number, maxWidth: number, visible: boolean, placement: 'above' | 'below' }>({
    top: 0,
    left: 0,
    maxWidth: 220,
    visible: false,
    placement: 'below'
  });

  const [lastContent, setLastContent] = useState(content);
  const completionTextRef = useRef(completionText);
  const isGettingCompletionRef = useRef(isGettingCompletion);
  const isReadOnlyRef = useRef(isReadOnly);
  const onAcceptCompletionRef = useRef(onAcceptCompletion);
  const onDismissCompletionRef = useRef(onDismissCompletion);

  useEffect(() => {
    completionTextRef.current = completionText;
  }, [completionText]);

  useEffect(() => {
    isGettingCompletionRef.current = isGettingCompletion;
  }, [isGettingCompletion]);

  useEffect(() => {
    isReadOnlyRef.current = isReadOnly;
  }, [isReadOnly]);

  useEffect(() => {
    onAcceptCompletionRef.current = onAcceptCompletion;
  }, [onAcceptCompletion]);

  useEffect(() => {
    onDismissCompletionRef.current = onDismissCompletion;
  }, [onDismissCompletion]);

  const hideGhostSuggestion = () => {
    setGhostPosition(prev => prev.visible ? { ...prev, visible: false } : prev);
  };

  const updateGhostSuggestionPosition = (activeEditor: TiptapCoreEditor | null) => {
    if (!activeEditor || isReadOnlyRef.current) {
      hideGhostSuggestion();
      return;
    }

    const activeCompletion = completionTextRef.current;
    const loading = isGettingCompletionRef.current;
    if ((!activeCompletion && !loading) || !activeEditor.isFocused) {
      hideGhostSuggestion();
      return;
    }

    const { selection } = activeEditor.state;
    if (!selection.empty) {
      hideGhostSuggestion();
      return;
    }

    const wrapper = activeEditor.view.dom.closest('.tiptap-wrapper') as HTMLElement | null;
    if (!wrapper) {
      hideGhostSuggestion();
      return;
    }

    let caret: { top: number, left: number, bottom: number };
    try {
      caret = activeEditor.view.coordsAtPos(selection.from);
    } catch {
      hideGhostSuggestion();
      return;
    }

    const wrapperRect = wrapper.getBoundingClientRect();
    if (!Number.isFinite(wrapperRect.width) || wrapperRect.width <= 0) {
      hideGhostSuggestion();
      return;
    }

    const rawLeft = caret.left - wrapperRect.left;
    const maxWidth = Math.min(360, Math.max(180, wrapperRect.width - 16));
    const left = Math.max(8, Math.min(rawLeft, Math.max(8, wrapperRect.width - maxWidth - 8)));
    const completionForLayout = completionTextRef.current;
    const estimatedCardHeight = completionForLayout ? 88 : 60;
    const belowTop = caret.bottom - wrapperRect.top + 8;
    const canPlaceBelow = belowTop + estimatedCardHeight <= wrapperRect.height - 8;
    const placement: 'above' | 'below' = canPlaceBelow ? 'below' : 'above';
    const top = canPlaceBelow
      ? belowTop
      : Math.max(6, caret.top - wrapperRect.top - estimatedCardHeight - 8);
    setGhostPosition(prev => {
      if (
        prev.visible &&
        Math.abs(prev.top - top) < 0.5 &&
        Math.abs(prev.left - left) < 0.5 &&
        Math.abs(prev.maxWidth - maxWidth) < 0.5 &&
        prev.placement === placement
      ) {
        return prev;
      }
      return { top, left, maxWidth, visible: true, placement };
    });
  };

  const handleInsertImage = () => {
    const url = window.prompt('请输入图片链接 (URL):');
    if (url) editor?.chain().focus().setImage({ src: url }).run();
    setContextMenu(prev => ({ ...prev, show: false }));
    setShowPlusMenu(false);
  };

  const handleInsertVideo = () => {
    const url = window.prompt('请输入视频链接 (Youtube/Vimeo):');
    if (url) editor?.chain().focus().setYoutubeVideo({ src: url }).run();
    setContextMenu(prev => ({ ...prev, show: false }));
    setShowPlusMenu(false);
  };

  const handleInsertAudio = () => {
    const url = window.prompt('请输入音频链接:');
    if (url) {
      editor?.chain().focus().insertContent(`<audio controls class="w-full my-4"><source src="${url}" type="audio/mpeg">您的浏览器不支持音频播放。</audio>`).run();
    }
    setContextMenu(prev => ({ ...prev, show: false }));
    setShowPlusMenu(false);
  };

  const handleInsertCode = () => {
    editor?.chain().focus().toggleCodeBlock().run();
    setContextMenu(prev => ({ ...prev, show: false }));
    setShowPlusMenu(false);
  };

  const handleInsertFile = () => {
    const url = window.prompt('请输入文件直链:');
    const name = window.prompt('请输入文件名称:', '点击下载文件');
    if (url) {
      editor?.chain().focus().insertContent(`<div class="my-4"><a href="${url}" target="_blank" class="flex items-center gap-2 p-3 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl hover:bg-zinc-100 transition-all no-underline"><div class="p-2 bg-purple-100 dark:bg-purple-900/30 rounded-lg"><svg class="w-4 h-4 text-purple-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg></div><span class="text-sm font-medium text-zinc-700 dark:text-zinc-200">${name}</span></a></div>`).run();
    }
    setContextMenu(prev => ({ ...prev, show: false }));
    setShowPlusMenu(false);
  };

  const handleInsertBookmark = () => {
    const url = window.prompt('请输入网页链接:');
    if (url) {
      editor?.chain().focus().insertContent(`<div class="my-4 border border-zinc-200 dark:border-zinc-700 rounded-xl overflow-hidden flex bg-white dark:bg-zinc-800 hover:bg-zinc-50 transition-all cursor-pointer"><div class="flex-1 p-4 flex flex-col justify-center"><div class="text-sm font-bold text-zinc-800 dark:text-zinc-100 truncate">${url}</div><div class="text-xs text-zinc-400 mt-1">点击访问链接</div></div><div class="w-24 bg-zinc-100 dark:bg-zinc-700 flex items-center justify-center text-zinc-400"><svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"></path></svg></div></div>`).run();
    }
    setContextMenu(prev => ({ ...prev, show: false }));
    setShowPlusMenu(false);
  };

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder,
      }),
      Highlight.configure({ multicolor: true }),
      TextStyle,
      Color,
      Underline,
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      Table.configure({
        HTMLAttributes: {
          class: 'border-collapse table-auto w-full',
        },
      }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      Image.configure({
        HTMLAttributes: {
          class: 'rounded-lg border border-zinc-200 dark:border-zinc-800 shadow-sm max-w-full h-auto my-4',
        },
      }),
      Youtube.configure({
        width: 640,
        height: 480,
        HTMLAttributes: {
          class: 'rounded-xl overflow-hidden shadow-lg my-6 aspect-video w-full',
        },
      }),
      Link.configure({
        openOnClick: true,
        HTMLAttributes: {
          class: 'text-purple-600 hover:text-purple-700 underline underline-offset-4 decoration-purple-300',
        },
      }),
    ],
    editorProps: {
      handleDOMEvents: {
        contextmenu: (view, event) => {
          if (isReadOnly) return false;
          event.preventDefault();
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            show: true
          });
          return true;
        },
        mousedown: (view, event) => {
          if (contextMenu.show) {
            setContextMenu(prev => ({ ...prev, show: false }));
          }
          return false;
        },
        blur: () => {
          hideGhostSuggestion();
          return false;
        }
      },
      handleKeyDown: (view, event) => {
        if (isReadOnly) return false;
        const activeCompletion = completionTextRef.current;

        if (event.key === 'Tab' && activeCompletion) {
          event.preventDefault();
          const { from, to } = view.state.selection;
          const previousChar = from > 0
            ? view.state.doc.textBetween(from - 1, from, '\n', '\0')
            : '';
          const normalizedCompletion = previousChar && !/\s/.test(previousChar) && !/^\s/.test(activeCompletion)
            ? ` ${activeCompletion}`
            : activeCompletion;

          view.dispatch(view.state.tr.insertText(normalizedCompletion, from, to));
          onAcceptCompletionRef.current?.();
          return true;
        }

        if (event.key === 'Escape' && activeCompletion) {
          event.preventDefault();
          onDismissCompletionRef.current?.();
          return true;
        }

        return false;
      },
      handlePaste: (view, event) => {
        const items = Array.from(event.clipboardData?.items || []);
        const imageItem = items.find(item => item.type.startsWith('image'));

        if (imageItem) {
          const file = imageItem.getAsFile();
          if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
              const src = e.target?.result as string;
              view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodes.image.create({ src })));
            };
            reader.readAsDataURL(file);
            return true; // 表示已处理粘贴
          }
        }
        return false;
      },
      handleDrop: (view, event) => {
        const files = Array.from(event.dataTransfer?.files || []);
        const imageFiles = files.filter(file => file.type.startsWith('image'));

        if (imageFiles.length > 0) {
          event.preventDefault();
          imageFiles.forEach(file => {
            const reader = new FileReader();
            reader.onload = (e) => {
              const src = e.target?.result as string;
              const { schema } = view.state;
              const node = schema.nodes.image.create({ src });
              const transaction = view.state.tr.replaceSelectionWith(node);
              view.dispatch(transaction);
            };
            reader.readAsDataURL(file);
          });
          return true;
        }
        return false;
      }
    },
    content,
    editable: !isReadOnly,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      setLastContent(html);
      onChange(html);
    },
    onSelectionUpdate: ({ editor }) => {
      const { selection } = editor.state;
      const { $from } = selection;
      
      // 当光标在空段落时，显示左侧的 + 按钮
      if ($from.parent.type.name === 'paragraph' && $from.parent.content.size === 0) {
        const dom = editor.view.domAtPos($from.pos).node as HTMLElement;
        const rect = dom.getBoundingClientRect();
        const wrapperRect = dom.closest('.tiptap-wrapper')?.getBoundingClientRect();
        
        if (wrapperRect) {
          setPlusButtonPos({ 
            top: rect.top - wrapperRect.top, 
            show: true 
          });
          return;
        }
      }
      setPlusButtonPos(prev => ({ ...prev, show: false }));
      setShowPlusMenu(false);
      updateGhostSuggestionPosition(editor);
    },
  });

  useEffect(() => {
    if (editor) {
      editor.setEditable(!isReadOnly);
    }
  }, [isReadOnly, editor]);

  useEffect(() => {
    if (editor && content !== lastContent) {
      editor.commands.setContent(content, { emitUpdate: false });
      setLastContent(content);
    }
  }, [content, editor, lastContent]);

  useEffect(() => {
    updateGhostSuggestionPosition(editor);
  }, [editor, completionText, isGettingCompletion, isReadOnly]);

  useEffect(() => {
    if (!editor) return;
    const handleReposition = () => updateGhostSuggestionPosition(editor);
    window.addEventListener('resize', handleReposition);
    document.addEventListener('scroll', handleReposition, true);
    return () => {
      window.removeEventListener('resize', handleReposition);
      document.removeEventListener('scroll', handleReposition, true);
    };
  }, [editor, completionText, isGettingCompletion, isReadOnly]);

  if (!editor) {
    return null;
  }

  return (
    <div className="relative w-full h-full flex flex-col tiptap-wrapper" style={{ fontFamily }}>
      {editor && !isReadOnly && (
        <BubbleMenu 
          editor={editor} 
          pluginKey="bubbleMenuText" 
          shouldShow={({ state, from, to }) => {
            // 仅在有文本选中（from !== to）且不是在表格内时显示
            return from !== to && !editor.isActive('table');
          }}
          className="flex items-center gap-1 p-1 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-lg rounded-lg overflow-visible z-50"
        >
          <button
            onClick={() => editor.chain().focus().toggleBold().run()}
            className={`p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 ${editor.isActive('bold') ? 'bg-zinc-100 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-400'}`}
          >
            <Bold className="w-4 h-4" />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleItalic().run()}
            className={`p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 ${editor.isActive('italic') ? 'bg-zinc-100 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-400'}`}
          >
            <Italic className="w-4 h-4" />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            className={`p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 ${editor.isActive('underline') ? 'bg-zinc-100 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-400'}`}
          >
            <UnderlineIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleStrike().run()}
            className={`p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 ${editor.isActive('strike') ? 'bg-zinc-100 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-400'}`}
          >
            <Strikethrough className="w-4 h-4" />
          </button>
          
          <div className="w-px h-4 bg-zinc-200 dark:bg-zinc-700 mx-1" />

          {onAskAi && (
            <button
              onClick={() => {
                const { from, to } = editor.state.selection;
                const text = editor.state.doc.textBetween(from, to, ' ');
                if (text) onAskAi(text);
              }}
              className="p-1.5 rounded hover:bg-purple-100 dark:hover:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center gap-1"
              title="提问 AI"
            >
              <MessageSquare className="w-4 h-4" />
              <span className="text-[10px] font-bold">提问 AI</span>
            </button>
          )}
          
          <div className="w-px h-4 bg-zinc-200 dark:bg-zinc-700 mx-1" />
          
          <div className="relative">
            <button
              onClick={() => { setShowColorPicker(!showColorPicker); setShowHighlightPicker(false); }}
              className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400 flex items-center gap-1"
            >
              <Palette className="w-4 h-4" />
            </button>
            {showColorPicker && (
              <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-xl rounded-xl p-3 grid grid-cols-5 gap-2 z-[100] min-w-[160px] animate-in fade-in zoom-in duration-150">
                <div className="col-span-5 text-[10px] font-bold text-zinc-400 uppercase mb-1 px-1">文字颜色</div>
                {COLORS.map(color => (
                  <button
                    key={color}
                    className="w-6 h-6 rounded-full border border-zinc-200 dark:border-zinc-600 flex items-center justify-center transition-transform hover:scale-110 active:scale-95"
                    style={{ backgroundColor: color }}
                    onClick={() => {
                      editor.chain().focus().setColor(color).run();
                      setShowColorPicker(false);
                    }}
                  >
                    {editor.isActive('textStyle', { color }) && (
                      <Check className="w-3 h-3 text-white mix-blend-difference" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative">
            <button
              onClick={() => { setShowHighlightPicker(!showHighlightPicker); setShowColorPicker(false); }}
              className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400 flex items-center gap-1"
            >
              <Highlighter className="w-4 h-4" />
            </button>
            {showHighlightPicker && (
              <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-xl rounded-xl p-3 grid grid-cols-5 gap-2 z-[100] min-w-[160px] animate-in fade-in zoom-in duration-150">
                <div className="col-span-5 text-[10px] font-bold text-zinc-400 uppercase mb-1 px-1">背景高亮</div>
                {HIGHLIGHTS.map(color => (
                  <button
                    key={color}
                    className="w-6 h-6 rounded-full border border-zinc-200 dark:border-zinc-600 flex items-center justify-center transition-transform hover:scale-110 active:scale-95"
                    style={{ backgroundColor: color }}
                    onClick={() => {
                      editor.chain().focus().toggleHighlight({ color }).run();
                      setShowHighlightPicker(false);
                    }}
                  >
                    {editor.isActive('highlight', { color }) && (
                      <Check className="w-3 h-3 text-zinc-900 mix-blend-difference" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </BubbleMenu>
      )}

      {editor && !isReadOnly && (
        <div 
          className={`absolute -left-10 w-6 h-6 flex items-center justify-center transition-all duration-200 z-40 ${plusButtonPos.show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={{ top: `${plusButtonPos.top}px` }}
        >
          <button 
            onClick={() => setShowPlusMenu(!showPlusMenu)}
            className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
          >
            <Plus className="w-4 h-4" />
          </button>
          
          {showPlusMenu && (
            <div className="absolute left-full ml-2 top-0 bg-zinc-900 dark:bg-zinc-800 border border-zinc-800 dark:border-zinc-700 shadow-2xl rounded-xl p-1.5 flex flex-col min-w-[140px] animate-in fade-in slide-in-from-left-2 duration-200 z-50">
              <button 
                onClick={handleInsertImage} 
                className="flex items-center gap-3 px-3 py-2 text-zinc-300 hover:bg-zinc-800 dark:hover:bg-zinc-700 rounded-lg transition-all text-left"
              >
                <ImageIcon className="w-4 h-4" />
                <span className="text-xs font-medium">图片</span>
              </button>

              <button 
                onClick={handleInsertVideo} 
                className="flex items-center gap-3 px-3 py-2 text-zinc-300 hover:bg-zinc-800 dark:hover:bg-zinc-700 rounded-lg transition-all text-left"
              >
                <Video className="w-4 h-4" />
                <span className="text-xs font-medium">视频</span>
              </button>

              <button 
                onClick={handleInsertAudio} 
                className="flex items-center gap-3 px-3 py-2 text-zinc-300 hover:bg-zinc-800 dark:hover:bg-zinc-700 rounded-lg transition-all text-left"
              >
                <Music className="w-4 h-4" />
                <span className="text-xs font-medium">音频</span>
              </button>

              <button 
                onClick={handleInsertCode} 
                className="flex items-center gap-3 px-3 py-2 text-zinc-300 hover:bg-zinc-800 dark:hover:bg-zinc-700 rounded-lg transition-all text-left"
              >
                <CodeIcon className="w-4 h-4" />
                <span className="text-xs font-medium">代码</span>
              </button>

              <button 
                onClick={handleInsertFile} 
                className="flex items-center gap-3 px-3 py-2 text-zinc-300 hover:bg-zinc-800 dark:hover:bg-zinc-700 rounded-lg transition-all text-left"
              >
                <Paperclip className="w-4 h-4" />
                <span className="text-xs font-medium">文件</span>
              </button>

              <button 
                onClick={handleInsertBookmark} 
                className="flex items-center gap-3 px-3 py-2 text-zinc-300 hover:bg-zinc-800 dark:hover:bg-zinc-700 rounded-lg transition-all text-left"
              >
                <Bookmark className="w-4 h-4" />
                <span className="text-xs font-medium">网页书签</span>
              </button>
            </div>
          )}
        </div>
      )}

      {editor && editor.isActive('table') && !isReadOnly && (
        <BubbleMenu editor={editor} pluginKey="bubbleMenuTable" shouldShow={({ editor }) => editor.isActive('table')} className="flex items-center gap-1 p-1 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-lg rounded-lg z-50">
          <button onClick={() => editor.chain().focus().addColumnBefore().run()} className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400" title="在左侧添加列">
            <Plus className="w-3.5 h-3.5 rotate-90" />
          </button>
          <button onClick={() => editor.chain().focus().addColumnAfter().run()} className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400" title="在右侧添加列">
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => editor.chain().focus().deleteColumn().run()} className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 text-red-500" title="删除列">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-4 bg-zinc-200 dark:bg-zinc-700 mx-1" />
          <button onClick={() => editor.chain().focus().addRowBefore().run()} className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400" title="在上方添加行">
            <Plus className="w-3.5 h-3.5 rotate-180" />
          </button>
          <button onClick={() => editor.chain().focus().addRowAfter().run()} className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400" title="在下方添加行">
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => editor.chain().focus().deleteRow().run()} className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 text-red-500" title="删除行">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-4 bg-zinc-200 dark:bg-zinc-700 mx-1" />
          <button onClick={() => editor.chain().focus().deleteTable().run()} className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 text-red-600" title="删除表格">
            <TableIcon className="w-3.5 h-3.5" />
          </button>
        </BubbleMenu>
      )}

      <EditorContent editor={editor} className="flex-1 prose prose-zinc dark:prose-invert max-w-none prose-p:leading-relaxed prose-headings:font-semibold focus:outline-none" />

      {!isReadOnly && ghostPosition.visible && (completionText || isGettingCompletion) && (
        <div
          className="pointer-events-none absolute z-30"
          style={{
            top: `${ghostPosition.top}px`,
            left: `${ghostPosition.left}px`,
            width: `${ghostPosition.maxWidth}px`
          }}
        >
          <div className="relative rounded-xl border border-purple-200/80 dark:border-purple-800/70 bg-white/95 dark:bg-zinc-900/95 px-3 py-2 shadow-xl backdrop-blur-md">
            <div
              className={`absolute left-4 h-2.5 w-2.5 rotate-45 border-purple-200/80 dark:border-purple-800/70 bg-white/95 dark:bg-zinc-900/95 ${
                ghostPosition.placement === 'below'
                  ? '-top-[6px] border-l border-t'
                  : '-bottom-[6px] border-r border-b'
              }`}
            />

            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-purple-600 dark:text-purple-300">
              {isGettingCompletion ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              <span>{isGettingCompletion ? 'AI 正在补全' : 'AI 补全建议'}</span>
            </div>

            <div className="mt-1.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap break-words">
              {completionText || '正在分析上下文并生成候选内容...'}
            </div>

            <div className="mt-2 text-[10px] text-zinc-400 dark:text-zinc-500">
              Tab 采纳 · Esc 忽略
            </div>
          </div>
        </div>
      )}

      {/* Context Menu (Right Click) */}
      {contextMenu.show && (
        <div 
          className="fixed bg-zinc-900 dark:bg-zinc-800 border border-zinc-800 dark:border-zinc-700 shadow-2xl rounded-xl p-1.5 flex flex-col min-w-[160px] animate-in fade-in zoom-in-95 duration-150 z-[200]"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          <button onClick={handleInsertImage} className="flex items-center gap-3 px-3 py-2 text-zinc-300 hover:bg-zinc-800 dark:hover:bg-zinc-700 rounded-lg transition-all text-left">
            <ImageIcon className="w-4 h-4" />
            <span className="text-xs font-medium">图片</span>
          </button>
          <button onClick={handleInsertVideo} className="flex items-center gap-3 px-3 py-2 text-zinc-300 hover:bg-zinc-800 dark:hover:bg-zinc-700 rounded-lg transition-all text-left">
            <Video className="w-4 h-4" />
            <span className="text-xs font-medium">视频</span>
          </button>
          <button onClick={handleInsertAudio} className="flex items-center gap-3 px-3 py-2 text-zinc-300 hover:bg-zinc-800 dark:hover:bg-zinc-700 rounded-lg transition-all text-left">
            <Music className="w-4 h-4" />
            <span className="text-xs font-medium">音频</span>
          </button>
          <div className="h-px bg-zinc-800 my-1 mx-1" />
          <button onClick={handleInsertCode} className="flex items-center gap-3 px-3 py-2 text-zinc-300 hover:bg-zinc-800 dark:hover:bg-zinc-700 rounded-lg transition-all text-left">
            <CodeIcon className="w-4 h-4" />
            <span className="text-xs font-medium">代码块</span>
          </button>
          <button onClick={handleInsertFile} className="flex items-center gap-3 px-3 py-2 text-zinc-300 hover:bg-zinc-800 dark:hover:bg-zinc-700 rounded-lg transition-all text-left">
            <Paperclip className="w-4 h-4" />
            <span className="text-xs font-medium">文件附件</span>
          </button>
          <button onClick={handleInsertBookmark} className="flex items-center gap-3 px-3 py-2 text-zinc-300 hover:bg-zinc-800 dark:hover:bg-zinc-700 rounded-lg transition-all text-left">
            <Bookmark className="w-4 h-4" />
            <span className="text-xs font-medium">网页书签</span>
          </button>
        </div>
      )}
    </div>
  );
}
