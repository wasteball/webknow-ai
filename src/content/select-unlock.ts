/**
 * 跑在页面主世界：微信会在 selectstart 里 preventDefault，选区根本不会开始。
 *
 * 只靠捕获阶段截断不够——页面自己也在 window 捕获阶段注册，而且比我们早，
 * 它的 preventDefault 先执行完，我们的 stopImmediatePropagation 再也追不上。
 * 所以直接让 selectstart 的 preventDefault 失效：谁先注册都不影响结果。
 * 只动 selectstart 这一种事件，其它事件的默认行为照旧。
 */
export function unlockPageSelection(): void {
  const scope = globalThis as typeof globalThis & { __wkaSelectUnlock?: boolean };
  if (scope.__wkaSelectUnlock) return;
  scope.__wkaSelectUnlock = true;
  const preventDefault = Event.prototype.preventDefault;
  Event.prototype.preventDefault = function patched(this: Event): void {
    if (this.type === 'selectstart') return;
    preventDefault.call(this);
  };
  // 顺带截断：注册在我们之后的那些 selectstart 监听连执行机会都没有。
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
