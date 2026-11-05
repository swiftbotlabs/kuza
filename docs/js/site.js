// Small extras for the landing page in a normal browser: copy buttons, and the demo card plays when it is on screen
// (with a Replay button). The page is complete without this file; it only runs when the landing page is showing.

export function start(page) {
  for (const b of page.querySelectorAll('[data-copy]')) {
    b.hidden = false;
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        b.classList.add('done');
        b.title = 'Copied';
        setTimeout(() => { b.classList.remove('done'); b.removeAttribute('title'); }, 1400);
      } catch { /* clipboard blocked: the text is on the page to select */ }
    });
  }
  const live = page.querySelector('#live');
  if (!live) return;
  const play = () => {
    live.classList.add('lp-wait');
    void live.offsetWidth; // restart the CSS animations from the first frame
    live.classList.remove('lp-wait');
  };
  const replay = page.querySelector('#replay');
  if (replay) {
    replay.hidden = false;
    replay.addEventListener('click', play);
  }
  // Below the fold (phones): hold the card at its first frame until most of it is on screen, then play once.
  const box = live.getBoundingClientRect();
  if ('IntersectionObserver' in window && box.top > window.innerHeight * 0.8) {
    live.classList.add('lp-wait');
    const io = new IntersectionObserver((seen) => {
      if (seen.some((e) => e.isIntersecting)) {
        io.disconnect();
        live.classList.remove('lp-wait');
      }
    }, { threshold: 0.6 });
    io.observe(live);
  }
}
