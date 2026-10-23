/** Подсказки «i», сообщения об ошибках по кодам и страница помощи. Новые ключи; переименования терминов лежат в основных словарях. */
export const ruHelp = {
  help: {
    about: 'Пояснение',
    moreHint: 'Нажмите, чтобы узнать больше',
    title: 'Помощь',
    intro: 'Короткие ответы на частые вопросы. Подробности — в документации.',
    sections: {
      start: 'Начало работы',
      admin: 'Для администратора',
      terms: 'Что означают слова',
      docs: 'Документация',
    },
    start: {
      find: {
        q: 'Как найти пароль?',
        a: 'Введите название, логин или адрес в строку поиска вверху. Arklock ищет по всем сейфам, к которым у вас есть доступ.',
      },
      create: {
        q: 'Как сохранить новый пароль?',
        a: 'Откройте нужную папку, нажмите «+» над списком, заполните название, логин и пароль и сохраните. Кнопка «Генератор» подберёт стойкий пароль.',
      },
      copy: {
        q: 'Как скопировать пароль?',
        a: 'Откройте запись и нажмите «Копировать» рядом с паролем. Чтобы увидеть сам пароль, нажмите «Показать».',
      },
      totp: {
        q: 'Как добавить одноразовый код или файл?',
        a: 'При создании или изменении записи добавьте поле «Одноразовый код» и вставьте секрет из приложения. Файлы прикрепляются в карточке записи: вкладка «Данные», раздел «Файлы».',
      },
      share: {
        q: 'Как передать пароль человеку без доступа к сейфу?',
        a: 'В карточке записи откройте вкладку «Данные» и раздел «Внешняя ссылка»: создайте одноразовую ссылку с ограниченным сроком и числом просмотров. Ключ находится только в самой ссылке.',
      },
      locked: {
        q: 'Почему Arklock просит мастер-пароль?',
        a: 'Arklock закрывает доступ к данным после бездействия, по кнопке «Заблокировать», после выхода и при закрытии вкладки или браузера. Обновление страницы (F5) мастер-пароль не требует, пока сеанс действует. Срок бездействия вы выбираете в «Настройках».',
      },
      pending: {
        q: 'Мне назначили доступ, но записей не видно',
        a: 'Права назначены, но доступ к данным ещё не готов: ключ сейфа передаёт уполномоченный участник, когда открывает Arklock. Если записи не появились, попросите администратора сейфа открыть Arklock.',
      },
      forgot: {
        q: 'Я забыл мастер-пароль',
        a: 'На сервере его сбросить нельзя. Используйте ключ восстановления, который вы сохранили при регистрации: «Забыли пароль?» на странице входа.',
      },
    },
    admin: {
      newUser: {
        q: 'Как добавить сотрудника?',
        a: 'Администрирование → Новые пользователи → «Создать пользователя». Передайте сотруднику код активации: мастер-пароль он задаст сам.',
      },
      access: {
        q: 'Как дать доступ к сейфу?',
        a: 'Добавьте сотрудников в группу (Администрирование → Группы), затем в настройках сейфа назначьте группе роль. Права действуют сразу, доступ к данным готов после передачи ключа.',
      },
      personal: {
        q: 'Как отключить личные сейфы?',
        a: 'Администрирование → Настройки → «Сейфы и файлы» → «Личные сейфы». По умолчанию они запрещены; существующие данные не удаляются.',
      },
      ldap: {
        q: 'Как подключить Active Directory?',
        a: 'Администрирование → Каталог (LDAP): задайте адрес, учётную запись для чтения и базовый DN, проверьте соединение и свяжите группы каталога с группами Arklock.',
      },
      backup: {
        q: 'Как сделать резервную копию?',
        a: 'Администрирование → Резервные копии → «Создать копию». Ключ резервного шифрования хранится отдельно от копий: сохраните его вне сервера.',
      },
      update: {
        q: 'Как обновить Arklock?',
        a: 'Администрирование → Обновления. Перед обновлением создаётся резервная копия; при сбое система возвращается на прежнюю версию.',
      },
    },
    terms: {
      vault: {
        name: 'Сейф',
        text: 'Набор записей с общими правами доступа, например «Бухгалтерия». Внутри — папки и записи.',
      },
      personalVault: {
        name: 'Личный сейф',
        text: 'Сейф одного сотрудника. В корпоративной установке по умолчанию отключён администратором.',
      },
      space: {
        name: 'Пространство',
        text: 'Группа сейфов подразделения или проекта. Доступ к закрытому пространству назначается сотрудникам и группам.',
      },
      folder: {
        name: 'Папка',
        text: 'Раздел внутри сейфа для порядка. Права можно задать на папку или на отдельную запись.',
      },
      entry: {
        name: 'Запись',
        text: 'Один сохранённый секрет: логин и пароль, заметка, ключ API, сервер.',
      },
      group: {
        name: 'Группа',
        text: 'Список сотрудников, которому права выдаются сразу, например «Бухгалтерия».',
      },
      key: {
        name: 'Ключ шифрования сейфа',
        text: 'Секрет, которым зашифрованы записи сейфа. Его получает только тот, кому открыт доступ; сервер хранит лишь зашифрованное.',
      },
      recovery: {
        name: 'Ключ восстановления',
        text: 'Код, возвращающий доступ к вашей учётной записи, если вы забыли мастер-пароль. Показывается один раз при регистрации.',
      },
      corpRecovery: {
        name: 'Корпоративное восстановление',
        text: 'Заранее подготовленный пакет, с помощью которого уполномоченный администратор возвращает доступ к корпоративным сейфам, если все владельцы недоступны. Личные сейфы он не открывает.',
      },
      custodian: {
        name: 'Хранитель ключа',
        text: 'Участник сейфа, который может передавать ключ другим. Нужно не меньше двух.',
      },
      lock: {
        name: 'Блокировка',
        text: 'Arklock стирает расшифрованные данные из памяти браузера, для продолжения нужен мастер-пароль. Выход завершает сеанс полностью.',
      },
      mfa: {
        name: 'Второй фактор',
        text: 'Дополнительное подтверждение при входе: код из приложения или аппаратный ключ.',
      },
    },
    docs: {
      install: { label: 'Установка', file: 'INSTALL.md' },
      update: { label: 'Обновление', file: 'UPDATE.md' },
      backup: { label: 'Резервные копии и восстановление', file: 'BACKUP_AND_RESTORE.md' },
      directory: { label: 'Каталог и единый вход', file: 'DIRECTORY.md' },
      saml: { label: 'Вход по SAML', file: 'SAML.md' },
      corporate: {
        label: 'Корпоративный доступ и восстановление',
        file: 'administration/corporate-access.md',
      },
      revocation: {
        label: 'Что даёт и чего не даёт отзыв доступа',
        file: 'security/access-revocation.md',
      },
      extension: { label: 'Расширение браузера и телефон', file: 'EXTENSION.md' },
      cli: { label: 'Командная строка и токены', file: 'CLI.md' },
      troubleshooting: { label: 'Устранение неполадок', file: 'TROUBLESHOOTING.md' },
    },
  },
  hint: {
    registration: {
      text: 'Открытая регистрация позволяет любому, кто видит страницу входа, создать учётную запись. В корпоративной установке обычно оставляют «закрыта»: пользователей создаёт администратор.',
    },
    vaultCreators: {
      text: 'Кто может создавать новые корпоративные сейфы: только администраторы или любой сотрудник.',
    },
    mfaRequired: {
      text: 'Требует от пользователей второй фактор при входе: код из приложения-аутентификатора или ключ доступа.',
      details:
        'Если включить для всех, каждый настроит второй фактор при следующем входе. Сначала настройте его для своей учётной записи.',
    },
    sessionIdle: {
      text: 'Через сколько часов без действий сервер завершит сеанс и войти придётся заново.',
      details:
        'Это отдельно от блокировки в браузере: она закрывает доступ к расшифрованным данным и настраивается каждым пользователем в «Настройках».',
    },
    sessionMax: {
      text: 'Предельное время от входа до принудительного завершения сеанса, даже если человек работает. 0 — без отдельного ограничения.',
    },
    minLength: {
      text: 'Минимальная длина паролей, которые сотрудники сохраняют в записях. Проверяется в браузере при сохранении. 0 — без требования.',
      details: 'К мастер-паролю не относится: для него всегда действует собственное требование.',
    },
    classes: {
      text: 'Сколько видов символов обязательно в пароле записи: строчные, прописные, цифры, прочие (0–4). 0 — без требования.',
    },
    passwordMaxAge: {
      text: 'Через сколько дней пароль записи считается устаревшим в инспекторе безопасности. 0 — не проверять.',
    },
    trashDays: {
      text: 'Сколько дней удалённые записи лежат в корзине, прежде чем исчезнут безвозвратно.',
    },
    attachMax: { text: 'Наибольший размер одного прикрепляемого файла. 0 — вложения запрещены.' },
    vaultQuota: {
      text: 'Сколько мегабайт файлов можно хранить в одном сейфе. 0 — без ограничения.',
    },
    notify: {
      text: 'Письма пользователям о важных событиях безопасности в их учётной записи. Нужна настроенная почта.',
    },
    vaultRoles: {
      text: 'Читатель — только просмотр. Редактор — создаёт и изменяет записи. Администратор — ещё и управляет участниками и правами.',
      details:
        'Владелец — полный контроль, включая удаление и передачу сейфа. «Ограниченный» видит только то, что назначено ему отдельными правилами на папки и записи.',
    },
    accessLevels: {
      text: 'Чтение — просмотр записей и показ паролей. Редактирование — изменение записей и файлов. Управление — ещё и состав участников и права.',
      details:
        'Явный запрет сильнее разрешения. Он закрывает доступ на сервере, но не отзывает секреты, которые человек уже сохранил.',
    },
    reloadUnlock: {
      text: 'После обновления страницы (F5) сотрудник продолжает работу без мастер-пароля, пока сеанс действует.',
      details:
        'Ключи шифруются ключом, половина которого хранится в сеансе на сервере, а шифртекст — только во вкладке. Блокировка, выход, отзыв или истечение сеанса делают его бесполезным. Закрытие вкладки и перезапуск браузера по-прежнему требуют входа.',
    },
    pinUnlock: {
      text: 'Разрешает сотрудникам открывать Arklock после блокировки коротким PIN. PIN не заменяет мастер-пароль при входе.',
      details:
        'Сервер выдаёт часть ключа только после верного PIN и удаляет устройство после пяти неверных попыток. Смена мастер-пароля отключает все PIN. Выключение настройки сразу запрещает разблокировку PIN.',
    },
    groupAdminRole: {
      text: 'Все участники группы, в том числе пришедшие из каталога, получают разделы этой административной роли. Содержимое сейфов роль не открывает.',
      details:
        'Полномочия действуют, пока человек состоит в группе. Исключение из группы закрывает их сразу. Состав такой группы меняет только полный администратор.',
    },
    corpRecovery: {
      text: 'Заранее сохранённый офлайн-пакет позволяет уполномоченному администратору вернуть доступ к корпоративным сейфам, если все владельцы недоступны. Личные сейфы он не затрагивает.',
      details:
        'Работает только для сейфов, подключённых заранее. Скрытого ключа нет: пакет и парольную фразу хранит организация.',
    },
    ldapBaseDn: {
      text: 'Раздел каталога, в котором ищутся пользователи, например dc=company,dc=local.',
      details: 'Если не уверены, спросите администратора домена.',
    },
    ldapBindDn: {
      text: 'Служебная учётная запись только для чтения каталога: Arklock использует её, чтобы найти пользователя перед проверкой его пароля.',
    },
    ldapUserFilter: {
      text: 'Как найти пользователя по введённому имени: {u} заменяется введённым логином или почтой. Менять нужно редко.',
    },
    ldapPlaintext: {
      text: 'Пароли сотрудников пойдут по сети без шифрования. Допустимо только в изолированной сети; лучше ldaps:// или StartTLS.',
    },
    smtpSecurity: {
      text: 'TLS шифрует соединение сразу, STARTTLS — после начала связи. Без шифрования пароль и письма передаются открыто.',
    },
  },
  error: {
    forbidden:
      'У вас нет разрешения на это действие. Если оно вам нужно, обратитесь к администратору.',
    notFound: 'Объект не найден: возможно, его удалили или ваши права изменились.',
    validation: 'Проверьте введённые данные: часть полей заполнена неверно.',
    server:
      'Сервер сейчас не может выполнить действие. Повторите попытку позже; если ошибка повторяется, сообщите администратору.',
    reauth: 'Для этого действия подтвердите мастер-пароль.',
    personalDisabled: 'Личные сейфы отключены политикой организации.',
    keyMissing:
      'Доступ к записям ещё не готов: ключ сейфа не передан. Он будет передан, как только уполномоченный участник откроет Arklock.',
    pinWrong: 'Неверный PIN. Осталось попыток: {n}.',
    pinLocked: 'Слишком много неверных попыток: PIN отключён. Введите мастер-пароль.',
    pinDisabled:
      'Быстрая разблокировка PIN-кодом отключена администратором. Введите мастер-пароль.',
    pinGone: 'PIN на этом устройстве больше не действует. Введите мастер-пароль.',
    lastOwner: 'Сначала назначьте нового владельца сейфа.',
    spaceNotEmpty: 'В пространстве есть сейфы. Перенесите их или заархивируйте пространство.',
    spaceArchived: 'Пространство в архиве: сначала верните его из архива.',
    defaultSpace: 'Основное пространство нельзя удалить или изменить таким образом.',
    selfDisable: 'Нельзя отключить собственную учётную запись.',
    mailQueueFull: 'Очередь писем переполнена. Повторите позже.',
    smtpNotConfigured: 'Почта не настроена. Укажите сервер на вкладке «Почта».',
    ldapNotConfigured:
      'Каталог не настроен. Заполните и сохраните параметры на вкладке «Каталог (LDAP)».',
    publicUrl: 'Сначала задайте публичный адрес сервера в настройках установки.',
    notInTrash: 'Запись уже не в корзине.',
  },
  brand: {
    title: 'Пароли компании — под вашим ключом',
    lead: 'Arklock хранит учётные данные команды на ваших серверах. Шифрует и расшифровывает их только браузер сотрудника.',
    facts: {
      e2e: {
        title: 'Шифрование в браузере',
        text: 'Сервер получает только шифртекст и не может прочитать записи.',
      },
      keys: {
        title: 'Мастер-пароль не покидает устройство',
        text: 'Из него в браузере вычисляются ключи (Argon2id); восстановить его на сервере нельзя.',
      },
      host: {
        title: 'Размещение у вас',
        text: 'Установка одной командой, резервные копии и обновления из панели администратора.',
      },
    },
  },
  settings: {
    grantsWhere:
      'Здесь собраны отдельные правила для папок и записей этого сейфа. Новое правило назначается на вкладке «Доступ» самой папки или записи — кнопкой «Предоставить доступ».',
  },
  entryPanel: {
    levelHints: {
      reader: 'Видит запись, показывает и копирует пароль.',
      editor: 'Как чтение, а также изменяет запись, её поля и файлы.',
      manager: 'Как редактирование, а также назначает и отзывает права других.',
      none: 'Явный запрет: сильнее любого разрешения, в том числе через группу или папку.',
      owner: 'Полный контроль над сейфом.',
    },
  },
  kindFields: {
    service: 'Сервис или идентификатор ключа',
    noteText: 'Защищённый текст',
    more: 'Дополнительно: одноразовый код, свои поля, связи, метки, срок',
    url: {
      login: 'Адрес сайта или системы',
      server: 'Адрес или IP (протокол и порт — в адресе)',
      apikey: 'Адрес API',
      note: 'Адрес',
      custom: 'Адрес',
    },
  },
  personal: {
    title: 'Прежний личный сейф',
    intro:
      'Личные сейфы в организации отключены. Ваши прежние личные записи сохранены: {n}. Администратор не видит их содержимого и не может их удалить за вас.',
    exportHint:
      'Чтобы перенести записи в корпоративный сейф или выгрузить их, попросите администратора временно разрешить вам личный сейф.',
    eraseTitle: 'Удалить личный сейф',
    eraseWarn:
      'Будут удалены все записи, вложения и ключи вашего личного сейфа. Отменить это нельзя. В резервных копиях данные останутся до истечения срока их хранения.',
    eraseConfirm: 'Я понимаю, что записи будут удалены безвозвратно',
    password: 'Мастер-пароль для подтверждения',
    erase: 'Удалить безвозвратно',
    erased: 'Личный сейф удалён.',
  },
  network: {
    title: 'Сеть и доступ',
    intro: 'Адрес, по которому сотрудники открывают Arklock, и параметры публикации сервера.',
    publicUrl: 'Публичный адрес',
    publicUrlHint:
      'Полный адрес, по которому сотрудники открывают Arklock, например https://ark.example.com. Из него строятся ссылки в приглашениях и письмах, к нему привязаны ключи доступа (WebAuthn) и адреса возврата SSO и SAML. Сервер не берёт адрес из заголовков запроса.',
    sourcePanel: 'задан в панели',
    sourceInstall: 'из настроек установки',
    sourceNone: 'не задан',
    notSet: 'Не задан',
    set: 'Указать адрес',
    change: 'Изменить',
    noHttps:
      'Адрес без HTTPS: браузер не защитит мастер-пароль и ключи. Настройте HTTPS на reverse proxy.',
    openedHere: 'Вы открыли Arklock именно по этому адресу — он работает.',
    openedElsewhere:
      'Сейчас Arklock открыт по адресу {here}. Убедитесь, что публичный адрес тоже доступен сотрудникам.',
    useCurrent: 'Взять текущий адрес ({here})',
    effectPasskeys:
      'Ключи доступа ({n}) привязаны к прежнему адресу и перестанут работать: сотрудникам нужно будет добавить их заново.',
    effectOidc: 'В настройках провайдера OIDC нужно обновить адрес возврата.',
    effectSaml: 'В настройках провайдера SAML нужно обновить метаданные (Entity ID и адрес ACS).',
    effectLinks:
      'Новые приглашения и ссылки будут вести на новый адрес; уже отправленные — на прежний.',
    resetToInstall: 'Вернуть адрес установки ({url})',
    saved: 'Публичный адрес сохранён и применён без перезапуска.',
    invalid: {
      parse: 'Это не адрес. Пример: https://ark.example.com',
      credentials: 'В адресе не должно быть имени пользователя и пароля.',
      path: 'Укажите только схему, имя и порт, без пути и параметров: https://ark.example.com',
      https: 'Нужен адрес с HTTPS (http допустим только для localhost).',
    },
    listen: 'Адрес и порт публикации',
    listenHint:
      'Где сервер принимает соединения на хосте. Задаётся при установке: sudo ./install.sh --bind … --port … (повторный запуск сохраняет данные).',
    proxy: 'Доверенный reverse proxy',
    proxyHint:
      'Сколько прокси перед Arklock можно доверять при определении IP клиента. Меняется в файле установки (TRUSTED_PROXY_HOPS) с перезапуском.',
    https: 'HTTPS',
    httpsOn: 'Включён',
    httpsOff: 'Не включён',
    httpsHint:
      'HTTPS обеспечивает установщик (Let’s Encrypt или свой сертификат) либо внешний reverse proxy. Сертификаты и сроки — в разделе «Сертификаты».',
    hostNote:
      'Параметры хоста Arklock не меняет сам: настройки внешнего reverse proxy и Docker остаются под вашим контролем.',
  },
  profile: {
    close: 'Закрыть',
    groups: 'Группы',
    noGroups: 'Не состоит в группах.',
    vaults: 'Корпоративные сейфы (прямое участие)',
    noVaults: 'Нет прямого участия в корпоративных сейфах.',
    sessions: 'Активные сеансы: {n}',
    extras: 'Токенов API: {a} · внешних ссылок: {l}',
  },
  grantDlg: {
    open: 'Предоставить доступ',
    recipients: 'Получатели',
    searchPlaceholder: 'Имя, почта сотрудника или название группы',
    removeRecipient: 'Убрать',
    group: 'группа',
    picked: 'выбран',
    hasAccess: 'уже есть доступ',
    nothing: 'Никого не найдено',
    level: 'Уровень доступа',
    term: 'Срок',
    until: 'Действует до',
    terms: {
      none: 'Без ограничения',
      day: '1 день',
      week: '7 дней',
      month: '30 дней',
      date: 'До даты…',
    },
    submit: 'Предоставить доступ',
    done: 'Доступ предоставлен: {n}.',
    donePending:
      'Права назначены: {n}. Ключ сейфа будет передан, как только участник с правом управления откроет Arklock.',
  },
  ws: {
    vault: 'Сейф',
    actions: 'Действия',
    actionsTitle: 'Действия с сейфом и пространством',
    entryActions: 'Ещё действия с записью',
    moveEntry: 'Перенести в другой сейф',
    more: 'Подробнее',
    dismiss: 'Закрыть и больше не показывать',
    archiveFolder: 'В архив вместе с записями ({n})',
    folderActions: 'Действия с папкой',
    newSubfolder: 'Создать подпапку',
    collapse: 'Свернуть',
    expand: 'Развернуть',
    newFolderIn: 'Новая папка в «{name}»',
    newFolderRoot: 'Новая папка в корне сейфа',
    unarchiveFolder: 'Вернуть записи из архива ({n})',
    kindFilter: 'Тип записей',
    searchShort: 'Поиск',
    sort: 'Порядок',
  },
  corpReplace: {
    title: 'Замена офлайн-пакета восстановления',
    intro:
      'Если пакет или его парольная фраза утрачены или скомпрометированы, подготовьте новый. Прежний пакет действует, пока каждый защищённый сейф не будет переподключён к новому. После завершения замены старый пакет перестаёт работать.',
    start: 'Подготовить замену',
    pendingTitle: 'Замена подготовлена',
    pendingHint:
      'Попросите владельцев или администраторов каждого защищённого сейфа открыть его настройки и подключить новый пакет. Затем завершите замену.',
    connected: 'подключён к новому пакету',
    waiting: 'ожидает подключения',
    complete: 'Завершить замену',
    cancel: 'Отменить замену',
    done: 'Замена завершена: действует новый офлайн-пакет.',
    cancelled: 'Замена отменена, прежний пакет продолжает действовать.',
    confirmCancel: 'Отменить замену? Подключения к новому пакету будут удалены.',
    vaultTitle: 'Новый пакет восстановления (замена)',
    vaultEnroll: 'Подключить сейф к новому пакету',
    vaultDone: 'Сейф подключён к новому пакету.',
    vaultAck:
      'Я сверил(а) отпечаток нового пакета с тем, что показал администратор, и подключаю этот сейф к нему.',
  },
  pin: {
    title: 'Быстрая разблокировка PIN-кодом',
    hint: 'После блокировки экрана можно открыть Arklock коротким PIN вместо мастер-пароля. Вход в систему по-прежнему требует мастер-пароль.',
    off: 'Администратор не включил разблокировку PIN-кодом.',
    password: 'Мастер-пароль',
    pin: 'PIN (от 6 до 12 цифр)',
    repeat: 'Повторите PIN',
    enable: 'Включить на этом устройстве',
    disable: 'Отключить на этом устройстве',
    active: 'PIN включён на этом устройстве.',
    saved: 'PIN включён.',
    removed: 'PIN отключён.',
    format: 'PIN — от 6 до 12 цифр.',
    mismatch: 'PIN-коды не совпадают.',
    devices: 'Устройства с PIN',
    lastUsed: 'использовалось',
    never: 'ещё не использовалось',
    remove: 'Удалить',
    unlockWith: 'Разблокировать PIN-кодом',
    orPassword: 'Или введите мастер-пароль:',
    policy: 'Быстрая разблокировка PIN-кодом',
    reloadPolicy: 'Не запрашивать мастер-пароль после обновления страницы',
  },
  spaces: { defaultName: 'Организация' },
};

