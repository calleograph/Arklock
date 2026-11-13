/* global document, getComputedStyle, NodeFilter */
// Проверка ровности: выполняется в странице (page.evaluate), возвращает { problems: string[] }.
// Ищет то, что глазом видно как «неровно»: кнопки действий в строках списка на разных местах, значок не по центру
// текста, элементы, выходящие за край, пустоты внутри карточек и контролы разной высоты в одной строке.
(() => {
  const problems = [];
  const vw = document.documentElement.clientWidth;
  const main = document.querySelector('main') ?? document.body;
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const name = (e) => {
    const t = e.getAttribute('data-testid');
    if (t) return `[${t}]`;
    const c = [...e.classList].slice(0, 2).join('.');
    return `${e.tagName.toLowerCase()}${c ? '.' + c : ''}`;
  };
  const ctl = (row) =>
    [
      ...row.querySelectorAll(
        'button, a.btn, a.btn-primary, select, input:not([type=hidden]):not([type=checkbox]):not([type=radio])',
      ),
    ].filter(visible);

  // 1. Строки списка: правый край последнего элемента действия одинаков во всех строках
  const containers = [...main.querySelectorAll('ul, ol, tbody, .divide-y')].filter(visible);
  for (const c of containers) {
    const rows = [...c.children].filter(visible);
    if (rows.length < 2) continue;
    const rights = rows
      .map((r) => {
        // раскрытое содержимое строки (карточка группы и т. п.) не считается: сравниваются действия самой строки
        const own = r.querySelector('.list-row') ?? r;
        // кнопка на всю строку (строка-кнопка) не «действие справа»: сравниваются только узкие элементы
        const wide = own.getBoundingClientRect().width * 0.6;
        const els = ctl(own).filter(
          (e) => !e.closest('details:not([open])') && e.getBoundingClientRect().width < wide,
        );
        return els.length ? els.at(-1).getBoundingClientRect().right : null;
      })
      .filter((x) => x !== null);
    if (rights.length >= 2) {
      const spread = Math.max(...rights) - Math.min(...rights);
      if (spread > 3)
        problems.push(
          `кнопки действий в строках не на одной линии: ${name(c)} (разброс ${Math.round(spread)}px)`,
        );
    }
  }

  // 2. Значок/маркер и текст в одной строке: центры по вертикали совпадают
  for (const row of main.querySelectorAll('li, label, h2, h3, h4, div.flex')) {
    if (!visible(row)) continue;
    const cs = getComputedStyle(row);
    if (cs.display !== 'flex' && cs.display !== 'inline-flex') continue;
    const [a, b] = row.children;
    if (!a || !b) continue;
    const ra = a.getBoundingClientRect();
    if (!(ra.width <= 28 && ra.height <= 28 && ra.width > 0)) continue;
    // первая строка текста внутри второго элемента (в любой глубине)
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const textNode = walker.nextNode();
    let line;
    if (textNode) {
      const rg = document.createRange();
      rg.selectNodeContents(textNode);
      line = rg.getClientRects()[0];
    }
    if (!line || !line.height) continue;
    const d = Math.abs(ra.top + ra.height / 2 - (line.top + line.height / 2));
    if (d > 3) problems.push(`значок не по центру текста: ${name(row)} (сдвиг ${Math.round(d)}px)`);
  }

  // 3. Элементы управления, выходящие за край окна или своего блока
  for (const e of main.querySelectorAll('button, a.btn, select, input, textarea')) {
    if (!visible(e)) continue;
    // таблицы в своей прокручиваемой области (overflow-x-auto) прокручиваются внутри, а не расширяют страницу
    if (e.closest('.overflow-x-auto, .overflow-auto, .overflow-x-scroll')) continue;
    const r = e.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) problems.push(`выходит за край окна: ${name(e)}`);
    const card = e.closest('.card');
    if (card && !card.closest('.overflow-x-auto')) {
      const cr = card.getBoundingClientRect();
      if (r.right > cr.right + 1) problems.push(`выходит за край карточки: ${name(e)}`);
    }
  }

  // 4. Пустота внутри карточки: между содержимым и прижатой к низу кнопкой больше 72px
  for (const card of main.querySelectorAll('.card')) {
    const push = [...card.children].find(
      (c) => getComputedStyle(c).marginTop === 'auto' || c.className.includes?.('mt-auto'),
    );
    if (!push || !visible(push)) continue;
    const prev = push.previousElementSibling;
    if (!prev) continue;
    const gap = push.getBoundingClientRect().top - prev.getBoundingClientRect().bottom;
    if (gap > 72) problems.push(`пустота в карточке: ${name(card)} (${Math.round(gap)}px)`);
  }

  // 5. Контролы в одной строке одной высоты
  for (const row of main.querySelectorAll('div, li, form, td')) {
    if (!visible(row)) continue;
    const cs = getComputedStyle(row);
    if (!/flex|grid/.test(cs.display)) continue;
    const els = [...row.children].filter(
      (e) =>
        e.matches(
          'button, a.btn, a.btn-primary, select, input:not([type=checkbox]):not([type=radio])',
        ) && visible(e),
    );
    if (els.length < 2) continue;
    const lines = new Map();
    for (const e of els) {
      const r = e.getBoundingClientRect();
      const key = Math.round(r.top / 6);
      (lines.get(key) ?? lines.set(key, []).get(key)).push(r.height);
    }
    for (const hs of lines.values())
      if (hs.length > 1 && Math.max(...hs) - Math.min(...hs) > 2)
        problems.push(
          `контролы в строке разной высоты: ${name(row)} (${hs.map(Math.round).join('/')})`,
        );
  }
  return { problems: [...new Set(problems)].slice(0, 60) };
})();
