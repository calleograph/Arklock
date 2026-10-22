import {
  ApiError,
  ClientError,
  canDo,
  loadEntries,
  openAccount,
  passwordLogin,
  saveEntry,
  type Entry,
  type EntryInput,
  type Opened,
} from '@arklock/client';
import {
  generatePassphrase,
  generatePassword,
  parseTotpInput,
  totp,
  totpRemaining,
} from '@arklock/crypto';
import { fillInPage } from './fill';
import { isDowngrade, matchUrl } from './match';
import { loadPrefs, loadUnlocked, lock, saveUnlocked, savePrefs, touch, type Prefs } from './store';

const ru = navigator.language.toLowerCase().startsWith('ru');
const T = (en: string, ruText: string) => (ru ? ruText : en);

const app = document.getElementById('app')!;
let prefs: Prefs;
let opened: Opened | null = null;
let entries: Entry[] = [];
let tab: { id?: number; url: string } = { url: '' };
/** Перечитывает записи с сервера (после правки, по кнопке «Обновить»). */
let refreshAction: (() => Promise<boolean>) | null = null;

/** Небольшой помощник построения DOM без innerHTML (значения записей никогда не попадают в разметку). */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (typeof v === 'boolean') {
      if (v) el.setAttribute(k, '');
    } else el.setAttribute(k, v);
  }
  for (const c of children) el.append(c);
  return el;
}

function clear(): void {
  app.replaceChildren();
}

function normalizeServer(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '');
  const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local)
    throw new ClientError(
      T('The server address must use https://', 'Адрес сервера должен начинаться с https://'),
    );
  return u.origin;
}

async function currentTab(): Promise<{ id?: number; url: string }> {
  const params = new URLSearchParams(location.search);
  // targetUrl: окно открыто отдельной вкладкой (проверки, телефон) — целевая вкладка ищется по адресу
  const byUrl = params.get('targetUrl');
  if (byUrl) {
    const t = (await chrome.tabs.query({})).find((x) => x.url === byUrl);
    if (t) return { id: t.id, url: t.url ?? '' };
  }
  const target = params.get('target');
  if (target) {
    const t = await chrome.tabs.get(Number(target));
    return { id: t.id, url: t.url ?? '' };
  }
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return { id: t?.id, url: t?.url ?? '' };
}

// ---------------------------------------------------------------------------------------------- вход

