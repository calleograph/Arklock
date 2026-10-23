export const ruCorporate = {
  corporate: {
    accountIdentifier: 'Учётная запись или почта',
    summary: 'Обзор сейфа',
    mobileNavigation: 'Навигация по сейфу',
    mobile: { folders: 'Папки', list: 'Записи', details: 'Карточка' },
    globalSearch: 'Поиск по доступным сейфам',
    findUsers: 'Поиск по имени, учётной записи или источнику',
    allStatuses: 'Все статусы',
    findGroups: 'Поиск групп',
    addSeveral: 'Добавить нескольких сотрудников',
    removeSelected: 'Исключить выбранных',
    groupVaults: 'Назначенные сейфы',
    noGroupVaults: 'Группа не назначена корпоративным сейфам.',
    customRole: 'Пользовательская роль',
    searchPartial:
      'Не удалось проверить сейфов: {n}. Возможно, ключ ещё не выдан или доступ изменился.',
    refineSearch: 'Показаны первые 100 совпадений. Уточните запрос.',
    scope: 'Только доступные вам записи выбранного сейфа. Анализ выполняется в браузере.',
    total: 'Записей',
    favorites: 'Избранное',
    passwords: 'С паролем',
    unchecked: 'Не проверено',
    policyViolation:
      'Пароль не соответствует действующей политике. Проверьте требования во вкладке «Настройки».',
    moveVerificationFailed: 'Копия не прошла проверку. Исходная запись и её вложения сохранены.',
    moveCleanupFailed:
      'Исходная запись сохранена. Не удалось удалить неполную копию в целевом сейфе — проверьте её перед повторным переносом.',
    moveSourceFailed:
      'Копия и вложения проверены в целевом сейфе. Удаление исходной записи не подтверждено — проверьте оба сейфа перед повторной операцией.',
    noData: 'Нет данных',
    attention: 'Требуют внимания',
    analysis: 'Открыть инспектор',
    method:
      'Слабые — оценка стойкости ниже 2 из 4. Повторы сравниваются внутри сейфа. Возраст считается с последней смены пароля. Проверка утечек запускается отдельно.',
    policyUnavailable:
      'Не удалось загрузить политику. Возраст и соответствие требованиям не проверены.',
    personalRestricted:
      'Личные сейфы отключены в организации. В вашем прежнем личном сейфе сохранено записей: {n}. Их можно удалить в «Настройках»; для переноса попросите администратора временно разрешить личный сейф.',
    pending: 'Есть сейфы, для которых ещё ожидается выдача ключа.',
    continuity: 'Сохранность корпоративного доступа',
    continuityHint:
      'Хранитель — активный участник с текущим ключом и правом выдавать ключи. Для устойчивой работы назначьте минимум двух независимых хранителей.',
    custodians: 'Хранители ключа',
    noCustodian: 'Нет действующего хранителя',
    oneCustodian: 'Единственный хранитель',
    enoughCustodians: 'Несколько хранителей',
    openVault: 'Управление доступом',
    noVaults: 'Корпоративных сейфов пока нет. Создайте первый кнопкой «Новый сейф».',
    continuityLimit:
      'Проверка хранителей не заменяет резервные копии и проверку восстановления. Аварийный доступ возможен только для заранее подключённых сейфов при наличии офлайн-пакета и его парольной фразы.',
    recoveryStatus: {
      unconfigured: 'Корпоративное восстановление не настроено',
      disabled: 'Корпоративное восстановление отключено',
      ready: 'Корпоративный ключ восстановления актуален',
      missing: 'Сейф не подключён к восстановлению текущей версии',
    },
    risk: 'Отключение оставит корпоративные сейфы без активного хранителя ключа. Сначала передайте доступ другому уполномоченному сотруднику. При срочном отзыве доступа можно подтвердить риск.',
    journalPartial:
      'Клиентские события отражают сообщение браузера; сервер не может подтвердить фактическое использование секрета.',
  },
};

export const enCorporate = {
  corporate: {
    accountIdentifier: 'Username or email',
    summary: 'Vault overview',
    mobileNavigation: 'Vault navigation',
    mobile: { folders: 'Folders', list: 'Entries', details: 'Details' },
    globalSearch: 'Search accessible vaults',
    findUsers: 'Search name, account or sign-in source',
    allStatuses: 'All statuses',
    findGroups: 'Search groups',
    addSeveral: 'Add multiple members',
    removeSelected: 'Remove selected',
    groupVaults: 'Assigned vaults',
    noGroupVaults: 'No corporate vault assignments.',
    customRole: 'Custom role',
    searchPartial: 'Vaults not searched: {n}. A key may be pending or access may have changed.',
    refineSearch: 'Showing the first 100 matches. Refine your search.',
    scope: 'Only entries you can access in the selected vault. Analysis runs in your browser.',
    total: 'Entries',
    favorites: 'Favorites',
    passwords: 'With passwords',
    unchecked: 'Not checked',
    policyViolation:
      'The password does not meet the effective policy. Check the Settings tab for requirements.',
    moveVerificationFailed:
      'The copy could not be verified. The original entry and attachments are preserved.',
    moveCleanupFailed:
      'The original entry is preserved. An incomplete target copy could not be removed; inspect it before retrying.',
    moveSourceFailed:
      'The target copy and attachments were verified. Removal of the original was not confirmed; check both vaults before retrying.',
    noData: 'No data',
    attention: 'Need attention',
    analysis: 'Open inspector',
    method:
      'Weak passwords score below 2 out of 4. Reuse is checked within this vault. Age starts at the last password change. Breach checks run separately.',
    policyUnavailable: 'Policy could not be loaded. Age and policy compliance were not checked.',
    personalRestricted:
      'Your organization turned off personal vaults. Your previous personal vault still holds {n} entries. You can delete them in “Settings”; to move them, ask an administrator to temporarily allow your personal vault.',
    pending: 'Some vaults are still waiting for a key to be issued.',
    continuity: 'Corporate access continuity',
    continuityHint:
      'A custodian is an active member with the current key and permission to issue keys. Assign at least two independent custodians.',
    custodians: 'Key custodians',
    noCustodian: 'No active custodian',
    oneCustodian: 'Only one custodian',
    enoughCustodians: 'Multiple custodians',
    openVault: 'Manage access',
    noVaults: 'No corporate vaults yet. Create the first one with “New vault”.',
    continuityLimit:
      'Custodian checks do not replace backups and recovery drills. Emergency access requires prior vault enrollment and the offline package with its passphrase.',
    recoveryStatus: {
      unconfigured: 'Corporate recovery is not configured',
      disabled: 'Corporate recovery is disabled',
      ready: 'Corporate recovery key is current',
      missing: 'No recovery enrollment for the current vault version',
    },
    risk: 'Disabling this user would leave corporate vaults without an active key custodian. Transfer access to another authorized person first. You may acknowledge the risk for urgent revocation.',
    journalPartial:
      'Client events record browser reports; the server cannot confirm actual use of a secret.',
  },
};
