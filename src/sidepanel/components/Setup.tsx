import { Section } from './bits';

/**
 * 首次打开还没有钥匙：不在侧栏里填。侧栏是用来读这一页的；
 * 配钥匙、看还能开哪些能力，都去设置页——那里分类齐全，用户能先看见自己装了什么。
 */
export function Setup({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <Section title="先去设置里填一把钥匙">
      <p>这个插件自己不提供 AI，要借你自己账号里的钥匙来读网页。费用由那家按用量收，我们不收钱，也看不到钥匙。</p>
      <p>填好之后，就可以：</p>
      <ul className="steps">
        <li>读这一页，给你短摘要和几个值得追问的话题</li>
        <li>你来提问，或者反过来让它问你</li>
        <li>需要的话再开联网搜索</li>
      </ul>
      <p className="hint">先在设置里选 DeepSeek 或智谱并填写 API Key。提示词和联网搜索可以稍后按需调整。</p>
      <div className="composer-actions">
        <button type="button" onClick={onOpenSettings}>
          去设置里填钥匙
        </button>
      </div>
    </Section>
  );
}
