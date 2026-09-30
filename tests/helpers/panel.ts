import type { PanelState } from '../../src/core/protocol';

export function panel(overrides: Partial<PanelState> = {}): PanelState {
  return {
    tabId: 7, pageUrl: 'https://example.com/article', pageTitle: '一篇文章',
    permission: 'granted', phase: 'READY', sessionState: 'READY', hasKey: true,
    settings: {
      provider: 'deepseek', providerKeys: { deepseek: true, zhipu: false },
      models: {}, model: 'deepseek-flash', thinking: 'off', prompts: {}, customSkills: [],
      learningStyle: 'mixed', maxBubbles: 3, summaryLength: 'medium', fontSize: 'normal',
      diagrams: 'off', search: { enabled: false, providerName: null, hasCredentials: false },
      ima: { enabled: false, kbName: null },
    },
    outboundConfirmed: true, completeness: null,
    guide: { summary: '这是一篇文章的摘要。', bubbles: [] }, chat: [], learning: null,
    quote: null, busy: null, error: null, rounds: 0, unsupportedReason: null,
    ...overrides,
  };
}
