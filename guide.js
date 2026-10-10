'use strict';

// Scenes come from characters/characters.json: add a character and it shows up here too.
async function renderScenes() {
  const list = document.getElementById('sceneList');
  await M.ready;
  const cfg = M.config;
  if (!cfg) {
    list.textContent = 'Couldn’t load the scenes. Please refresh the page.';
    return;
  }
  document.querySelectorAll('[data-max-seconds]').forEach((el) => { el.textContent = cfg.maxSeconds; });
  document.querySelectorAll('[data-video-price]').forEach((el) => { el.textContent = M.money(cfg.pricing.maxVideo); });
  document.querySelectorAll('[data-char-price]').forEach((el) => { el.textContent = M.money(cfg.pricing.character); });
  document.querySelectorAll('[data-keep-hours]').forEach((el) => { el.textContent = cfg.keepHours; });

  for (const c of cfg.characters) {
    const card = document.createElement('article');
    card.className = 'scene-card';

    if (c.image) {
      const img = document.createElement('img');
      img.src = c.image;
      img.alt = '';
      img.width = 300;
      img.height = 400;
      img.loading = 'lazy';
      card.appendChild(img);
    }

    const body = document.createElement('div');
    body.className = 'scene-body';
    const h = document.createElement('h3');
    h.textContent = c.name;
    body.appendChild(h);

    if (c.gesture) {
      const g = document.createElement('p');
      g.className = 'scene-gesture';
      g.textContent = `Signature gesture: ${c.gesture.charAt(0).toLowerCase()}${c.gesture.slice(1)}.`;
      body.appendChild(g);
    }

    if (c.scenes.length) {
      const ol = document.createElement('ol');
      for (const s of c.scenes) {
        const li = document.createElement('li');
        li.textContent = s;
        ol.appendChild(li);
      }
      body.appendChild(ol);
    }

    if (c.caption) {
      const caption = `${c.caption}\nFictional character, video made with AI. #ai #aicharacter #aivideo`;
      const box = document.createElement('div');
      box.className = 'caption';
      const pre = document.createElement('p');
      pre.className = 'caption-text';
      pre.textContent = caption;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link-button';
      btn.textContent = 'Copy caption';
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(caption);
          btn.textContent = 'Caption copied';
        } catch {
          btn.textContent = 'Select the text and copy it manually';
        }
        setTimeout(() => { btn.textContent = 'Copy caption'; }, 2500);
      });
      box.append(pre, btn);
      body.appendChild(box);
    }

    card.appendChild(body);
    list.appendChild(card);
  }
}

renderScenes();

// Highlights the section you're reading in the table of contents.
(function followSections() {
  const links = [...document.querySelectorAll('.guide-toc a[href^="#"]')];
  const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
  const sections = [...byId.keys()].map((id) => document.getElementById(id)).filter(Boolean);
  if (!sections.length) return;
  let scheduled = false;
  function update() {
    scheduled = false;
    // The current section is the last one whose top has passed the upper third of the screen
    const line = window.innerHeight * 0.33;
    let current = null;
    for (const s of sections) if (s.getBoundingClientRect().top <= line) current = s;
    links.forEach((a) => a.classList.toggle('active', Boolean(current) && a === byId.get(current.id)));
  }
  window.addEventListener('scroll', () => {
    if (!scheduled) {
      scheduled = true;
      window.requestAnimationFrame(update);
    }
  }, { passive: true });
  update();
}());
