/**
 * Функция заполнения формы. Выполняется ВНУТРИ страницы (chrome.scripting.executeScript), поэтому самодостаточна:
 * не обращается к внешним переменным модуля. Заполняет только видимые поля, по действию пользователя.
 */
export function fillInPage(
  username: string,
  password: string,
): { user: boolean; password: boolean } {
  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getClientRects();
    const s = getComputedStyle(el);
    return r.length > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const setValue = (el: HTMLInputElement, value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const inputs = Array.from(document.querySelectorAll('input')).filter(
    (i) => !i.disabled && !i.readOnly && visible(i),
  );
  const pw = inputs.find((i) => i.type === 'password') ?? null;
  const textual = (i: HTMLInputElement) => ['text', 'email', 'tel', ''].includes(i.type);
  let user: HTMLInputElement | null = null;
  const scope = pw?.form ? Array.from(pw.form.querySelectorAll('input')) : inputs;
  if (pw) {
    // ближайшее текстовое поле перед полем пароля
    const before = scope.filter(
      (i) =>
        textual(i) &&
        visible(i) &&
        i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    user = before[before.length - 1] ?? null;
  } else {
    // первый шаг двухэтапной формы: только имя
    user =
      inputs.find((i) => /username|email/.test(i.autocomplete)) ??
      inputs.find((i) => textual(i) && /user|login|email|mail/i.test(`${i.name} ${i.id}`)) ??
      null;
  }
  if (user && username) setValue(user, username);
  if (pw && password) setValue(pw, password);
  return { user: !!user && !!username, password: !!pw && !!password };
}
