import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { Command, PanelState, Reply } from '../../src/core/protocol';
import { createClient, type Client } from '../../src/sidepanel/api';
import { Settings } from '../../src/sidepanel/components/Settings';
import '../sidepanel/style.css';

/**
 * 设置是独立标签页，不是侧栏里的弹层：工作时才在侧栏，改配置时不该被侧栏宽度限制。
 * 侧栏打开设置时会在地址 `#` 后带上当前页的标签页号，因此“清掉这一页的内容”仍然可用；
 * 从浏览器自带的“扩展选项”入口进来没有这个号，只显示全部页面的操作——那本来就是它的语义。
 */
function Options() {
  const [state, setState] = useState<PanelState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const clientRef = useRef<Client | null>(null);

  useEffect(() => {
    const client = createClient({ onState: setState, onProgress: () => {} });
    clientRef.current = client;
    const parsed = Number.parseInt(new URLSearchParams(location.search).get('tab') ?? location.hash.slice(1), 10);
    void client.send({ type: 'attach', tabId: Number.isFinite(parsed) ? parsed : null });
    return () => client.dispose();
  }, []);

  const send = useCallback(async (command: Command): Promise<Reply | undefined> => {
    const reply = await clientRef.current?.send(command);
    if (reply && !reply.ok) setNotice(reply.error.message);
    else if (reply?.message) setNotice(reply.message);
    return reply;
  }, []);

  if (!state) {
    return (
      <div className="panel">
        <p className="hint">正在连接后台…</p>
      </div>
    );
  }
  return <Settings state={state} send={send} notice={notice} onDismissNotice={() => setNotice(null)} />;
}

const container = document.getElementById('root');
if (!container) throw new Error('设置页挂载点缺失');

// 不使用 StrictMode：开发期的双次挂载会重复建立与后台的长连接。
createRoot(container).render(<Options />);
