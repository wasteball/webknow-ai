/**
 * 跑在页面主世界：微信会在 selectstart 里 preventDefault，选区根本不会开始。
 * 捕获阶段先截断，目标上的那段监听就收不到，浏览器才能划出字。
 * 不调用 preventDefault，输入框里的原生选区仍然可用。
 */
export function unlockPageSelection(): void {
  const scope = globalThis as typeof globalThis & { __wkaSelectUnlock?: boolean };
  if (scope.__wkaSelectUnlock) return;
  scope.__wkaSelectUnlock = true;
  window.addEventListener(
    'selectstart',
    (event) => {
      event.stopImmediatePropagation();
    },
    true,
  );
  if (document.getElementById('wka-quote-select-main')) return;
  const style = document.createElement('style');
  style.id = 'wka-quote-select-main';
  style.textContent =
    '#js_content,#js_content *,.rich_media_content,.rich_media_content *,article,article *{user-select:text !important;-webkit-user-select:text !important}';
  document.documentElement.append(style);
}
