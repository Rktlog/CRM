import { useEffect } from 'react';

// Makes every scrolling table box as tall as the space left on the screen, so a big screen shows more rows and a small one still scrolls.
// It looks at each box's own top edge, so it works the same on every page. Boxes inside a pop-up window keep the size they were given.
// The CSS gives each box a sensible size first (so nothing jumps while the page loads); this only replaces that with the exact fit.
const BOXES = '.ledger-table-scroll.tall, .scroll-capped-10, .scroll-capped-5';
const BOTTOM_GAP = 24;   // a little air under the box
const MIN_HEIGHT = 280;  // never smaller than about five rows

export function fitTables(root: ParentNode = document, viewportHeight = window.innerHeight) {
  root.querySelectorAll<HTMLElement>(BOXES).forEach(el => {
    if (el.closest('.modal-card') || el.classList.contains('order-history-scroll')) return;   // these keep their own size (the order history must fit five orders)
    el.style.maxHeight = '';   // measure from the natural position, not from the last fit
    // Where the box sits on the page, not on the screen, so scrolling a little does not change the answer.
    const topOnPage = el.getBoundingClientRect().top + window.scrollY;
    const room = viewportHeight - topOnPage - BOTTOM_GAP;
    el.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.floor(room))}px`;
  });
}

export function useFitTables(watch: unknown) {
  useEffect(() => {
    let frame = 0;
    const run = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => fitTables()); };
    run();
    window.addEventListener('resize', run);
    // Pages draw their tables after the data arrives, so look again when the page's content changes.
    const content = document.querySelector('.content');
    const mo = content ? new MutationObserver(run) : null;
    mo?.observe(content!, { childList: true, subtree: true });
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', run); mo?.disconnect(); };
  }, [watch]);
}