function showLogin(message = ''): void {
  clear();
  let mode: 'password' | 'token' = 'password';
  const server = h('input', {
    id: 'server',
    type: 'text',
    placeholder: 'https://arklock.example.com',
    value: prefs.server,
    'data-testid': 'server',
  });
  const email = h('input', {
    id: 'email',
    type: 'text',
    autocomplete: 'username',
    value: prefs.email,
    'data-testid': 'email',
  });
  const token = h('input', {
    id: 'token',
    type: 'password',
    placeholder: 'akt_…',
    'data-testid': 'token',
  });
  const password = h('input', {
    id: 'password',
    type: 'password',
    autocomplete: 'current-password',
    'data-testid': 'password',
  });
  const code = h('input', {
    id: 'code',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    'data-testid': 'code',
  });
  const emailRow = h(
    'div',
    {},
    h('label', { for: 'email' }, T('Username or email', 'Учётная запись или почта')),
    email,
  );
  const tokenRow = h(
    'div',
    { hidden: true },
    h(
      'label',
      { for: 'token' },
      T('API token (SSO / directory accounts)', 'Токен API (для входа через SSO / каталог)'),
    ),
    token,
  );
  const codeRow = h(
    'div',
    { hidden: true },
    h(
      'label',
      { for: 'code' },
      T('Two-factor code or backup code', 'Код второго фактора или резервный код'),
    ),
    code,
  );
  const err = h('div', { class: 'err', role: 'alert', 'data-testid': 'error' }, message);
  const submit = h(
    'button',
    { class: 'primary', type: 'submit', 'data-testid': 'submit' },
    T('Unlock', 'Разблокировать'),
  );
  const switcher = h(
    'button',
    { type: 'button', 'data-testid': 'switch' },
    T('Use an API token instead', 'Войти по токену API'),
  );
  switcher.addEventListener('click', () => {
    mode = mode === 'password' ? 'token' : 'password';
    emailRow.hidden = mode === 'token';
    tokenRow.hidden = mode === 'password';
    switcher.textContent =
      mode === 'password'
        ? T('Use an API token instead', 'Войти по токену API')
        : T('Use e-mail and password', 'Войти по почте и паролю');
  });

  let pendingCode: ((v: string | null) => void) | null = null;
  const form = h(
    'form',
    {},
    h('h1', {}, 'Arklock'),
    h('label', { for: 'server' }, T('Server', 'Сервер')),
    server,
    emailRow,
    tokenRow,
    h('label', { for: 'password' }, T('Master password', 'Мастер-пароль')),
    password,
    codeRow,
    err,
    h('div', { class: 'row spread', style: 'margin-top:10px' }, switcher, submit),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (pendingCode) {
      pendingCode(code.value.trim());
      pendingCode = null;
      return;
    }
    err.textContent = '';
    submit.disabled = true;
    submit.textContent = T('Deriving keys…', 'Вычисление ключей…');
    try {
      const base = normalizeServer(server.value);
      // Доступ к серверу запрашивается у пользователя явно и только для этого адреса
      const origins = [`${base}/*`];
      // request вызывается первым и без предварительных await: Firefox требует вызова из обработчика действия пользователя
      if (!(await chrome.permissions.request({ origins })))
        throw new ClientError(
          T('Access to the server was not granted', 'Доступ к серверу не разрешён'),
        );
      let tokenValue: string;
      if (mode === 'token') {
        tokenValue = token.value.trim();
        if (!/^akt_[A-Za-z0-9_-]{43}$/.test(tokenValue))
          throw new ClientError(T('That is not an Arklock API token', 'Это не токен API Arklock'));
      } else {
        tokenValue = await passwordLogin(base, email.value.trim().toLowerCase(), password.value, {
          askCode: () =>
            new Promise((resolve) => {
              codeRow.hidden = false;
              submit.disabled = false;
              submit.textContent = T('Confirm', 'Подтвердить');
              code.focus();
              pendingCode = resolve;
            }),
        });
        submit.disabled = true;
      }
      opened = await openAccount({ server: base, token: tokenValue }, password.value);
      await saveUnlocked(opened, base, tokenValue);
      prefs = { ...prefs, server: base, email: email.value.trim().toLowerCase() };
      await savePrefs(prefs);
      await touch(prefs.lockMinutes);
      password.value = '';
      await showMain();
    } catch (e) {
      err.textContent =
        e instanceof ClientError
          ? e.message
          : `${T('Sign-in failed', 'Не удалось войти')}: ${e instanceof Error ? e.message : ''}`;
      submit.disabled = false;
      submit.textContent = T('Unlock', 'Разблокировать');
    }
  });
  app.append(form);
  (prefs.server ? (prefs.email ? password : email) : server).focus();
}

// ---------------------------------------------------------------------------------------------- список

async function copy(text: string, btn: HTMLButtonElement): Promise<void> {
  await navigator.clipboard.writeText(text);
  const old = btn.textContent;
  btn.textContent = T('Copied', 'Скопировано');
  setTimeout(() => (btn.textContent = old), 1200);
}

async function fill(e: Entry, status: HTMLElement): Promise<void> {
  status.className = 'err';
  if (tab.id === undefined)
    return void (status.textContent = T('No active page', 'Нет активной страницы'));
  const m = matchUrl(e.url, tab.url);
  if (
    m === 'none' &&
    !confirm(
      T(
        `This entry is for ${e.url || 'another site'}, but the page is ${tab.url}. Fill anyway?`,
        `Запись для ${e.url || 'другого сайта'}, а открыта страница ${tab.url}. Всё равно заполнить?`,
      ),
    )
  )
    return;
  if (
    m !== 'none' &&
    isDowngrade(e.url, tab.url) &&
    !confirm(
      T(
        'The page is not encrypted (http). Fill anyway?',
        'Страница не зашифрована (http). Всё равно заполнить?',
      ),
    )
  )
    return;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillInPage,
      args: [e.username, e.password, new URL(tab.url).origin],
    });
    const r = res?.result;
    status.className = r && (r.user || r.password) ? 'ok' : 'err';
    status.textContent = r?.moved
      ? T(
          'The page changed: open the extension again',
          'Страница сменилась: откройте расширение заново',
        )
      : r && (r.user || r.password)
        ? T('Filled', 'Заполнено')
        : T('No login form found on the page', 'На странице нет формы входа');
  } catch {
    status.textContent = T('Cannot fill this page', 'Эту страницу заполнить нельзя');
  }
}

