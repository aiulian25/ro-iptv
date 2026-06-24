import { useCallback, useEffect, useRef, useState } from 'react';

// Draggable + corner-resizable floating box, aspect-locked, clamped to the
// viewport, persisted to localStorage. Uses Pointer Events so the same code
// works with a mouse (web) and touch (mobile PWA).
function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
function persist(key, box) {
  try {
    localStorage.setItem(key, JSON.stringify(box));
  } catch {
    /* quota / private mode */
  }
}

export function useFloatingBox({ storageKey, defaultWidth = 320, aspect = 9 / 16, margin = 12, minWidth = 200, maxWidth = 960 }) {
  const [box, setBox] = useState(null); // { x, y, w }  (height = w * aspect)
  const boxRef = useRef(null);
  const gesture = useRef(null);

  const clamp = useCallback(
    (b) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const mw = Math.min(maxWidth, vw - margin * 2);
      const w = Math.max(minWidth, Math.min(mw, b.w));
      const h = w * aspect;
      const x = Math.max(margin, Math.min(vw - w - margin, b.x));
      const y = Math.max(margin, Math.min(vh - h - margin, b.y));
      return { x, y, w };
    },
    [aspect, margin, minWidth, maxWidth]
  );

  const apply = useCallback(
    (b) => {
      const c = clamp(b);
      boxRef.current = c;
      setBox(c);
      return c;
    },
    [clamp]
  );

  // Initialise from storage or default to bottom-right.
  useEffect(() => {
    const saved = load(storageKey);
    if (saved && typeof saved.w === 'number') {
      apply(saved);
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(defaultWidth, vw - margin * 2);
    apply({ w, x: vw - w - margin, y: vh - w * aspect - margin });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onMove = useCallback(
    (e) => {
      const g = gesture.current;
      if (!g) return;
      e.preventDefault();
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      const s = g.startBox;
      if (g.type === 'move') {
        apply({ w: s.w, x: s.x + dx, y: s.y + dy });
        return;
      }
      const sh = s.w * aspect;
      const right = s.x + s.w;
      const bottom = s.y + sh;
      const mw = Math.min(maxWidth, window.innerWidth - margin * 2);
      let w = g.corner === 'br' || g.corner === 'tr' ? s.w + dx : s.w - dx;
      w = Math.max(minWidth, Math.min(mw, w));
      const h = w * aspect;
      let x = s.x;
      let y = s.y;
      if (g.corner === 'bl' || g.corner === 'tl') x = right - w; // anchor right edge
      if (g.corner === 'tl' || g.corner === 'tr') y = bottom - h; // anchor bottom edge
      apply({ w, x, y });
    },
    [apply, aspect, margin, minWidth, maxWidth]
  );

  const onUp = useCallback(() => {
    gesture.current = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (boxRef.current) persist(storageKey, boxRef.current);
  }, [onMove, storageKey]);

  const begin = useCallback(
    (e, type, corner) => {
      if (!boxRef.current) return;
      e.preventDefault();
      gesture.current = { type, corner, startX: e.clientX, startY: e.clientY, startBox: boxRef.current };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [onMove, onUp]
  );

  // Keep the box on-screen when the viewport changes.
  useEffect(() => {
    const onResize = () => boxRef.current && apply(boxRef.current);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [apply]);

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    },
    [onMove, onUp]
  );

  const style = box
    ? { position: 'fixed', left: box.x, top: box.y, width: box.w, height: box.w * aspect, touchAction: 'none' }
    : { position: 'fixed', visibility: 'hidden' };

  // Drag from the body, except on elements marked [data-no-drag] (buttons/handles).
  const startMove = (e) => {
    if (e.target.closest('[data-no-drag]')) return;
    begin(e, 'move');
  };
  const startResize = (corner) => (e) => {
    e.stopPropagation();
    begin(e, 'resize', corner);
  };

  return { box, style, startMove, startResize };
}

export default useFloatingBox;
