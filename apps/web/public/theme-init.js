/* Выбранная тема применяется до первой отрисовки (внешний файл: политика CSP запрещает встроенные скрипты). */
(function () {
  // «Современный и лёгкий» — тема по умолчанию; прежние схемы переносятся на ближайшую из четырёх
  var LEGACY = {
    corporate: 'glass',
    sunset: 'glass',
    light: 'grove',
    emerald: 'grove',
    dark: 'night',
    forest: 'night',
  };
  var t = 'glass';
  try {
    var v = localStorage.getItem('arklock.theme');
    if (/^(glass|night|grove|aurora)$/.test(v)) t = v;
    else if (v && LEGACY[v]) t = LEGACY[v];
  } catch {}
  var r = document.documentElement;
  r.setAttribute('data-theme', t);
  if (t === 'night' || t === 'aurora') r.classList.add('dark');
})();
