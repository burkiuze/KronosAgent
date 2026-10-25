/**
 * The Kronos mark: the knight artwork (public/kronos-128.png) in a rounded tile. While `busy` the
 * whole mark breathes with opacity, which the compositor animates on its own.
 */
export function KronosMark({ size = 40, busy = false }: { size?: number; busy?: boolean }) {
  return <img src={`${import.meta.env.BASE_URL}kronos-128.png`} width={size} height={size} alt="Kronos" draggable={false} className={`kronos-mark ${busy ? 'busy' : ''}`} />;
}
