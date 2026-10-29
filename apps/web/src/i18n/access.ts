/** Словарь подсказки «адрес без защищённого контекста» на странице входа. */
export const ruAccess = {
  access: {
    title: 'Браузер не разрешает шифрование на этом адресе',
    why: 'Мастер-пароль и ключи шифруются в браузере, а он делает это только по HTTPS или на localhost. Сервер Arklock при этом работает исправно: нужно открыть его по другому адресу.',
    openPublic: 'Открыть по защищённому адресу',
    publicHint: 'Администратор настроил публичный адрес: {url}',
    tunnel:
      'Если защищённого адреса ещё нет, вы можете войти через SSH-туннель. На своём компьютере выполните:',
    tunnelThen:
      'и откройте {url}. Это нужно только для первого входа или проверки, остальным сотрудникам нужен HTTPS.',
    admin:
      'Администратору: как настроить HTTPS, внешний прокси или локальный доступ — в разделе «Установка» документации (команда scripts/access.sh status показывает, что осталось сделать).',
    copy: 'Копировать',
  },
};
export const enAccess = {
  access: {
    title: 'The browser does not allow encryption on this address',
    why: 'The master password and keys are encrypted in the browser, and it does that only over HTTPS or on localhost. The Arklock server itself is healthy: open it at another address.',
    openPublic: 'Open at the secure address',
    publicHint: 'The administrator configured a public address: {url}',
    tunnel:
      'If there is no secure address yet, you can sign in through an SSH tunnel. On your own computer run:',
    tunnelThen:
      'and open {url}. This is only for the first sign-in or a check; everyone else needs HTTPS.',
    admin:
      'For the administrator: how to set up HTTPS, an external proxy or local access is in the “Installation” section of the documentation (scripts/access.sh status shows what is left to do).',
    copy: 'Copy',
  },
};
