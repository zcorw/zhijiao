import type { InteractionModelResult } from './interaction-analysis-model.js';
type StatementCandidate = InteractionModelResult['statements'][number];

type BasisFields = Pick<StatementCandidate, 'subjectIds' | 'kind' | 'polarity' | 'source' | 'uncertainty'> & {
  personFact: NonNullable<StatementCandidate['personFact']>;
};
export interface BasisPromptExample {
  id: string;
  input: string;
  /** Human-authored fictional summary used by the offline contract regression. */
  text: string;
  fields: BasisFields;
}

/** Partial output examples only. IDs here are local to each fictional example. */
export const BASIS_PROMPT_EXAMPLES: BasisPromptExample[] = [
  {
    id: 'own-current-state',
    input: '我和小岚聊天。小岚告诉我：我最近换了工作。',
    text: '小岚自述最近换了工作。',
    fields: {
      subjectIds: ['p2'], kind: 'reported', polarity: 'affirmed', source: { type: 'person', personId: 'p2' }, uncertainty: null,
      personFact: { type: 'current-state', category: '工作近况', basis: 'self-reported', factStatus: 'candidate' },
    },
  },
  {
    id: 'own-negated-preference',
    input: '我和小岚喝茶。小岚说：我不喝咖啡。',
    text: '小岚说自己不喝咖啡。',
    fields: {
      subjectIds: ['p2'], kind: 'reported', polarity: 'negated', source: { type: 'person', personId: 'p2' }, uncertainty: null,
      personFact: { type: 'preference', category: '饮食', basis: 'self-reported', factStatus: 'candidate' },
    },
  },
  {
    id: 'narrator-self-report',
    input: '我告诉小岚：我喜欢喝热茶。',
    text: '当前用户自述喜欢喝热茶。',
    fields: {
      subjectIds: ['p1'], kind: 'fact', polarity: 'affirmed', source: { type: 'narrator', personId: 'p1' }, uncertainty: null,
      personFact: { type: 'preference', category: '饮食', basis: 'self-reported', factStatus: 'candidate' },
    },
  },
  {
    id: 'third-party-report',
    input: '我和阿北聊天。阿北告诉我：小岚最近搬到海边了。',
    text: '阿北说小岚最近搬到海边了。',
    fields: {
      subjectIds: ['p2'], kind: 'reported', polarity: 'affirmed', source: { type: 'person', personId: 'p3' }, uncertainty: '消息由阿北转述，尚未向小岚本人确认。',
      personFact: { type: 'current-state', category: '居住近况', basis: 'third-party', factStatus: 'candidate' },
    },
  },
  {
    id: 'nested-self-report',
    input: '我听阿北说：小岚之前告诉我，她喜欢徒步。',
    text: '阿北转述小岚之前告诉他自己喜欢徒步。',
    fields: {
      subjectIds: ['p2'], kind: 'reported', polarity: 'affirmed', source: { type: 'person', personId: 'p3' }, uncertainty: '引语中的“我”为阿北；消息由阿北转述，不能跳过中间人。',
      personFact: { type: 'preference', category: '兴趣', basis: 'third-party', factStatus: 'candidate' },
    },
  },
  {
    id: 'unverified-self-report',
    input: '我和小岚聊天。小岚告诉我，她最近开始学陶艺。我没有另外核实她的说法。',
    text: '小岚自述最近开始学陶艺。',
    fields: {
      subjectIds: ['p2'], kind: 'reported', polarity: 'affirmed', source: { type: 'person', personId: 'p2' }, uncertainty: '仅为小岚本人陈述，叙述者未独立核实。',
      personFact: { type: 'current-state', category: '兴趣近况', basis: 'self-reported', factStatus: 'candidate' },
    },
  },
  {
    id: 'topic-with-unknown-speaker',
    input: '我和小岚聊了她喜欢喝热茶这件事，但笔记没写明这条消息是谁提供的。',
    text: '笔记提到小岚喜欢喝热茶，但消息提供者不明。',
    fields: {
      subjectIds: ['p2'], kind: 'reported', polarity: 'affirmed', source: { type: 'unknown', personId: null }, uncertainty: '只知道谈到了该话题，无法确定由谁提供消息，不能猜成小岚自述或第三人转述。',
      personFact: { type: 'preference', category: '饮食', basis: null, factStatus: 'ambiguous' },
    },
  },
  {
    id: 'narrator-with-unknown-method',
    input: '我在笔记里写着“小岚喜欢热茶”，但我想不起从哪里得知。',
    text: '叙述者记有小岚喜欢热茶，但获取该消息的方式不明。',
    fields: {
      subjectIds: ['p2'], kind: 'fact', polarity: 'affirmed', source: { type: 'narrator', personId: 'p1' }, uncertainty: '笔记叙述者明确，但无法确定其得知方式，不能补成小岚本人陈述、直接观察或第三方转述。',
      personFact: { type: 'preference', category: '饮食', basis: null, factStatus: 'ambiguous' },
    },
  },
];
