import { createRoot } from 'react-dom/client';

import { App } from '../../src/sidepanel/App';
import './style.css';

const container = document.getElementById('root');
if (!container) throw new Error('侧栏挂载点缺失');

// 不使用 StrictMode：开发期的双次挂载会重复建立与后台的长连接。
createRoot(container).render(<App />);
