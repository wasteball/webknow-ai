import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

/** 滚动归对话容器管理；消息正文不得自行把用户拉回底部。 */
export function Conversation({ active = true, updateKey, followRequest, children }: {
  active?: boolean;
  updateKey: string;
  followRequest: number;
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const saved = useRef(0);
  const hiddenUpdate = useRef(false);
  const seen = useRef<{ active: boolean; key: string; request: number } | null>(null);
  const [unread, setUnread] = useState(false);
  const [away, setAway] = useState(false);

  const latest = () => {
    const element = host.current;
    if (!element) return;
    following.current = true;
    element.scrollTop = element.scrollHeight;
    saved.current = element.scrollTop;
    setAway(false);
    setUnread(false);
  };

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const previous = seen.current;
    seen.current = { active, key: updateKey, request: followRequest };
    if (!previous) { if (active) latest(); return; }
    const changed = previous.key !== updateKey || previous.request !== followRequest;
    if (!active) {
      hiddenUpdate.current ||= changed;
      return;
    }
    if (!previous.active) {
      element.scrollTop = saved.current;
      if (following.current) latest();
    }
    if (previous.request !== followRequest) following.current = true;
    if (changed || hiddenUpdate.current) {
      hiddenUpdate.current = false;
      if (following.current) latest();
      else setUnread(true);
    }
  }, [active, updateKey, followRequest]);

  // Diagrams and wrapped text can change height after the message itself is delivered.
  useLayoutEffect(() => {
    const element = host.current;
    if (!active || !element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (following.current) latest();
      else setAway(element.scrollHeight - element.clientHeight - element.scrollTop >= 80);
    });
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [active]);

  return (
    <div className="conversation">
      <div ref={host} className="chat-scroll" role="region" aria-label="对话记录" tabIndex={0}
        onWheel={(event) => { if (event.deltaY < 0) following.current = false; }}
        onScroll={() => {
          const element = host.current;
          if (!element || !active) return;
          saved.current = element.scrollTop;
          following.current = element.scrollHeight - element.clientHeight - element.scrollTop < 80;
          setAway(!following.current);
          if (following.current) setUnread(false);
        }}>
        <div className="chat">{children}</div>
      </div>
      {(away || unread) && <button type="button" className="chat-latest" aria-label="回到最新消息" title="回到底部" onClick={latest}>
        <span className="latest-arrow"><Icon name="send" small /></span>
        {unread && <span>有新消息</span>}
      </button>}
    </div>
  );
}
