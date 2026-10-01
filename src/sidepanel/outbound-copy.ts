import type { PanelSettings } from '../core/protocol';
import { findProvider } from '../core/model-providers';
/** 首次外发告知里跟供应商走的句子。名字必须来自当前选中的那一家，不能写死 DeepSeek。 */

export function outboundFeeLine(providerName: string): string {
  return `费用从你自己的${providerName}账号里扣。`;
}

export function outboundRetentionLine(providerName: string): string {
  return `${providerName} 收到内容后怎么保存，由它自己的规则决定，我们没法替你保证它不留存。`;
}

export function outboundConfirmedHint(receiver: string, readsImages: boolean, settings?: Pick<PanelSettings, 'provider' | 'search'>): string {
  if (settings) return `你已经确认过：${outboundReceiverLines(settings).join(' ')} 费用从你的账号扣。`;
  const images = readsImages ? '、可读取的内容图片' : '';
  return `你已经确认过：正文${images}和你的问题会发给 ${receiver}，费用从你的账号扣。`;
}

/** Shared by setup, confirmed hint and search settings. */
export function outboundReceiverLines(settings: Pick<PanelSettings, 'provider' | 'search'>): string[] {
  const provider = findProvider(settings.provider);
  const search = settings.search;
  const receiver = search.receiver || search.providerName || '尚未配置的搜索服务';
  const lines = [`${provider.receiver} 接收当前文章正文、你的问题、必要对话历史、搜索资料与读取到的来源正文。${provider.id === 'deepseek' ? '还会尝试发送可读取的内容图片。' : ''}`,
    `搜索服务（${receiver}）接收搜索词和筛选条件；不会收到整篇文章正文或对话历史。`,
    '鉴权型搜索服务仅在自己的认证通道接收它自己的凭证；其他服务的 Key 不会发给它，凭证不进入提示词、不可信资料或日志。'];
  lines.push(search.agent.sourceReading === 'off' ? '来源读取已关闭，使用搜索摘要。'
    : search.sourceCapabilities.providerContent ? `内容接口（${receiver}）接收所选来源 URL；返回的来源正文会给上述模型接收方。`
    : search.sourceCapabilities.directRead ? '来源网站在逐个授权后接收 HTTP(S) GET，不携带 Cookie、表单或脚本。'
    : '直接读取来源网站暂不可用；内容接口不可用时使用搜索摘要。');
  return lines;
}
