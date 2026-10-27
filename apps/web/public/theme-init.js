/* Выбранная тема применяется до первой отрисовки (внешний файл: политика CSP запрещает встроенные скрипты). */
(function () {
  var t = 'corporate';
  try {
    var v = localStorage.getItem('arklock.theme');
    if (/^(glass|night|grove|aurora|corporate|light|dark|forest|emerald|sunset)$/.test(v)) t = v;
  } catch {}
  var r = document.documentElement;
  r.setAttribute('data-theme', t);
  if (t === 'dark' || t === 'forest' || t === 'night' || t === 'aurora') r.classList.add('dark');
})();
