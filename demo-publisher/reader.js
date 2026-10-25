/* The Courier — reader-side chrome for the AdPal demo.
 *
 * Only editorial affordances live here: the reading-progress indicator and the
 * (inert) newsletter form. No advertising logic and no telemetry UI — the four
 * publisher placements are owned entirely by the extension, and the agent
 * terminal is a separate page at /terminal/.
 *
 * Progress is measured from the page's own rectangle rather than a wrapper, so
 * this works whether the page scrolls at the document level (as it does here)
 * or inside a container.
 */

(() => {
  'use strict';

  const bar = document.getElementById('read-progress-bar');
  const page = document.querySelector('.page') || document.querySelector('main');

  if (bar && page) {
    let scheduled = false;

    function update() {
      scheduled = false;

      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const rect = page.getBoundingClientRect();

      // Fraction of the page that has passed the top of the viewport, with a
      // 60%-viewport finish line so the bar reaches 100% while the last
      // paragraph is still comfortably on screen.
      const travelled = Math.max(0, -rect.top);
      const finishLine = Math.max(1, rect.height - viewportHeight * 0.6);
      const progress = Math.min(1, Math.max(0, travelled / finishLine));

      bar.style.width = `${(progress * 100).toFixed(1)}%`;
    }

    /*
     * Scroll events are already coalesced to roughly one per frame by the
     * browser, so measuring directly here is cheaper than queueing another
     * frame — and it keeps the bar correct when requestAnimationFrame is
     * throttled (background tab, reduced-motion, some embedded webviews).
     */
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      window.setTimeout(update, 0);
    }

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });

    update();
  }

  // The newsletter is set dressing for the demo: acknowledge locally, send
  // nothing, and leave no trace in the article.
  const form = document.getElementById('newsletter-form');
  const note = document.getElementById('news-note');

  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (note) note.textContent = 'This is a demo publication — no email was collected.';
      form.reset();
    });
  }
})();