function render(list: HTMLElement, filter: string, status: HTMLElement): void {
  const q = filter.trim().toLowerCase();
  const rank = (e: Entry) => ({ exact: 0, subdomain: 1, none: 2 })[matchUrl(e.url, tab.url)];
  const shown = entries
    .filter(
      (e) =>
        !q || `${e.title} ${e.username} ${e.url} ${e.tags.join(' ')}`.toLowerCase().includes(q),
    )
    .filter((e) => q || rank(e) < 2 || entries.length <= 8)
    .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
  list.replaceChildren();
  if (!shown.length)
    list.append(
      h(
        'li',
        { class: 'muted', 'data-testid': 'empty' },
        T(
          'Nothing found for this page. Type to search.',
          'Для этой страницы ничего нет. Введите запрос для поиска.',
        ),
      ),
    );
  for (const e of shown) {
    const m = matchUrl(e.url, tab.url);
    const totpOut = h('code', { 'data-testid': 'totp-out' });
    const userBtn = h('button', { type: 'button' }, T('User', 'Логин'));
    userBtn.addEventListener('click', () => void copy(e.username, userBtn));
    const pwBtn = h(
      'button',
      { type: 'button', 'data-testid': 'copy-password' },
      T('Password', 'Пароль'),
    );
    pwBtn.addEventListener('click', () => void copy(e.password, pwBtn));
    const fillBtn = h(
      'button',
      { type: 'button', class: 'primary', 'data-testid': 'fill' },
      T('Fill', 'Заполнить'),
    );
    fillBtn.addEventListener('click', () => void fill(e, status));
    const vault = opened?.vaults.find((v) => v.info.id === e.vaultId);
    const editBtn =
      vault && canDo(vault, 'entry.update') && e.kind === 'login'
        ? h('button', { type: 'button', 'data-testid': 'edit' }, T('Edit', 'Изменить'))
        : null;
    editBtn?.addEventListener('click', () => showEditor(e));
    const row = h(
      'li',
      { 'data-testid': 'entry' },
      h(
        'div',
        { class: 'row spread' },
        h('span', { class: 'title' }, e.title),
        m !== 'none' ? h('span', { class: 'tag' }, T('this site', 'этот сайт')) : '',
      ),
      h(
        'div',
        { class: 'muted' },
        `${e.username} · ${e.vaultName}${e.folder ? '/' + e.folder : ''}`,
      ),
      h('div', { class: 'row', style: 'margin-top:4px' }, fillBtn, userBtn, pwBtn, editBtn ?? ''),
    );
    if (e.totp) {
      const tb = h('button', { type: 'button', 'data-testid': 'totp' }, 'TOTP');
      tb.addEventListener('click', async () => {
        const p = parseTotpInput(e.totp);
        totpOut.textContent = `${await totp(p)} (${totpRemaining(p.period ?? 30)} ${T('s', 'с')})`;
      });
      row.lastElementChild!.append(tb, totpOut);
    }
    list.append(row);
  }
}

// ---------------------------------------------------------------------------------------------- создание и изменение

