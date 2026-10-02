import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Command, PanelSettings, Reply } from '../../core/protocol';
import type { ResearchPending } from '../../core/session';

type Send = (command: Command) => Promise<Reply | undefined>;

/** One verified pending question. Interrupted checkpoints can only start a new run. */
export function ResearchClarification({ pending, tabId, sessionId, capabilities, send, onRetry, retryDisabled }: {
  pending: ResearchPending; tabId: number; sessionId: string;
  capabilities: PanelSettings['search']['sourceCapabilities']; send: Send;
  onRetry: () => void; retryDisabled: boolean;
}) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const token = `${tabId}:${sessionId}:${pending.runId}:${pending.status}`;
  const current = useRef(token);
  current.current = token;
  const directRead = useRef(capabilities.directRead);
  directRead.current = capabilities.directRead;
  useEffect(() => () => { current.current = ''; }, []);
  if (pending.status === 'running') return null;
  const waiting = pending.status === 'waiting';
  const permission = pending.clarification?.reason === 'permission';
  const origins = pending.permissionOrigins ?? [];
  const canGrant = capabilities.directRead && origins.length > 0;
  const resolve = async (mode: 'continue' | 'article' | 'cancel') => {
    if (submitting || !waiting || (mode === 'continue' && (!text.trim() || (permission && !canGrant)))) return;
    setSubmitting(true);
    setNotice('');
    try {
      if (mode === 'continue' && permission) {
        // This browser call must be the first await of the user's click.
        const granted = await browser.permissions.request({ origins });
        if (current.current !== token || !directRead.current) return;
        if (!granted) { setNotice('没有获得来源读取权限。可以只按文章回答。'); return; }
      }
      if (current.current !== token) return;
      const reply = await send({ type: 'resolveResearch', tabId, sessionId, runId: pending.runId, mode,
        text: mode === 'continue' ? text.trim().slice(0, 500) : mode === 'article' ? '只依据文章回答，不使用网络资料。' : '' });
      if (current.current === token && reply && !reply.ok) setNotice(reply.error.message);
    } catch {
      if (current.current === token) setNotice('来源读取授权没有完成，可以再试一次或只按文章回答。');
    } finally {
      if (current.current === token) setSubmitting(false);
    }
  };
  return <section className="research-clarification" aria-label={waiting ? '研究澄清' : '研究已停止'}>
    {waiting ? <>
      <p>{pending.clarification?.question ?? '请补充本题需要的条件。'}</p>
      {permission && <>
        <p>本轮请求读取以下来源：</p>
        <ul>{origins.map(origin => <li key={origin}>{origin}</li>)}</ul>
        {!capabilities.directRead && <p>{capabilities.directReadReason ?? '直接读取暂不可用。'}</p>}
      </>}
      <form onSubmit={event => { event.preventDefault(); void resolve('continue'); }}>
        <label>补充条件<textarea value={text} maxLength={500} rows={2} onChange={event => setText(event.target.value)} disabled={submitting} /></label>
        <div className="research-controls">
          <button type="submit" disabled={submitting || !text.trim() || (permission && !canGrant)}>{permission ? '授权并继续' : '继续'}</button>
          <button type="button" disabled={submitting} onClick={() => void resolve('article')}>只按文章</button>
          <button type="button" disabled={submitting} onClick={() => void resolve('cancel')}>取消</button>
        </div>
      </form>
    </> : <>
      <p>{pending.status === 'stopped' ? '研究已停止。' : '研究已中断或等待已到期。'}原问题仍保留，重新研究会开始新的一轮。</p>
      <p>{pending.question}</p>
      <button type="button" disabled={retryDisabled} onClick={onRetry}>重新研究这个问题</button>
    </>}
    {notice && <p role="status" aria-live="polite">{notice}</p>}
  </section>;
}
