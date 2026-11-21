/* Language layer. The interface is written in English; this script swaps each piece of visible text for its
   translation from i18n/<lang>.json as the page renders.
   Before the lookup, known names (people, faults, sensors, actions: "names" in the file) and numbers are lifted out
   of the text and put back afterwards, so one entry such as "{e0} approved: {e1}" covers every person and action. */
(() => {
  let lang = 'ka';
  try { lang = localStorage.getItem('lang') || 'ka'; } catch (e) { /* storage blocked: default language */ }
  const collect = /[?&]collect=1/.test(location.search);
  const seen = new Set(), missed = new Set();
  let dict = {}, names = {}, nameRe = null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function normalise(t) {
    const ents = [], nums = [];
    let key = nameRe ? t.replace(nameRe, (m) => { ents.push(m); return '{e' + (ents.length - 1) + '}'; }) : t;
    key = key.replace(/\d+(?:[.,:]\d+)*/g, (m, off, str) => (str[off - 1] === 'e' && str[off - 2] === '{' ? m : (nums.push(m), '{' + (nums.length - 1) + '}')));
    return { key, ents, nums };
  }
  const nameOf = (m) => names[m] || names[m.toLowerCase()] || m;

  function translate(text) {
    const t = text.trim();
    if (!t || !/[A-Za-z]{2}/.test(t)) return null;
    if (names[t] !== undefined) { if (collect) seen.add('NAME ' + t); return text.replace(t, names[t]); }
    const { key, ents, nums } = normalise(t);
    if (collect) seen.add(key);
    let out = dict[key];
    if (out === undefined) { if (!/[A-Za-z]{2}/.test(key.replace(/\{e?\d+\}/g, ''))) out = key; else { missed.add(key); return null; } }
    out = out.replace(/\{e(\d+)\}/g, (m, i) => (ents[i] !== undefined ? nameOf(ents[i]) : m)).replace(/\{(\d+)\}/g, (m, i) => (nums[i] !== undefined ? nums[i] : m));
    return text.replace(t, out);
  }

  const SKIP = new Set(['SCRIPT', 'STYLE', 'CODE', 'CANVAS', 'VIDEO']);
  const ATTRS = ['placeholder', 'aria-label', 'title'];
  function node(n) {
    if (n.nodeType === 3) {
      const p = n.parentElement;
      if (!p || SKIP.has(p.tagName) || p.closest('[data-i18n-skip]')) return;
      if (n.nodeValue === n.__out) return;                 // our own output
      const out = translate(n.nodeValue);
      if (out !== null && lang !== 'en') { n.__out = out; n.nodeValue = out; }
      return;
    }
    if (n.nodeType !== 1 || SKIP.has(n.tagName) || n.closest('[data-i18n-skip]')) return;
    for (const a of ATTRS) if (n.hasAttribute(a)) { const v = n.getAttribute(a); if (v !== n['__' + a]) { const out = translate(v); if (out !== null && lang !== 'en') { n['__' + a] = out; n.setAttribute(a, out); } } }
    for (const c of n.childNodes) node(c);
  }

  function start() {
    const opts = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS };
    node(document.body);
    const obs = new MutationObserver((muts) => {
      obs.disconnect();
      for (const m of muts) { if (m.type === 'childList') m.addedNodes.forEach(node); else node(m.target); }
      obs.observe(document.body, opts);
    });
    obs.observe(document.body, opts);
  }

  document.addEventListener('click', (e) => { const b = e.target.closest('[data-lang]'); if (!b) return; try { localStorage.setItem('lang', b.dataset.lang); } catch (err) { /* ignore */ } location.reload(); });
  window.I18N = { lang, seen, missed };
  document.documentElement.lang = lang;

  const ready = lang === 'en' && !collect ? Promise.resolve(null) : fetch('i18n/ka.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  ready.then((d) => {
    if (d) {
      dict = d.strings || {}; names = d.names || {};
      const list = Object.keys(names).sort((a, b) => b.length - a.length);
      for (const n of list) if (names[n.toLowerCase()] === undefined) names[n.toLowerCase()] = names[n];
      if (list.length) nameRe = new RegExp('(?<![A-Za-z])(?:' + list.map(esc).join('|') + ')(?![A-Za-z])', 'gi');
      if (lang !== 'en' || collect) start();
    }
    document.querySelectorAll('[data-lang]').forEach((b) => { b.hidden = b.dataset.lang === lang; });
  });
})();
