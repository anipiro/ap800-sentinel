# Georgian interface: draft material, not wired into the app

The Georgian UI was started on 21 Nov 2026 and stopped before the demo deadline. Nothing here is loaded by the website.

- `i18n.js`: a working language layer. It swaps visible text for translations as the page renders, lifting numbers and known names out of each sentence first so one entry covers many variants.
- `ka.names.json`: Georgian for about 100 names (people, faults, sensors, actions, stations). Machine-translated and not reviewed by a Georgian speaker.
- `english-templates.json`: the 616 text templates the interface showed across a broad run. These are what still need translating.

To finish: translate the templates into `strings` in a `public/i18n/ka.json` file next to the names, move `i18n.js` to `public/`, add the script tag before `app.js` and a language button with `data-lang`.