export const enHelp = {
  help: {
    about: 'What is this?',
    moreHint: 'Click for more',
    title: 'Help',
    intro: 'Short answers to common questions. See the documentation for details.',
    sections: {
      start: 'Getting started',
      admin: 'For administrators',
      terms: 'What the words mean',
      docs: 'Documentation',
    },
    start: {
      find: {
        q: 'How do I find a password?',
        a: 'Type a title, username or address into the search box at the top. Arklock searches every vault you can access.',
      },
      create: {
        q: 'How do I save a new password?',
        a: 'Open the folder, press “+” above the list, fill in the title, username and password, then save. The “Generator” button suggests a strong password.',
      },
      copy: {
        q: 'How do I copy a password?',
        a: 'Open the entry and press “Copy” next to the password. Press “Show” to see the password itself.',
      },
      totp: {
        q: 'How do I add a one-time code or a file?',
        a: 'When you create or edit an entry, add a “One-time code” field and paste the secret from your app. Files are attached in the entry card: “Data” tab, “Files” section.',
      },
      share: {
        q: 'How do I pass a password to someone without vault access?',
        a: 'In the entry card open the “Data” tab and the “External link” section: create a one-time link with a limited lifetime and number of views. The key is only inside the link.',
      },
      locked: {
        q: 'Why does Arklock ask for my master password?',
        a: 'Arklock locks your data after inactivity, when you press “Lock”, after signing out and when the tab or browser is closed. Reloading the page (F5) does not ask for the master password while the session is active. You choose the inactivity time in “Settings”.',
      },
      pending: {
        q: 'I was given access, but I see no entries',
        a: 'Access is assigned, but your data is not ready yet: an authorized member passes on the vault key when they open Arklock. If entries do not appear, ask a vault administrator to open Arklock.',
      },
      forgot: {
        q: 'I forgot my master password',
        a: 'It cannot be reset on the server. Use the recovery key you saved at registration: “Forgot your password?” on the sign-in page.',
      },
    },
    admin: {
      newUser: {
        q: 'How do I add an employee?',
        a: 'Administration → New users → “Create user”. Give the employee the activation code: they set their own master password.',
      },
      access: {
        q: 'How do I give access to a vault?',
        a: 'Add people to a group (Administration → Groups), then assign the group a role in the vault settings. Rights apply at once; data access is ready once the key is passed on.',
      },
      personal: {
        q: 'How do I turn off personal vaults?',
        a: 'Administration → Settings → “Vaults and files” → “Personal vaults”. They are denied by default; existing data is not deleted.',
      },
      ldap: {
        q: 'How do I connect Active Directory?',
        a: 'Administration → Directory (LDAP): enter the address, a read-only account and the base DN, test the connection and map directory groups to Arklock groups.',
      },
      backup: {
        q: 'How do I make a backup?',
        a: 'Administration → Backups → “Create backup”. The backup encryption key is kept apart from the backups: store it outside the server.',
      },
      update: {
        q: 'How do I update Arklock?',
        a: 'Administration → Updates. A backup is created first; if the update fails, the system returns to the previous version.',
      },
    },
    terms: {
      vault: {
        name: 'Vault',
        text: 'A set of entries with shared access rights, for example “Accounting”. It holds folders and entries.',
      },
      personalVault: {
        name: 'Personal vault',
        text: 'One employee’s own vault. In a corporate installation it is turned off by default.',
      },
      space: {
        name: 'Space',
        text: 'A group of vaults for a department or project. Access to a private space is given to people and groups.',
      },
      folder: {
        name: 'Folder',
        text: 'A section inside a vault for order. Rights can be set on a folder or on a single entry.',
      },
      entry: {
        name: 'Entry',
        text: 'One stored secret: a login and password, a note, an API key, a server.',
      },
      group: {
        name: 'Group',
        text: 'A list of people who receive rights together, for example “Accounting”.',
      },
      key: {
        name: 'Vault encryption key',
        text: 'The secret that encrypts the vault’s entries. Only people who are given access receive it; the server stores only encrypted data.',
      },
      recovery: {
        name: 'Recovery key',
        text: 'A code that restores your account if you forget the master password. Shown once at registration.',
      },
      corpRecovery: {
        name: 'Corporate recovery',
        text: 'A pre-made package that lets an authorized administrator restore access to corporate vaults when every owner is unavailable. It never opens personal vaults.',
      },
      custodian: {
        name: 'Key custodian',
        text: 'A vault member who can pass the key on to others. At least two are needed.',
      },
      lock: {
        name: 'Lock',
        text: 'Arklock erases decrypted data from browser memory; the master password is needed to continue. Signing out ends the session completely.',
      },
      mfa: {
        name: 'Second factor',
        text: 'An extra confirmation at sign-in: a code from an app or a hardware key.',
      },
    },
    docs: {
      install: { label: 'Installation', file: 'INSTALL.md' },
      update: { label: 'Updating', file: 'UPDATE.md' },
      backup: { label: 'Backups and restore', file: 'BACKUP_AND_RESTORE.md' },
      directory: { label: 'Directory and single sign-on', file: 'DIRECTORY.md' },
      saml: { label: 'SAML sign-in', file: 'SAML.md' },
      corporate: {
        label: 'Corporate access and recovery',
        file: 'administration/corporate-access.md',
      },
      revocation: {
        label: 'What revoking access does and does not do',
        file: 'security/access-revocation.md',
      },
      extension: { label: 'Browser extension and phone', file: 'EXTENSION.md' },
      cli: { label: 'Command line and tokens', file: 'CLI.md' },
      troubleshooting: { label: 'Troubleshooting', file: 'TROUBLESHOOTING.md' },
    },
  },
  hint: {
    registration: {
      text: 'Open registration lets anyone who can reach the sign-in page create an account. Corporate installations usually keep it closed: administrators create users.',
    },
    vaultCreators: {
      text: 'Who can create new corporate vaults: administrators only, or any employee.',
    },
    mfaRequired: {
      text: 'Requires a second factor at sign-in: a code from an authenticator app or a security key.',
      details:
        'If you require it for everyone, each person sets up a second factor at their next sign-in. Set it up for your own account first.',
    },
    sessionIdle: {
      text: 'After how many hours without activity the server ends the session and people must sign in again.',
      details:
        'This is separate from the lock in the browser, which hides decrypted data and is set by each user in “Settings”.',
    },
    sessionMax: {
      text: 'The longest time from sign-in to a forced sign-out, even for someone who is working. 0 means no separate limit.',
    },
    minLength: {
      text: 'The minimum length of passwords people save in entries. Checked in the browser when saving. 0 means no requirement.',
      details: 'It does not apply to the master password, which has its own fixed requirement.',
    },
    classes: {
      text: 'How many kinds of characters an entry password must contain: lower case, upper case, digits, other (0–4). 0 means no requirement.',
    },
    passwordMaxAge: {
      text: 'After how many days an entry password counts as outdated in the security inspector. 0 means do not check.',
    },
    trashDays: {
      text: 'How many days deleted entries stay in the trash before they are removed for good.',
    },
    attachMax: {
      text: 'The largest size of one attached file. 0 means attachments are not allowed.',
    },
    vaultQuota: { text: 'How many megabytes of files one vault can hold. 0 means no limit.' },
    notify: {
      text: 'Emails to users about important security events in their account. Requires configured mail.',
    },
    vaultRoles: {
      text: 'Reader — view only. Editor — creates and changes entries. Administrator — also manages members and rights.',
      details:
        'Owner has full control, including deleting and handing over the vault. “Limited” sees only what is assigned through separate rules on folders and entries.',
    },
    accessLevels: {
      text: 'Read — view entries and show passwords. Edit — change entries and files. Manage — also members and rights.',
      details:
        'An explicit deny beats an allow. It closes access on the server but does not take back secrets a person already saved.',
    },
    reloadUnlock: {
      text: 'After a page reload (F5) the employee keeps working without the master password while the session is active.',
      details:
        'Keys are encrypted with a key whose half is kept in the server session and the ciphertext only in the tab. Locking, signing out, revoking or expiring the session makes it useless. Closing the tab or restarting the browser still requires signing in.',
    },
    pinUnlock: {
      text: 'Lets employees open Arklock after a lock with a short PIN. The PIN does not replace the master password for signing in.',
      details:
        'The server releases part of the key only after the right PIN and deletes the device after five wrong attempts. Changing the master password turns off every PIN. Turning the setting off blocks PIN unlock at once.',
    },
    groupAdminRole: {
      text: 'Every group member, including people who come from the directory, gets the sections of this administrative role. The role does not open vault contents.',
      details:
        'The rights last while the person is in the group. Removing them from the group ends the rights at once. Only a full administrator changes the members of such a group.',
    },
    corpRecovery: {
      text: 'A pre-saved offline package lets an authorized administrator restore access to corporate vaults when every owner is unavailable. It does not touch personal vaults.',
      details:
        'It works only for vaults connected in advance. There is no hidden key: the organization keeps the package and its passphrase.',
    },
    ldapBaseDn: {
      text: 'The part of the directory where users are searched, for example dc=company,dc=local.',
      details: 'If you are not sure, ask your domain administrator.',
    },
    ldapBindDn: {
      text: 'A read-only service account for the directory: Arklock uses it to find a user before checking their password.',
    },
    ldapUserFilter: {
      text: 'How to find a user from the typed name: {u} is replaced by the typed username or email. Rarely needs changing.',
    },
    ldapPlaintext: {
      text: 'Employee passwords will cross the network unencrypted. Acceptable only on an isolated network; prefer ldaps:// or StartTLS.',
    },
    smtpSecurity: {
      text: 'TLS encrypts the connection from the start, STARTTLS after the connection begins. Without encryption the password and emails travel in the clear.',
    },
  },
  error: {
    forbidden:
      'You do not have permission for this action. If you need it, contact your administrator.',
    notFound: 'Not found: it may have been deleted or your access may have changed.',
    validation: 'Check what you entered: some fields are not valid.',
    server:
      'The server cannot do this right now. Try again later; if it keeps happening, tell an administrator.',
    reauth: 'Confirm your master password for this action.',
    personalDisabled: 'Personal vaults are turned off by your organization’s policy.',
    keyMissing:
      'Access to entries is not ready yet: the vault key has not been passed on. It will be as soon as an authorized member opens Arklock.',
    pinWrong: 'Wrong PIN. Attempts left: {n}.',
    pinLocked: 'Too many wrong attempts: the PIN is switched off. Enter your master password.',
    pinDisabled:
      'Quick unlock with a PIN is turned off by the administrator. Enter your master password.',
    pinGone: 'The PIN no longer works on this device. Enter your master password.',
    lastOwner: 'Assign a new owner of the vault first.',
    spaceNotEmpty: 'The space still has vaults. Move them or archive the space.',
    spaceArchived: 'The space is archived: restore it from the archive first.',
    defaultSpace: 'The default space cannot be deleted or changed this way.',
    selfDisable: 'You cannot disable your own account.',
    mailQueueFull: 'The mail queue is full. Try again later.',
    smtpNotConfigured: 'Mail is not configured. Enter the server on the “Mail” tab.',
    ldapNotConfigured:
      'The directory is not configured. Fill in and save the settings on the “Directory (LDAP)” tab.',
    publicUrl: 'Set the server’s public address in the installation settings first.',
    notInTrash: 'The entry is no longer in the trash.',
  },
  brand: {
    title: 'Company passwords, under your key',
    lead: 'Arklock keeps team credentials on your own servers. Only the employee’s browser encrypts and decrypts them.',
    facts: {
      e2e: {
        title: 'Encryption in the browser',
        text: 'The server only receives ciphertext and cannot read entries.',
      },
      keys: {
        title: 'The master password never leaves the device',
        text: 'Keys are derived from it in the browser (Argon2id); the server cannot recover it.',
      },
      host: {
        title: 'Hosted by you',
        text: 'One-command install, backups and updates from the admin panel.',
      },
    },
  },
  settings: {
    grantsWhere:
      'Here are the separate rules for folders and entries of this vault. A new rule is granted on the “Access” tab of the folder or entry itself, with the “Grant access” button.',
  },
  entryPanel: {
    levelHints: {
      reader: 'Sees the entry, shows and copies the password.',
      editor: 'Like read, and also changes the entry, its fields and files.',
      manager: 'Like edit, and also grants and revokes access for others.',
      none: 'Explicit deny: stronger than any allow, including through a group or folder.',
      owner: 'Full control of the vault.',
    },
  },
  kindFields: {
    service: 'Service or key identifier',
    noteText: 'Protected text',
    more: 'More: one-time code, own fields, links, tags, expiry',
    url: {
      login: 'Website or system address',
      server: 'Address or IP (protocol and port go in the address)',
      apikey: 'API address',
      note: 'Address',
      custom: 'Address',
    },
  },
  personal: {
    title: 'Previous personal vault',
    intro:
      'Personal vaults are turned off in your organization. Your previous personal entries are kept: {n}. Administrators cannot see their contents or delete them for you.',
    exportHint:
      'To move the entries to a corporate vault or export them, ask an administrator to temporarily allow your personal vault.',
    eraseTitle: 'Delete the personal vault',
    eraseWarn:
      'All entries, attachments and keys of your personal vault will be deleted. This cannot be undone. Backups keep the data until they expire.',
    eraseConfirm: 'I understand the entries will be deleted for good',
    password: 'Master password to confirm',
    erase: 'Delete for good',
    erased: 'The personal vault was deleted.',
  },
  network: {
    title: 'Network and access',
    intro: 'The address employees open Arklock at, and how the server is published.',
    publicUrl: 'Public address',
    publicUrlHint:
      'The full address employees open Arklock at, for example https://ark.example.com. Links in invitations and emails are built from it; passkeys (WebAuthn) and the SSO and SAML return addresses are bound to it. The server never takes it from request headers.',
    sourcePanel: 'set in the panel',
    sourceInstall: 'from the installation settings',
    sourceNone: 'not set',
    notSet: 'Not set',
    set: 'Set the address',
    change: 'Change',
    noHttps:
      'The address has no HTTPS: the browser will not protect the master password and keys. Set up HTTPS on the reverse proxy.',
    openedHere: 'You opened Arklock at exactly this address — it works.',
    openedElsewhere:
      'Arklock is open at {here} right now. Make sure the public address is reachable for employees too.',
    useCurrent: 'Use the current address ({here})',
    effectPasskeys:
      'Passkeys ({n}) are bound to the previous address and will stop working: employees will have to add them again.',
    effectOidc: 'Update the return address in the OIDC provider settings.',
    effectSaml: 'Update the metadata (Entity ID and ACS address) in the SAML provider settings.',
    effectLinks:
      'New invitations and links will point to the new address; ones already sent keep the old one.',
    resetToInstall: 'Return to the installation address ({url})',
    saved: 'The public address is saved and applied without a restart.',
    invalid: {
      parse: 'This is not an address. Example: https://ark.example.com',
      credentials: 'The address must not contain a user name or password.',
      path: 'Enter only the scheme, host and port, without a path or parameters: https://ark.example.com',
      https: 'An HTTPS address is required (http is allowed only for localhost).',
    },
    listen: 'Published address and port',
    listenHint:
      'Where the server accepts connections on the host. Set during installation: sudo ./install.sh --bind … --port … (running it again keeps the data).',
    proxy: 'Trusted reverse proxy',
    proxyHint:
      'How many proxies in front of Arklock are trusted to report the client IP. Changed in the installation file (TRUSTED_PROXY_HOPS) with a restart.',
    https: 'HTTPS',
    httpsOn: 'On',
    httpsOff: 'Off',
    httpsHint:
      'HTTPS is provided by the installer (Let’s Encrypt or your certificate) or an external reverse proxy. Certificates and expiry dates are in “Certificates”.',
    hostNote:
      'Arklock does not change host settings itself: the external reverse proxy and Docker stay under your control.',
  },
  profile: {
    close: 'Close',
    groups: 'Groups',
    noGroups: 'Not in any group.',
    vaults: 'Corporate vaults (direct membership)',
    noVaults: 'No direct membership in corporate vaults.',
    sessions: 'Active sessions: {n}',
    extras: 'API tokens: {a} · external links: {l}',
  },
  grantDlg: {
    open: 'Grant access',
    recipients: 'Recipients',
    searchPlaceholder: 'Employee name, email or group name',
    removeRecipient: 'Remove',
    group: 'group',
    picked: 'selected',
    hasAccess: 'already has access',
    nothing: 'Nobody found',
    level: 'Access level',
    term: 'Duration',
    until: 'Valid until',
    terms: {
      none: 'No limit',
      day: '1 day',
      week: '7 days',
      month: '30 days',
      date: 'Until date…',
    },
    submit: 'Grant access',
    done: 'Access granted: {n}.',
    donePending:
      'Rights assigned: {n}. The vault key will be passed on as soon as a member who can manage it opens Arklock.',
  },
  ws: {
    vault: 'Vault',
    actions: 'Actions',
    actionsTitle: 'Vault and space actions',
    entryActions: 'More entry actions',
    moveEntry: 'Move to another vault',
    more: 'Details',
    dismiss: 'Close and do not show again',
    archiveFolder: 'Archive with its entries ({n})',
    folderActions: 'Folder actions',
    newSubfolder: 'Create a subfolder',
    collapse: 'Collapse',
    expand: 'Expand',
    newFolderIn: 'New folder in “{name}”',
    newFolderRoot: 'New folder at the vault root',
    unarchiveFolder: 'Restore entries from the archive ({n})',
    kindFilter: 'Entry type',
    searchShort: 'Search',
    sort: 'Order',
  },
  corpReplace: {
    title: 'Replacing the offline recovery package',
    intro:
      'If the package or its passphrase is lost or compromised, prepare a new one. The old package keeps working until every protected vault is reconnected to the new one. After the replacement is completed the old package stops working.',
    start: 'Prepare a replacement',
    pendingTitle: 'Replacement prepared',
    pendingHint:
      'Ask the owners or administrators of each protected vault to open its settings and connect the new package. Then complete the replacement.',
    connected: 'connected to the new package',
    waiting: 'waiting to be connected',
    complete: 'Complete the replacement',
    cancel: 'Cancel the replacement',
    done: 'Replacement completed: the new offline package is now in force.',
    cancelled: 'Replacement cancelled: the previous package stays in force.',
    confirmCancel: 'Cancel the replacement? Connections to the new package will be removed.',
    vaultTitle: 'New recovery package (replacement)',
    vaultEnroll: 'Connect the vault to the new package',
    vaultDone: 'The vault is connected to the new package.',
    vaultAck:
      'I compared the fingerprint of the new package with the one the administrator showed and connect this vault to it.',
  },
  pin: {
    title: 'Quick unlock with a PIN',
    hint: 'After the screen locks you can open Arklock with a short PIN instead of the master password. Signing in still needs the master password.',
    off: 'The administrator has not turned on PIN unlock.',
    password: 'Master password',
    pin: 'PIN (6 to 12 digits)',
    repeat: 'Repeat the PIN',
    enable: 'Turn on for this device',
    disable: 'Turn off for this device',
    active: 'A PIN is set up on this device.',
    saved: 'PIN turned on.',
    removed: 'PIN turned off.',
    format: 'The PIN must be 6 to 12 digits.',
    mismatch: 'The PINs do not match.',
    devices: 'Devices with a PIN',
    lastUsed: 'last used',
    never: 'not used yet',
    remove: 'Delete',
    unlockWith: 'Unlock with the PIN',
    orPassword: 'Or enter the master password:',
    policy: 'Quick unlock with a PIN',
    reloadPolicy: 'Do not ask for the master password after a page reload',
  },
  spaces: { defaultName: 'Organization' },
};
