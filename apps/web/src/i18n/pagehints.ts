/**
 * Подсказки «?» в шапках страниц администрирования (по идентификатору раздела). Описание не пишется под названием:
 * его открывает значок рядом с названием. «@:ключ» — ссылка на существующий текст.
 */
export const ruPageHints = {
  pagehint: {
    overview: 'Состояние сервера, службы и то, что требует внимания.',
    resources: 'Нагрузка на процессор, память и диск сервера.',
    containers: 'Службы Arklock и база данных: работают ли они и сколько занимают.',
    backups:
      'Резервные копии базы и вложений. Ключ шифрования копий храните отдельно от самих копий.',
    logs: 'Журналы работы сервера: по ним ищут причину сбоя.',
    storage: 'Где лежат вложения и сколько места они занимают.',
    diagnostics: 'Самопроверка сервера: что работает и что нужно исправить.',
    certificates: 'Сертификаты сервера и срок их действия.',
    smtp: '@:mail.intro',
    ldap: '@:ldap.hint',
    sso: '@:sso.hint',
    saml: '@:saml.hint',
    syslog: '@:syslog.hint',
    webhooks:
      'Вебхуки позволяют Arklock автоматически уведомлять другие системы о событиях: например, о создании пользователя, изменении прав или ошибке безопасности. Во внешнюю систему уходит подписанное сообщение о событии журнала: кто, что и над каким объектом сделал. Пароли, записи и ключи в сообщения не попадают. Подпись: заголовок X-Arklock-Signature = sha256=HMAC-SHA256(секрет, «метка.тело»), метка — в X-Arklock-Timestamp.',
    invitations: '@:invite.hint',
    roles: '@:roles.intro',
    updates: 'Версия Arklock, проверка и установка обновлений, откат на прежнюю версию.',
    organization: '@:chief.intro',
    automation: '@:automation.hint',
    keys: 'Кто хранит ключи шифрования сотрудников из каталога: сами сотрудники (строгий режим) или сервер (простой вход). Выберите режим и прочитайте, что он меняет.',
    departments:
      'Подразделение — это люди (группа) и их сейф с паролями, созданные вместе. Выберите подразделение в списке, чтобы изменить название, руководителей, состав и сейфы. Новое создаётся ниже.',
    access:
      'Здесь видно, кто куда ходит. Введите имя сотрудника: сразу появятся его подразделения (руководитель, участник или гость), группы и сейфы с ролью и источником права: напрямую или через группу. Вкладка «По сейфу» (главный администратор) показывает обратное: кто имеет доступ к выбранному сейфу, кому выдан ключ и кому доступ дали на отдельные папки и записи, в том числе гостям. Здесь только сведения о доступе, пароли не показываются. Изменить доступ можно в карточке подразделения, в карточке сотрудника и в меню «Доступ» самой папки или записи.',
    vaults: '@:managed.inventoryHint',
    wizards: 'Пошаговые сценарии первоначальной настройки. Выполненные шаги отмечаются сами.',
    transfer: 'Перенос паролей: импорт из других менеджеров и экспорт.',
    shield: '@:shield.intro',
    users:
      'Все учётные записи. Откройте имя сотрудника: там его подразделения, группы, сейфы и сеансы. Подразделения и группы можно менять прямо в карточке.',
    circles:
      'Группа — набор людей, которому выдают доступ целиком: назначьте группе сейфы, и все участники их получат. Состав ведёт администратор или каталог домена.',
    ledger: 'Журнал действий: кто, что и когда сделал в Arklock.',
  },
};
export const enPageHints = {
  pagehint: {
    overview: 'Server status, services and what needs attention.',
    resources: 'Processor, memory and disk load of the server.',
    containers: 'Arklock services and the database: whether they run and how much they use.',
    backups:
      'Backups of the database and attachments. Keep the backup encryption key apart from the backups.',
    logs: 'Server logs: used to find the cause of a failure.',
    storage: 'Where attachments are stored and how much space they take.',
    diagnostics: 'Server self-check: what works and what needs fixing.',
    certificates: 'Server certificates and their validity.',
    smtp: '@:mail.intro',
    ldap: '@:ldap.hint',
    sso: '@:sso.hint',
    saml: '@:saml.hint',
    syslog: '@:syslog.hint',
    webhooks:
      'Webhooks let Arklock automatically notify other systems about events: for example, a user created, permissions changed or a security error. The external system receives a signed message about an activity-log event: who did what to which object. Passwords, entries and keys are never included. Signature: header X-Arklock-Signature = sha256=HMAC-SHA256(secret, "timestamp.body"), the timestamp is in X-Arklock-Timestamp.',
    invitations: '@:invite.hint',
    roles: '@:roles.intro',
    updates: 'The Arklock version, checking and installing updates, rolling back.',
    organization: '@:chief.intro',
    automation: '@:automation.hint',
    keys: 'Who holds the encryption keys of directory employees: the employees themselves (strict mode) or the server (simple sign-in). Pick a mode and read what it changes.',
    departments:
      'A department is the people (a group) and their password storage, created together. Choose a department in the list to change its name, heads, members and storages. A new one is created below.',
    access:
      'See who goes where. Type an employee name: their departments (head, member or guest), groups and vaults appear at once, with the role and where it comes from: directly or through a group. The “By vault” tab (chief administrator) shows the opposite: who can access the chosen vault, who has the key and who was given single folders and entries, guests included. Only access information is shown here, never passwords. Access is changed in the department card, the employee card and the Access menu of the folder or entry itself.',
    vaults: '@:managed.inventoryHint',
    wizards: 'Step-by-step first-time setup. Finished steps are ticked by themselves.',
    transfer: 'Moving passwords: import from other managers and export.',
    shield: '@:shield.intro',
    users:
      'All accounts. Open an employee’s name: their departments, groups, storages and sessions are there. Departments and groups can be changed right in the card.',
    circles:
      'A group is a set of people given access as a whole: assign storages to the group and every member gets them. An administrator or the domain directory keeps the membership.',
    ledger: 'Activity log: who did what and when in Arklock.',
  },
};
