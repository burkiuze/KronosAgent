import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Toggle({ checked, onChange, disabled, title }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      className={`toggle ${checked ? 'on' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      <span />
    </button>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'error' | 'accent' }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Modal({ open, onClose, children, wide, className = '' }: { open: boolean; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${wide ? 'wide' : ''} ${className}`} onMouseDown={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
        {children}
      </div>
    </div>
  );
}

/**
 * Caps a popover's height to the room left inside whatever clips it (a scrolling ancestor or the
 * window), so a long menu scrolls instead of running off the screen.
 */
export function fitPopover(el: HTMLElement, gap = 8): void {
  el.style.maxHeight = '';
  const r = el.getBoundingClientRect();
  let top = 0;
  let bottom = window.innerHeight;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll' || o === 'hidden') {
      const b = p.getBoundingClientRect();
      top = Math.max(top, b.top);
      bottom = Math.min(bottom, b.bottom);
    }
  }
  const room = r.top < top + gap ? r.bottom - top - gap : bottom - r.top - gap;
  if (r.height > room) el.style.maxHeight = `${Math.max(140, Math.floor(room))}px`;
}

/** Small anchored popover menu. */
export function Menu({ trigger, children, align = 'left', up }: { trigger: (open: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !pop.current) return;
    const el = pop.current;
    const fit = () => fitPopover(el);
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      {trigger(() => setOpen((o) => !o))}
      {open && (
        <div ref={pop} className={`menu ${align} ${up ? 'up' : ''}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, danger, hint }: { icon?: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean; hint?: string }) {
  return (
    <button className={`menu-item ${danger ? 'danger' : ''}`} onClick={onClick}>
      {icon}
      <span>{children}</span>
      {hint && <kbd>{hint}</kbd>}
    </button>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder, autoFocus, right }: { value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean; right?: ReactNode }) {
  return (
    <div className="searchbox">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} />
      {right}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: ReactNode; count?: number }[] }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.id} className={`tab ${value === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && <sup>{t.count}</sup>}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}
