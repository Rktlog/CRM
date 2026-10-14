import { useEffect } from 'react';

// Every tick-box dropdown in the app (the state filter, the Orders filters, payment terms, Sales Data) is a
// <details class="terms-filter">. It opens when its title is pressed, and on its own it stays open until the
// title is pressed again. This closes it when a click, a tap or the keyboard moves anywhere OUTSIDE it, or
// when Escape is pressed. Ticking options inside it does not close it, so several can be ticked in one go.
// Used once, in the page layout.
const OPEN = 'details.terms-filter[open]';

export function useCloseDropdowns() {
  useEffect(() => {
    const closeOutside = (e: Event) => {
      const target = e.target as Node | null;
      document.querySelectorAll<HTMLDetailsElement>(OPEN).forEach(d => { if (!target || !d.contains(target)) d.open = false; });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') document.querySelectorAll<HTMLDetailsElement>(OPEN).forEach(d => { d.open = false; });
    };
    // pointerdown (not click) so a tap on empty space counts on phones, where such taps send no click.
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('focusin', closeOutside, true);   // tabbing out of it closes it too
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('focusin', closeOutside, true);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
}