/** Форма записи входа. Значения шифруются в расширении (EntryInput → saveEntry); сервер получает шифртекст. */
function showEditor(existing?: Entry): void {
  if (!opened) return showLogin();
  const writable = opened.vaults.filter((v) =>
    canDo(v, existing ? 'entry.update' : 'entry.create'),
  );
  if (!writable.length) return void showMain();
  clear();
  const field = (id: string, label: string, attrs: Record<string, string> = {}) => {
    const input = h('input', { id, 'data-testid': id, autocomplete: 'off', ...attrs });
    return { input, row: [h('label', { for: id }, label), input] };
  };
  const title = field('f-title', T('Title', 'Название'), { type: 'text', maxlength: '200' });
  const user = field('f-username', T('Username', 'Логин'), { type: 'text' });
  const pass = field('f-password', T('Password', 'Пароль'), { type: 'password' });
  const url = field('f-url', T('Site address', 'Адрес сайта'), { type: 'text' });
  const totpF = field('f-totp', T('TOTP secret (optional)', 'Секрет TOTP (необязательно)'), {
    type: 'text',
  });
  const notes = h('textarea', { id: 'f-notes', 'data-testid': 'f-notes', rows: '3' });
  const vaultSel = h('select', { id: 'f-vault', 'data-testid': 'f-vault' });
  for (const v of writable)
    vaultSel.append(
      h(
        'option',
        { value: v.info.id },
        v.info.kind === 'locker' ? T('Locker', 'Сейф') : (v.info.name ?? v.info.id),
      ),
    );
  if (existing) {
    vaultSel.value = existing.vaultId;
    vaultSel.disabled = true; // запись остаётся в своём хранилище
    title.input.value = existing.title;
    user.input.value = existing.username;
    pass.input.value = existing.password;
    url.input.value = existing.url;
    totpF.input.value = existing.totp;
    notes.value = existing.notes;
  } else if (/^https?:/i.test(tab.url)) {
    try {
      url.input.value = new URL(tab.url).origin;
    } catch {
      /* адрес вкладки недоступен — поле остаётся пустым */
    }
  }
  const gen = h(
    'button',
    { type: 'button', 'data-testid': 'f-generate' },
    T('Generate', 'Сгенерировать'),
  );
  gen.addEventListener('click', () => {
    pass.input.value = generatePassword({ length: 20 });
    pass.input.type = 'text';
  });
  const toggle = h('button', { type: 'button', 'data-testid': 'f-show' }, T('Show', 'Показать'));
  toggle.addEventListener('click', () => {
    pass.input.type = pass.input.type === 'password' ? 'text' : 'password';
  });
  const err = h('div', { class: 'err', role: 'alert', 'data-testid': 'f-error' });
  const save = h(
    'button',
    { class: 'primary', type: 'submit', 'data-testid': 'f-save' },
    T('Save', 'Сохранить'),
  );
  const cancel = h('button', { type: 'button', 'data-testid': 'f-cancel' }, T('Cancel', 'Отмена'));
  cancel.addEventListener('click', () => void showMain());
  const form = h(
    'form',
    {},
    h('h1', {}, existing ? T('Edit entry', 'Изменение записи') : T('New entry', 'Новая запись')),
    h('label', { for: 'f-vault' }, T('Vault', 'Хранилище')),
    vaultSel,
    ...title.row,
    ...user.row,
    ...pass.row,
    h('div', { class: 'row' }, gen, toggle),
    ...url.row,
    ...totpF.row,
    h('label', { for: 'f-notes' }, T('Notes', 'Заметки')),
    notes,
    err,
    h('div', { class: 'row spread', style: 'margin-top:10px' }, cancel, save),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    save.disabled = true;
    try {
      const v = opened!.vaults.find((x) => x.info.id === vaultSel.value)!;
      const input: EntryInput = {
        title: title.input.value,
        username: user.input.value,
        password: pass.input.value,
        url: url.input.value,
        notes: notes.value,
        totp: totpF.input.value,
      };
      if (input.totp) parseTotpInput(input.totp); // неверный секрет отклоняется до отправки
      await saveEntry(opened!, v, input, existing);
      await touch(prefs.lockMinutes);
      await showMain();
    } catch (e) {
      save.disabled = false;
      if (e instanceof ApiError && e.status === 401) {
        opened = null;
        await lock();
        return showLogin(
          T(
            'Your session was ended by the server. Sign in again.',
            'Сеанс завершён сервером. Войдите снова.',
          ),
        );
      }
      err.textContent =
        e instanceof ApiError && e.code === 'version_conflict'
          ? T(
              'The entry was changed elsewhere. Cancel, refresh and edit again.',
              'Запись изменили в другом месте. Отмените, обновите список и повторите.',
            )
          : e instanceof ApiError && e.status === 403
            ? T(
                'You no longer have access to change this entry.',
                'У вас больше нет права менять эту запись.',
              )
            : e instanceof ClientError
              ? e.message
              : T('Check the TOTP secret.', 'Проверьте секрет TOTP.');
    }
  });
  app.append(form);
  title.input.focus();
}

