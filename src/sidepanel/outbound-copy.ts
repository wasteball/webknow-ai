/** 首次外发告知里跟供应商走的句子。名字必须来自当前选中的那一家，不能写死 DeepSeek。 */

export function outboundFeeLine(providerName: string): string {
  return `费用从你自己的${providerName}账号里扣。`;
}

export function outboundRetentionLine(providerName: string): string {
  return `${providerName} 收到内容后怎么保存，由它自己的规则决定，我们没法替你保证它不留存。`;
}

export function outboundConfirmedHint(receiver: string): string {
  return `你已经确认过：正文和你的问题会发给 ${receiver}，费用从你的账号扣。`;
}
