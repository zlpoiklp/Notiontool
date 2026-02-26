import { useState, useRef, useEffect } from 'react';
import { Sparkles, X, Loader2, Send, AlignLeft, Languages, ListTree, CheckCircle } from 'lucide-react';
import { Document } from '../App';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { textToSafeHtml } from '../utils/safeHtml';

type AIAssistantSidebarProps = {
  doc: Document;
  onUpdate: (id: string, updates: Partial<Document>) => void;
  settings: any;
  isOpen: boolean;
  onClose: () => void;
};

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

export default function AIAssistantSidebar({ doc, onUpdate, settings, isOpen, onClose }: AIAssistantSidebarProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const callApi = async (systemInstruction: string, userPrompt: string) => {
    if (settings.apiProvider === 'gemini' || !settings.apiUrl || !settings.apiKey) {
      const apiKey = settings.apiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('未配置 API Key');
      
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ 
        model: 'gemini-1.5-flash',
        systemInstruction: systemInstruction
      });
      const result = await model.generateContent(userPrompt);
      return result.response.text() || "";
    } else {
      const response = await fetch(`${settings.apiUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify({
          model: settings.selectedModel || 'default',
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: userPrompt }
          ]
        })
      });
      
      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }
      
      const data = await response.json();
      return data.choices[0]?.message?.content || "";
    }
  };

  const handleAction = async (action: string, prompt?: string) => {
    if (!doc.content.trim()) return;
    
    setIsProcessing(true);
    
    let userMessage = prompt || "";
    if (action === 'summarize') userMessage = "总结此页面";
    else if (action === 'translate') userMessage = "翻译此页面";
    else if (action === 'analyze') userMessage = "深度剖析";
    else if (action === 'tasks') userMessage = "创建任务跟踪器";

    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', content: userMessage }]);

    try {
      const systemInstruction = `You are an AI assistant helping the user with their document.
Rules:
1) Always reply in Chinese.
2) Keep scope tight: only handle the request explicitly asked by the user.
3) If context is insufficient, ask one focused follow-up question.
4) Never fabricate facts or references. If uncertain, state uncertainty clearly.
5) Prefer concise and actionable output.
6) Use Markdown with this structure when applicable:
   ### 结论
   ### 关键依据
   ### 下一步建议`;
      let userPrompt = `Here is the document content:\n\n${doc.content}\n\n`;
      
      if (action === 'summarize') {
        userPrompt += "Please provide a concise summary of this document.";
      } else if (action === 'translate') {
        userPrompt += "Please translate this document to Chinese (if it's in English) or English (if it's in Chinese).";
      } else if (action === 'analyze') {
        userPrompt += "Please provide a deep analysis of this document, including key points, tone, and main arguments.";
      } else if (action === 'tasks') {
        userPrompt += "Please extract actionable tasks from this document and create a task tracker list.";
      } else if (prompt) {
        userPrompt += `User request: ${prompt}`;
      }

      const resultText = await callApi(systemInstruction, userPrompt);
      
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: resultText }]);
    } catch (error) {
      console.error("AI Error:", error);
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: "处理请求时发生错误。" }]);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;
    handleAction('custom', inputValue);
    setInputValue('');
  };

  if (!isOpen) return null;

  return (
    <div className="w-80 border-l border-zinc-200 bg-[#f7f7f5] flex flex-col h-full flex-shrink-0 shadow-[-4px_0_24px_rgba(0,0,0,0.02)] z-10">
      <div className="p-4 border-b border-zinc-200 flex items-center justify-between bg-white">
        <div className="flex items-center gap-2 font-medium text-zinc-800">
          <Sparkles className="w-4 h-4 text-purple-500" />
          新建 AI 对话
        </div>
        <button onClick={onClose} className="p-1 text-zinc-400 hover:text-zinc-600 rounded-md hover:bg-zinc-100 transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-white border border-zinc-200 flex items-center justify-center shadow-sm">
                <Sparkles className="w-4 h-4 text-purple-500" />
              </div>
              <div className="font-medium text-zinc-800">今日事，我来帮。</div>
            </div>
            
            <div className="space-y-1">
              <button onClick={() => handleAction('summarize')} className="w-full flex items-center gap-3 px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-200/50 rounded-lg transition-colors text-left">
                <AlignLeft className="w-4 h-4 text-zinc-400" />
                总结此页面
              </button>
              <button onClick={() => handleAction('translate')} className="w-full flex items-center gap-3 px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-200/50 rounded-lg transition-colors text-left">
                <Languages className="w-4 h-4 text-zinc-400" />
                翻译此页面
              </button>
              <button onClick={() => handleAction('analyze')} className="w-full flex items-center gap-3 px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-200/50 rounded-lg transition-colors text-left">
                <ListTree className="w-4 h-4 text-zinc-400" />
                深度剖析
              </button>
              <button onClick={() => handleAction('tasks')} className="w-full flex items-center gap-3 px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-200/50 rounded-lg transition-colors text-left">
                <CheckCircle className="w-4 h-4 text-zinc-400" />
                创建任务跟踪器
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map(msg => (
              <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === 'user' ? 'bg-purple-100 text-purple-600' : 'bg-white border border-zinc-200 shadow-sm'}`}>
                  {msg.role === 'user' ? 'U' : <Sparkles className="w-4 h-4 text-purple-500" />}
                </div>
                <div className={`px-4 py-2 rounded-2xl max-w-[80%] text-sm ${msg.role === 'user' ? 'bg-purple-600 text-white rounded-tr-none' : 'bg-white border border-zinc-200 rounded-tl-none text-zinc-800 prose prose-sm prose-zinc'}`}>
                  {msg.role === 'user' ? msg.content : <div dangerouslySetInnerHTML={{ __html: textToSafeHtml(msg.content) }} />}
                </div>
              </div>
            ))}
            {isProcessing && (
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-white border border-zinc-200 flex items-center justify-center shadow-sm">
                  <Loader2 className="w-4 h-4 text-purple-500 animate-spin" />
                </div>
                <div className="px-4 py-2 rounded-2xl bg-white border border-zinc-200 rounded-tl-none text-sm text-zinc-500 flex items-center">
                  思考中...
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <div className="p-4 bg-white border-t border-zinc-200">
        <form onSubmit={handleSubmit} className="relative">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="使用 AI 处理各种任务..."
            className="w-full pl-4 pr-10 py-3 bg-zinc-100 border-transparent focus:bg-white border focus:border-purple-500 rounded-xl text-sm outline-none transition-all shadow-sm"
            disabled={isProcessing}
          />
          <button 
            type="submit"
            disabled={!inputValue.trim() || isProcessing}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-purple-600 hover:bg-purple-50 rounded-lg disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
