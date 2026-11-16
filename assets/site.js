/* ---------------------------------------------------------------
   Flute Timer — shared site script
   --------------------------------------------------------------- */
(() => {
  'use strict';

  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-nav');

  if (toggle && nav) {
    const setOpen = (open) => {
      toggle.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('is-open', open);
      document.body.classList.toggle('nav-open', open);
    };

    toggle.addEventListener('click', () => {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });

    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) setOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setOpen(false);
        toggle.focus();
      }
    });

    document.addEventListener('click', (event) => {
      if (
        toggle.getAttribute('aria-expanded') === 'true' &&
        !nav.contains(event.target) &&
        !toggle.contains(event.target)
      ) {
        setOpen(false);
      }
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 760) setOpen(false);
    });
  }

  for (const year of document.querySelectorAll('[data-year]')) {
    year.textContent = String(new Date().getFullYear());
  }
})();
