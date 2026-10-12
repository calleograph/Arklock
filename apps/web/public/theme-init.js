/* Выбранная тема применяется до первой отрисовки (внешний файл: политика CSP запрещает встроенные скрипты). */
(function () {
  var t = 'corporate';
  try {
    var v = localStorage.getItem('arklock.theme');
    if (/^(corporate|light|dark|forest|emerald|sunset)$/.test(v)) t = v;
  } catch {}
  var r = document.documentElement;
  r.setAttribute('data-theme', t);
  if (t === 'dark' || t === 'forest') r.classList.add('dark');
})();
