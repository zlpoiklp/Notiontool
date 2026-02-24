# ✨ Notion AI Clone

一个基于 React + Vite + Tailwind CSS 构建的 Notion 风格 AI 写作助手。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![React](https://img.shields.io/badge/React-20232a?style=flat&logo=react&logoColor=61dafb)](https://reactjs.org/)
[![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white)](https://vitejs.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=flat&logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)

## 🚀 核心特性

- **📖 Notion 级编辑体验**：基于 Tiptap 构建的高性能富文本编辑器，支持多级标题、表格、任务列表等。
- **🤖 深度集成 AI 助手**：支持上下文感知的内容创作、智能润色、全文总结和长文续写。
- **🌐 实时联网搜索**：集成 Tavily API，让 AI 具备获取最新资讯的能力。
- **🧠 个人知识库 (RAG)**：支持手动引用其他页面或将特定页面加入知识库，AI 对话时可自动关联上下文。
- **📁 强大的文件管理**：侧边栏支持多级嵌套页面、收藏夹、废纸篓以及知识库快速切换。
- **🎨 极致 UI/UX**：响应式设计，完美支持深色模式，流畅的交互动画。

## 🛠️ 技术栈

- **Frontend**: React 18, TypeScript, Vite
- **Styling**: Tailwind CSS, Lucide Icons, Framer Motion
- **Editor**: Tiptap (Headless Rich Text Editor)
- **AI Integration**: Google Gemini API, Jina Reader API (网页内容解析)
- **Search Engine**: Tavily API
- **State Management**: React Hooks (localStorage 持久化)

## 📦 快速开始

### 前置要求

- Node.js 16.x 或更高版本
- npm 或 yarn

### 安装步骤

1. **克隆项目**
   ```bash
   git clone https://github.com/your-username/notion-ai-clone.git
   cd notion-ai-clone
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **配置环境变量**
   在项目根目录创建 `.env` 文件，或在应用内的“设置”面板中直接配置：
   - `GEMINI_API_KEY`: 你的 Google Gemini API Key
   - `TAVILY_API_KEY`: 你的 Tavily API Key (用于联网搜索)

4. **启动开发服务器**
   ```bash
   npm run dev
   ```

## 📂 项目结构

```text
src/
├── components/     # UI 组件 (Editor, Sidebar, AIAssistant 等)
├── App.tsx         # 核心逻辑与状态管理
├── main.tsx        # 入口文件
└── index.css       # 全局样式与 Tailwind 配置
```

## 📝 许可证

本项目采用 [MIT License](LICENSE) 开源。

## 🤝 贡献指南

欢迎提交 Issue 或 Pull Request 来完善这个项目！

---

如果这个项目对你有帮助，请给一个 ⭐️ 以示支持！
