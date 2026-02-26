export type WorkflowScope = 'current_doc' | 'knowledge_base' | 'new_page';
export type WorkflowCadence = 'manual' | 'auto';
export type WorkflowOutput = 'plan' | 'rewrite' | 'translate';
export type WorkflowRisk = 'low' | 'medium' | 'high';

export type Skill = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  scope: WorkflowScope;
  output: WorkflowOutput;
  cadence: WorkflowCadence;
  risk: WorkflowRisk;
};

export const DEFAULT_SKILLS: Skill[] = [
  {
    id: 'goal_breakdown',
    name: '目标拆解',
    description: '把目标拆成里程碑和今日行动',
    prompt:
      '请使用“目标拆解技能”：先用一句话澄清目标，再输出 3-5 个里程碑（含验收标准）、5-8 个今日可执行任务（按优先级），最后给出关键风险与缓解措施。',
    scope: 'current_doc',
    output: 'plan',
    cadence: 'manual',
    risk: 'low'
  },
  {
    id: 'risk_review',
    name: '风险评审',
    description: '提前识别失败点并给纠偏方案',
    prompt:
      '请使用“风险评审技能”：识别当前方案的关键假设与失败点，给出触发信号、最小代价纠偏策略，并整理成可执行的下一步清单。',
    scope: 'current_doc',
    output: 'plan',
    cadence: 'auto',
    risk: 'medium'
  },
  {
    id: 'deep_research',
    name: '深度调研',
    description: '联网搜索并生成深度报告',
    prompt:
      '请使用“深度调研技能”：先基于用户输入的主题进行联网搜索（Tavily），获取多方观点和数据。然后整合信息，输出一份结构化的深度研究报告，包含：背景现状、关键数据对比、核心观点摘要及结论。',
    scope: 'new_page',
    output: 'plan',
    cadence: 'auto',
    risk: 'high'
  }
];