async function showMain(): Promise<void> {
  opened = opened ?? (await loadUnlocked());
  if (!opened) return showLogin();
  tab = await currentTab();
  clear();
  const status = h('div', { class: 'muted', 'data-testid': 'status' });
  const search = h('input', {
    type: 'search',
    placeholder: T('Search…', 'Поиск…'),
    'data-testid': 'search',
  });
  const list = h('ul', { 'data-testid': 'list' });
  const gen = h('div', { hidden: true, class: 'row', 'data-testid': 'gen-box' });
  const genBtn = h(
    'button',
    { type: 'button', 'data-testid': 'generate' },
    T('Generate', 'Генератор'),
  );
  genBtn.addEventListener('click', () => {
    const pw = generatePassword({ length: 20 });
    const phrase = generatePassphrase({ words: 5 });
    const pwCode = h('code', { 'data-testid': 'gen-password' }, pw);
    const copyPw = h('button', { type: 'button' }, T('Copy', 'Копировать'));
    copyPw.addEventListener('click', () => void copy(pw, copyPw));
    const copyPh = h('button', { type: 'button' }, T('Phrase', 'Фраза'));
    copyPh.addEventListener('click', () => void copy(phrase, copyPh));
    gen.hidden = false;
    gen.replaceChildren(pwCode, copyPw, copyPh);
  });
  const newBtn = h(
    'button',
    { type: 'button', class: 'primary', 'data-testid': 'new-entry' },
    T('New', 'Новая'),
  );
  newBtn.addEventListener('click', () => showEditor());
  newBtn.hidden = !opened.vaults.some((v) => canDo(v, 'entry.create'));
  const refreshBtn = h(
    'button',
    { type: 'button', 'data-testid': 'refresh' },
    T('Refresh', 'Обновить'),
  );
  refreshBtn.addEventListener('click', () => void refreshAction?.());
  const lockBtn = h(
    'button',
    { type: 'button', 'data-testid': 'lock' },
    T('Lock', 'Заблокировать'),
  );
  lockBtn.addEventListener('click', async () => {
    opened = null;
    entries = [];
    await lock();
    showLogin();
  });
  const minutes = h('input', {
    type: 'number',
    min: '1',
    max: '120',
    value: String(prefs.lockMinutes),
    style: 'width:56px',
  });
  minutes.addEventListener('change', async () => {
    prefs = { ...prefs, lockMinutes: Math.min(120, Math.max(1, Number(minutes.value) || 5)) };
    await savePrefs(prefs);
    await touch(prefs.lockMinutes);
  });
  app.append(
    h(
      'div',
      { class: 'row spread' },
      h('h1', {}, 'Arklock'),
      h('span', { class: 'muted' }, opened.user.email),
    ),
    h('div', { class: 'muted', 'data-testid': 'host' }, tab.url ? new URL(tab.url).host : ''),
    search,
    list,
    status,
    gen,
    h(
      'div',
      { class: 'row spread', style: 'margin-top:8px' },
      newBtn,
      refreshBtn,
      genBtn,
      h(
        'label',
        { class: 'row muted', style: 'margin:0' },
        T('Auto-lock, min', 'Автоблокировка, мин'),
        minutes,
      ),
      lockBtn,
    ),
  );
  const load = async (): Promise<boolean> => {
    list.replaceChildren(h('li', { class: 'muted' }, T('Loading…', 'Загрузка…')));
    status.textContent = '';
    try {
      const all: Entry[] = [];
      const lost: string[] = [];
      for (const v of opened!.vaults) {
        try {
          all.push(...(await loadEntries(opened!, v)));
        } catch (e) {
          // доступ к отдельному хранилищу отозван, ключ сменился или оно удалено: остальные хранилища остаются доступными
          if (e instanceof ApiError && (e.status === 403 || e.status === 404))
            lost.push(v.info.name ?? v.info.kind);
          else throw e;
        }
      }
      entries = all;
      render(list, search.value, status);
      if (lost.length) {
        status.className = 'err';
        status.textContent = T(
          `Access changed for: ${lost.join(', ')}. Lock and unlock to refresh the vault list.`,
          `Доступ изменён: ${lost.join(', ')}. Заблокируйте и разблокируйте, чтобы обновить список хранилищ.`,
        );
      }
      return true;
    } catch (e) {
      // сессия отозвана (администратор завершил сеансы, пользователь отключён) или истекла: ключи стираются, нужен новый вход
      opened = null;
      entries = [];
      await lock();
      showLogin(
        e instanceof ApiError && e.status === 401
          ? T(
              'Your session was ended by the server. Sign in again.',
              'Сеанс завершён сервером. Войдите снова.',
            )
          : e instanceof ClientError
            ? e.message
            : T('Session expired', 'Сеанс истёк'),
      );
      return false;
    }
  };
  refreshAction = load;
  if (!(await load())) return;
  search.addEventListener('input', () => {
    render(list, search.value, status);
    void touch(prefs.lockMinutes);
  });
  void touch(prefs.lockMinutes);
}

async function init(): Promise<void> {
  prefs = await loadPrefs();
  opened = await loadUnlocked();
  if (opened) await showMain();
  else showLogin();
}
/** Сбой запуска не оставляет пустое окно: причина показывается пользователю (текст ошибки без данных записей). */
function fatal(e: unknown): void {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  clear();
  app.append(
    h(
      'div',
      { class: 'err', role: 'alert', 'data-testid': 'fatal' },
      `${T('Cannot start', 'Не удалось запустить')}: ${msg}`,
    ),
  );
}
window.addEventListener('unhandledrejection', (ev) => fatal(ev.reason));
init().catch(fatal);
