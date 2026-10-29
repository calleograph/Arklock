/** Подключение к каталогу (LDAP / Active Directory): причины ошибок полей, этапы проверки, сертификаты. */
export const ruDirectory = {
  dir: {
    url: {
      label: 'Адрес сервера',
      hint: 'ldaps://dc01.example.com:636 — защищённое соединение (рекомендуется); ldap://…:389 — только со StartTLS.',
      fixed: 'Адрес приведён к виду {url}.',
      empty: 'Укажите адрес сервера каталога.',
      spaces: 'В адресе есть пробел. Пример: ldaps://dc01.example.com:636',
      scheme: 'Адрес начинается с ldaps:// или ldap://. Пример: ldaps://dc01.example.com:636',
      credentials: 'Не указывайте учётную запись в адресе: для неё есть отдельное поле.',
      host: 'Имя сервера или IP-адрес указаны неверно. Пример: ldaps://dc01.example.com',
      port: 'Порт — число от 1 до 65535 (обычно 636 для ldaps://, 389 для ldap://).',
      path: 'После адреса и порта ничего не указывается: Base DN задаётся отдельным полем ниже.',
      plaintext:
        'ldap:// без StartTLS передаёт пароли открыто. Используйте ldaps://, включите StartTLS или явно разрешите передачу без шифрования (только изолированная сеть).',
    },
    starttls_with_ldaps: 'StartTLS нужен только для ldap://: соединение ldaps:// уже зашифровано.',
    bind: {
      label: 'Служебная учётная запись',
      hint: "Полный DN, user{'@'}domain или DOMAIN\\user. Оставьте пустым, если каталог разрешает анонимный поиск.",
      uses: 'Будет использовано: {value}',
      kind: {
        dn: 'Полный DN.',
        upn: "Формат user{'@'}domain (UPN) — Active Directory принимает его при входе.",
        netbios: 'Формат DOMAIN\\user — Active Directory принимает его при входе.',
        short: 'Короткое имя каталог не принимает: к нему добавлен домен из Base DN.',
      },
      format: "Учётная запись указана неверно: используйте DN, user{'@'}domain или DOMAIN\\user.",
      short_no_domain:
        "Короткое имя нельзя использовать: в Base DN нет домена (DC=…). Укажите user{'@'}domain или DOMAIN\\user.",
    },
    password: {
      keep: 'задан — оставьте пустым, чтобы не менять',
      reentry:
        'Адрес сервера изменён: введите пароль служебной учётной записи заново. Сохранённый пароль не отправляется на другой сервер.',
      clear: 'Удалить сохранённый пароль',
    },
    baseDn: {
      required: 'Укажите Base DN — откуда искать пользователей. Пример: DC=example,DC=com',
    },
    filter: {
      placeholder: "Фильтр должен содержать {'{u}'} — на это место подставляется введённое имя.",
      parens:
        "Фильтр LDAP записывается в скобках, например (&(objectClass=user)(sAMAccountName={'{u}'})).",
    },
    cert: {
      label: 'Сертификат центра сертификации',
      hint: 'Файл .cer, .crt или .pem (PEM или DER определяются автоматически). Нужен корневой и, если есть, промежуточный центр, которым подписан сертификат контроллера домена.',
      upload: 'Загрузить сертификат',
      paste: 'Вставить текстом (PEM)',
      clear: 'Убрать сертификат',
      none: 'Свой центр не загружен: сертификат сервера проверяется по системным центрам.',
      kind: {
        root: 'Корневой центр',
        intermediate: 'Промежуточный центр',
        leaf: 'Сертификат сервера, а не центра',
      },
      leafWarn:
        'Это сертификат самого сервера. Для проверки нужен центр сертификации, которым он подписан (корневой и промежуточный).',
      issuer: 'Издатель',
      valid: 'Действует',
      days: 'осталось {n} дн.',
      expired: 'срок истёк',
      notYet: 'ещё не начал действовать',
      chainOk: 'Цепочка до корневого центра проверена.',
      chainMissing:
        'Издатель не загружен: добавьте в тот же файл или вставьте следующим сертификат центра «{issuer}».',
      problem: {
        empty: 'Файл пуст.',
        too_large: 'Файл слишком большой для сертификата (больше 256 КБ).',
        private_key:
          'В файле закрытый ключ или контейнер с ключом (.pfx, .p12). Загрузите только сертификат — открытую часть (.cer, .crt, .pem).',
        not_certificate:
          'Это не сертификат X.509. Нужен файл .cer, .crt или .pem с сертификатом центра.',
        too_many: 'В файле больше 20 сертификатов.',
        all_expired: 'Срок действия всех сертификатов в файле истёк.',
        not_ca: 'Это сертификат сервера, а нужен центр сертификации.',
      },
    },
    insecure: {
      plaintext:
        'Пароли сотрудников пойдут по сети открытым текстом. Включайте только в изолированной сети; сохранение требует подтверждения паролем главного администратора.',
      tls: 'Только для диагностики: подлинность сервера не проверяется, и пароли сотрудников может перехватить подменный сервер. Сохранение требует подтверждения паролем главного администратора.',
    },
    check: {
      run: 'Проверить подключение',
      note: 'Проверяется то, что сейчас в форме (сохранять не обязательно). Просмотр каталога и синхронизация используют сохранённые настройки.',
      ok: 'Подключение работает.',
      fail: 'Проверка остановилась на этапе «{stage}».',
      details: 'Подробности',
      skipped: 'пропущено',
    },
    stage: {
      config: 'Настройки',
      dns: 'Имя сервера (DNS)',
      tcp: 'Соединение',
      tls: 'TLS и сертификат',
      bind: 'Вход служебной учётной записи',
      base: 'Base DN',
      filter: 'Фильтр пользователей',
      users: 'Поиск пользователей',
      groups: 'Группы из сопоставления',
    },
    result: {
      config: { ok: 'Адрес {url}, учётная запись {account}.' },
      dns: {
        ok: '{host} → {address}',
        dns: 'Имя «{host}» не найдено в DNS. Проверьте имя сервера и DNS на сервере Arklock.',
      },
      tcp: {
        ok: 'Соединение с {host}:{port} установлено.',
        refused:
          'Порт {port} на {host} закрыт: служба каталога не слушает его или соединение отклонено межсетевым экраном.',
        timeout: 'Нет ответа от {host}:{port}: проверьте маршрут и межсетевой экран.',
        unreachable: 'Сервер {host} недоступен из сети сервера Arklock.',
        reset: 'Соединение с {host}:{port} разорвано сервером.',
        unavailable: 'Нет соединения с {host}:{port}.',
      },
      tls: {
        ok: 'TLS {protocol}: сертификат «{subject}» (издатель «{issuer}») проверен.',
        pinned:
          'TLS {protocol}: сервер предъявил сертификат, которому вы доверяете (отпечаток совпал).',
        plaintext: 'Без шифрования: пароли передаются открыто.',
        unverified: 'Проверка сертификата отключена: подлинность сервера не подтверждена.',
        cert_untrusted:
          'Сертификат сервера не подтверждён: загрузите корневой и промежуточный центры, которыми он подписан (поле «Сертификат центра сертификации»).',
        cert_name:
          'Сертификат выдан на другое имя ({names}). Подключайтесь по имени из сертификата, а не по IP-адресу или другому имени.',
        cert_expired:
          'Срок действия сертификата сервера истёк. Его нужно обновить на контроллере домена.',
        cert_not_yet_valid:
          'Сертификат сервера ещё не начал действовать: проверьте часы на серверах.',
        starttls_failed:
          'Сервер не выполнил StartTLS: используйте ldaps:// (порт 636) или включите StartTLS на сервере.',
        tls_handshake:
          'Защищённое соединение не установлено: на этом порту нет LDAPS или протоколы не совпадают.',
        timeout: 'Сервер не завершил установку защищённого соединения.',
      },
      bind: {
        ok: 'Вход выполнен: {account}.',
        anonymous: 'Анонимный вход: служебная учётная запись не задана.',
        invalid_credentials:
          "Каталог отклонил учётную запись или пароль (у Active Directory — код 52e). Проверьте пароль и имя: DN, user{'@'}domain или DOMAIN\\user.",
        account_not_found: 'Учётная запись «{account}» не найдена в каталоге (код 525).',
        account_locked: 'Учётная запись заблокирована после неверных попыток (код 775).',
        account_disabled: 'Учётная запись отключена в каталоге (код 533).',
        account_expired: 'Срок действия учётной записи истёк (код 701).',
        password_expired: 'Срок действия пароля истёк (код 532): смените его в каталоге.',
        password_must_change:
          'Пароль нужно сменить при следующем входе (код 773): смените его в каталоге.',
        account_restriction:
          'Вход запрещён ограничениями учётной записи (время входа, рабочие станции).',
        password_missing: 'Пароль служебной учётной записи не задан.',
        strong_auth_required:
          'Каталог требует защищённого входа (подписывания LDAP): используйте ldaps:// или StartTLS.',
        confidentiality_required: 'Каталог требует шифрования: используйте ldaps:// или StartTLS.',
        inappropriate_auth: 'Каталог не принимает этот способ входа для учётной записи.',
        invalid_dn: 'Учётная запись указана неверно: проверьте DN.',
        unwilling: 'Каталог отказался выполнить вход (например, пустой пароль).',
        unavailable: 'Каталог занят или недоступен. Повторите позже.',
        ldap_error: 'Каталог отклонил вход.',
      },
      base: {
        ok: '{baseDn} доступен для чтения.',
        no_such_object:
          'Base DN «{baseDn}» не найден. Проверьте значение (пример: DC=example,DC=com).',
        insufficient_access: 'У служебной учётной записи нет прав на чтение {baseDn}.',
        invalid_dn: 'Base DN записан неверно.',
        ldap_error: 'Чтение Base DN не удалось.',
      },
      filter: {
        ok: 'Фильтр работает.',
        filter_invalid: 'Каталог не принял фильтр: проверьте скобки и имена атрибутов.',
        ldap_error: 'Поиск по фильтру не удался.',
        insufficient_access: 'Нет прав на поиск пользователей.',
      },
      users: {
        ok: 'Пользователи найдены (например, {sample}).',
        none: 'По фильтру не найдено ни одного пользователя: проверьте фильтр и Base DN.',
      },
      groups: {
        ok: 'Все группы из сопоставления ({total}) найдены.',
        none_mapped: 'Группы не сопоставлены.',
        missing: 'Не найдено групп: {missing} из {total}. Список — в подробностях.',
      },
    },
    reauth: {
      title: 'Подтвердите снижение защиты',
      text: 'Включается режим без шифрования или без проверки сертификата. Подтвердите паролем разблокировки сейфов (подтверждение действует 15 минут).',
      password: 'Пароль разблокировки сейфов',
      ok: 'Подтвердить и сохранить',
    },
    saved: 'Настройки подключения сохранены.',
    steps: {
      connection: '1. Подключение к каталогу',
      connectionHint:
        'Адрес контроллера домена, сертификат (если нужен) и служебная учётная запись для поиска сотрудников. Проверьте и сохраните.',
      login: '2. Вход сотрудников',
      loginHint:
        'Кто может входить доменной учётной записью. Затем проверьте вход реального сотрудника: это подтверждает, что вход готов.',
      advanced: '3. Дополнительно',
      advancedHint:
        'Синхронизация, сопоставление групп, сведения о сотрудниках, фильтр поиска и просмотр каталога. Для входа не обязательны.',
    },
    type: { label: 'Каталог', ad: 'Active Directory', ldap: 'Другой LDAP-каталог' },
    special: 'Особые случаи: StartTLS, без шифрования, без проверки сертификата',
    baseDnAuto: 'Определяется по каталогу при проверке подключения (можно изменить).',
    baseDnDetected: 'Определено по каталогу: {baseDn}',
    saveConnection: 'Сохранить подключение',
    status: {
      notSaved: 'Подключение ещё не сохранено.',
      connectionOk: 'Подключение проверено {at}.',
      connectionFail: 'Последняя проверка подключения не прошла ({at}).',
      connectionUnknown: 'Подключение сохранено, но не проверено.',
      loginOff: 'Вход сотрудников выключен.',
      loginOn: 'Вход сотрудников включён.',
      loginOk: 'Вход сотрудника проверен {at}.',
      loginUnchecked: 'Вход сотрудника ещё не проверялся: проверьте его на шаге 2.',
      loginFail: 'Последняя проверка входа не прошла ({at}).',
      extras: 'Дополнительно: групп Arklock сопоставлено {groups}, синхронизация {sync}.',
      syncOn: 'включена',
      syncOff: 'выключена',
    },
    enable: 'Разрешить вход доменным учётным записям',
    access: {
      label: 'Кто может входить',
      all: 'Все действующие учётные записи каталога (найденные фильтром; отключённые не входят)',
      groups:
        'Только участники выбранных групп каталога (с учётом вложенных групп Active Directory)',
      required: 'Выберите, кто может входить: доступ всем не открывается без вашего решения.',
      groupsRequired: 'Добавьте хотя бы одну группу или выберите «Все действующие учётные записи».',
      groupDn: 'DN группы, например CN=Сотрудники,OU=Группы,DC=example,DC=com',
      addGroup: 'Добавить группу',
      findGroup: 'Найти группу в каталоге',
      legacy: 'Подключение работало так до версии 1.87.0: входят все, кого находит фильтр.',
    },
    provision: 'Создавать учётную запись Arklock при первом входе сотрудника',
    provisionHint:
      'При первом входе сотрудник сам задаёт пароль разблокировки сейфов: ключи шифрования создаются в его браузере. Доменный пароль только подтверждает личность и не сохраняется.',
    loginTest: {
      title: 'Проверить вход сотрудника',
      username: "Учётная запись сотрудника (логин, DOMAIN\\логин или логин{'@'}домен)",
      password: 'Пароль сотрудника в домене',
      run: 'Проверить вход',
      note: 'Пароль проверяет каталог; он не сохраняется и не записывается в журнал. Учётная запись в Arklock не создаётся.',
      needSave: 'Сначала сохраните подключение.',
      found: 'Найден: {name} <{email}>, групп: {groups}.',
      reason: {
        ok: 'Вход работает: сотрудник может войти в Arklock.',
        not_allowed:
          'Пароль верный, но учётная запись не входит в разрешённые группы: вход будет отклонён.',
        local_exists:
          'В Arklock уже есть локальная учётная запись с этим адресом: она не присоединяется автоматически.',
        blocked_in_arklock: 'Учётная запись сотрудника заблокирована в Arklock.',
        not_provisioned:
          'Пароль верный, но создание учётных записей при первом входе выключено: сотрудник не сможет войти впервые.',
        login_disabled: 'Пароль верный, но вход сотрудников выключен (флажок выше).',
        user_not_found:
          'Сотрудник не найден: проверьте логин, Base DN и фильтр. Отключённые учётные записи не находятся.',
        ambiguous_user: 'Найдено несколько учётных записей: уточните логин или фильтр.',
        account_disabled: 'Учётная запись отключена в каталоге.',
        no_email: 'У учётной записи нет адреса почты в каталоге: Arklock не может её создать.',
        password_missing: 'Введите пароль сотрудника.',
      },
    },
    trust: {
      button: 'Доверять этому сертификату',
      confirm:
        'Доверять сертификату «{subject}»?\n\nОтпечаток SHA-256:\n{fingerprint}\n\nСверьте отпечаток с сертификатом контроллера домена. Подключение будет принимать только этот сертификат — даже самоподписанный или выданный на другое имя.',
      hint: 'Если это сертификат вашего контроллера домена, ему можно доверять по отпечатку.',
      pinned: 'Доверенный сертификат сервера: отпечаток {fingerprint}',
      remove: 'Перестать доверять',
    },
    browse: { activeOnly: 'Только действующие учётные записи', more: 'Показать ещё' },
  },
};

export const enDirectory = {
  dir: {
    url: {
      label: 'Server address',
      hint: 'ldaps://dc01.example.com:636 — encrypted (recommended); ldap://…:389 — only with StartTLS.',
      fixed: 'The address was normalised to {url}.',
      empty: 'Enter the directory server address.',
      spaces: 'The address contains a space. Example: ldaps://dc01.example.com:636',
      scheme: 'The address starts with ldaps:// or ldap://. Example: ldaps://dc01.example.com:636',
      credentials: 'Do not put the account into the address: it has its own field.',
      host: 'The server name or IP address is not valid. Example: ldaps://dc01.example.com',
      port: 'The port is a number from 1 to 65535 (usually 636 for ldaps://, 389 for ldap://).',
      path: 'Nothing follows the address and port: the Base DN has its own field below.',
      plaintext:
        'ldap:// without StartTLS sends passwords in the clear. Use ldaps://, enable StartTLS or explicitly allow unencrypted transfer (isolated network only).',
    },
    starttls_with_ldaps:
      'StartTLS is only for ldap://: an ldaps:// connection is already encrypted.',
    bind: {
      label: 'Service account',
      hint: "Full DN, user{'@'}domain or DOMAIN\\user. Leave empty if the directory allows anonymous search.",
      uses: 'Will be used: {value}',
      kind: {
        dn: 'Full DN.',
        upn: "user{'@'}domain (UPN) — Active Directory accepts it for sign-in.",
        netbios: 'DOMAIN\\user — Active Directory accepts it for sign-in.',
        short: 'The directory does not accept a short name: the domain from the Base DN is added.',
      },
      format: "The account is not valid: use a DN, user{'@'}domain or DOMAIN\\user.",
      short_no_domain:
        "A short name cannot be used: the Base DN has no domain (DC=…). Enter user{'@'}domain or DOMAIN\\user.",
    },
    password: {
      keep: 'set — leave empty to keep',
      reentry:
        'The server address changed: enter the service account password again. The saved password is never sent to another server.',
      clear: 'Delete the saved password',
    },
    baseDn: { required: 'Enter the Base DN — where to look for users. Example: DC=example,DC=com' },
    filter: {
      placeholder: "The filter must contain {'{u}'} — the entered name goes there.",
      parens:
        "An LDAP filter is written in parentheses, e.g. (&(objectClass=user)(sAMAccountName={'{u}'})).",
    },
    cert: {
      label: 'Certificate authority certificate',
      hint: 'A .cer, .crt or .pem file (PEM or DER is detected automatically). Use the root and, if any, intermediate authority that signed the domain controller certificate.',
      upload: 'Upload certificate',
      paste: 'Paste as text (PEM)',
      clear: 'Remove certificate',
      none: 'No own authority uploaded: the server certificate is checked against system authorities.',
      kind: {
        root: 'Root authority',
        intermediate: 'Intermediate authority',
        leaf: 'A server certificate, not an authority',
      },
      leafWarn:
        'This is the server’s own certificate. Verification needs the authority that signed it (root and intermediate).',
      issuer: 'Issuer',
      valid: 'Valid',
      days: '{n} days left',
      expired: 'expired',
      notYet: 'not valid yet',
      chainOk: 'The chain up to the root authority is verified.',
      chainMissing:
        'The issuer is not uploaded: add the certificate of “{issuer}” to the same file or paste it next.',
      problem: {
        empty: 'The file is empty.',
        too_large: 'The file is too large for a certificate (over 256 KB).',
        private_key:
          'The file contains a private key or a key container (.pfx, .p12). Upload only the certificate — the public part (.cer, .crt, .pem).',
        not_certificate:
          'This is not an X.509 certificate. Use a .cer, .crt or .pem file with the authority certificate.',
        too_many: 'The file has more than 20 certificates.',
        all_expired: 'Every certificate in the file has expired.',
        not_ca: 'This is a server certificate; a certificate authority is needed.',
      },
    },
    insecure: {
      plaintext:
        'Employee passwords will travel in the clear. Use only in an isolated network; saving requires confirmation by the chief administrator’s password.',
      tls: 'Diagnostics only: the server identity is not verified, and a fake server could capture employee passwords. Saving requires confirmation by the chief administrator’s password.',
    },
    check: {
      run: 'Check connection',
      note: 'What is in the form now is checked (no need to save first). Directory browsing and sync use the saved settings.',
      ok: 'The connection works.',
      fail: 'The check stopped at “{stage}”.',
      details: 'Details',
      skipped: 'skipped',
    },
    stage: {
      config: 'Settings',
      dns: 'Server name (DNS)',
      tcp: 'Connection',
      tls: 'TLS and certificate',
      bind: 'Service account sign-in',
      base: 'Base DN',
      filter: 'User filter',
      users: 'User search',
      groups: 'Mapped groups',
    },
    result: {
      config: { ok: 'Address {url}, account {account}.' },
      dns: {
        ok: '{host} → {address}',
        dns: 'The name “{host}” is not found in DNS. Check the server name and DNS on the Arklock server.',
      },
      tcp: {
        ok: 'Connected to {host}:{port}.',
        refused:
          'Port {port} on {host} is closed: the directory service does not listen on it or a firewall rejects the connection.',
        timeout: 'No answer from {host}:{port}: check the route and the firewall.',
        unreachable: 'The server {host} is unreachable from the Arklock server network.',
        reset: 'The server closed the connection to {host}:{port}.',
        unavailable: 'No connection to {host}:{port}.',
      },
      tls: {
        ok: 'TLS {protocol}: the certificate “{subject}” (issuer “{issuer}”) is verified.',
        pinned:
          'TLS {protocol}: the server presented the certificate you trust (the fingerprint matches).',
        plaintext: 'No encryption: passwords travel in the clear.',
        unverified: 'Certificate verification is off: the server identity is not confirmed.',
        cert_untrusted:
          'The server certificate is not trusted: upload the root and intermediate authorities that signed it (the “Certificate authority certificate” field).',
        cert_name:
          'The certificate is issued for another name ({names}). Connect by the name in the certificate, not by IP address or another name.',
        cert_expired:
          'The server certificate has expired. It must be renewed on the domain controller.',
        cert_not_yet_valid:
          'The server certificate is not valid yet: check the clocks on the servers.',
        starttls_failed:
          'The server did not perform StartTLS: use ldaps:// (port 636) or enable StartTLS on the server.',
        tls_handshake:
          'No encrypted connection: there is no LDAPS on this port or the protocols do not match.',
        timeout: 'The server did not finish the encrypted handshake.',
      },
      bind: {
        ok: 'Signed in: {account}.',
        anonymous: 'Anonymous sign-in: no service account is set.',
        invalid_credentials:
          "The directory rejected the account or password (Active Directory code 52e). Check the password and the name: DN, user{'@'}domain or DOMAIN\\user.",
        account_not_found: 'The account “{account}” is not found in the directory (code 525).',
        account_locked: 'The account is locked after wrong attempts (code 775).',
        account_disabled: 'The account is disabled in the directory (code 533).',
        account_expired: 'The account has expired (code 701).',
        password_expired: 'The password has expired (code 532): change it in the directory.',
        password_must_change:
          'The password must be changed at next sign-in (code 773): change it in the directory.',
        account_restriction:
          'Sign-in is blocked by account restrictions (logon hours, workstations).',
        password_missing: 'The service account password is not set.',
        strong_auth_required:
          'The directory requires protected sign-in (LDAP signing): use ldaps:// or StartTLS.',
        confidentiality_required: 'The directory requires encryption: use ldaps:// or StartTLS.',
        inappropriate_auth: 'The directory does not accept this sign-in method for the account.',
        invalid_dn: 'The account is not valid: check the DN.',
        unwilling: 'The directory refused to sign in (for example, an empty password).',
        unavailable: 'The directory is busy or unavailable. Try again later.',
        ldap_error: 'The directory refused the sign-in.',
      },
      base: {
        ok: '{baseDn} is readable.',
        no_such_object:
          'The Base DN “{baseDn}” does not exist. Check the value (example: DC=example,DC=com).',
        insufficient_access: 'The service account cannot read {baseDn}.',
        invalid_dn: 'The Base DN is not valid.',
        ldap_error: 'Reading the Base DN failed.',
      },
      filter: {
        ok: 'The filter works.',
        filter_invalid:
          'The directory did not accept the filter: check parentheses and attribute names.',
        ldap_error: 'Searching with the filter failed.',
        insufficient_access: 'No permission to search users.',
      },
      users: {
        ok: 'Users found (for example, {sample}).',
        none: 'The filter finds no users: check the filter and the Base DN.',
      },
      groups: {
        ok: 'All mapped groups ({total}) are found.',
        none_mapped: 'No groups are mapped.',
        missing: 'Groups not found: {missing} of {total}. The list is in the details.',
      },
    },
    reauth: {
      title: 'Confirm lowering protection',
      text: 'An unencrypted or unverified mode is being turned on. Confirm with your vault unlock password (the confirmation lasts 15 minutes).',
      password: 'Vault unlock password',
      ok: 'Confirm and save',
    },
    saved: 'Connection settings saved.',
    steps: {
      connection: '1. Directory connection',
      connectionHint:
        'Domain controller address, certificate (if needed) and a service account to look up employees. Check and save.',
      login: '2. Employee sign-in',
      loginHint:
        'Who may sign in with a domain account. Then check a real employee sign-in: it confirms that sign-in is ready.',
      advanced: '3. Advanced',
      advancedHint:
        'Synchronisation, group mapping, employee details, the search filter and directory browsing. Not needed for sign-in.',
    },
    type: { label: 'Directory', ad: 'Active Directory', ldap: 'Other LDAP directory' },
    special: 'Special cases: StartTLS, no encryption, no certificate check',
    baseDnAuto: 'Detected from the directory during the connection check (can be changed).',
    baseDnDetected: 'Detected from the directory: {baseDn}',
    saveConnection: 'Save connection',
    status: {
      notSaved: 'The connection is not saved yet.',
      connectionOk: 'Connection verified {at}.',
      connectionFail: 'The last connection check failed ({at}).',
      connectionUnknown: 'The connection is saved but not checked.',
      loginOff: 'Employee sign-in is off.',
      loginOn: 'Employee sign-in is on.',
      loginOk: 'Employee sign-in verified {at}.',
      loginUnchecked: 'Employee sign-in has not been checked yet: check it in step 2.',
      loginFail: 'The last sign-in check failed ({at}).',
      extras: 'Advanced: Arklock groups mapped {groups}, synchronisation {sync}.',
      syncOn: 'on',
      syncOff: 'off',
    },
    enable: 'Allow sign-in with domain accounts',
    access: {
      label: 'Who may sign in',
      all: 'Every active directory account (found by the filter; disabled ones cannot sign in)',
      groups: 'Only members of selected directory groups (nested Active Directory groups included)',
      required: 'Choose who may sign in: access is not opened to everyone without your decision.',
      groupsRequired: 'Add at least one group or choose “Every active directory account”.',
      groupDn: 'Group DN, e.g. CN=Staff,OU=Groups,DC=example,DC=com',
      addGroup: 'Add group',
      findGroup: 'Find a group in the directory',
      legacy:
        'This connection worked like this before 1.87.0: everyone found by the filter signs in.',
    },
    provision: 'Create an Arklock account at the employee’s first sign-in',
    provisionHint:
      'At the first sign-in the employee sets the vault unlock password: encryption keys are created in their browser. The domain password only confirms identity and is never stored.',
    loginTest: {
      title: 'Check employee sign-in',
      username: "Employee account (login, DOMAIN\\login or login{'@'}domain)",
      password: 'Employee domain password',
      run: 'Check sign-in',
      note: 'The directory checks the password; it is not stored or logged. No Arklock account is created.',
      needSave: 'Save the connection first.',
      found: 'Found: {name} <{email}>, groups: {groups}.',
      reason: {
        ok: 'Sign-in works: the employee can sign in to Arklock.',
        not_allowed:
          'The password is right, but the account is not in an allowed group: sign-in will be refused.',
        local_exists:
          'Arklock already has a local account with this address: it is not joined automatically.',
        blocked_in_arklock: 'The employee account is blocked in Arklock.',
        not_provisioned:
          'The password is right, but creating accounts at first sign-in is off: the employee cannot sign in the first time.',
        login_disabled: 'The password is right, but employee sign-in is off (the checkbox above).',
        user_not_found:
          'The employee is not found: check the login, Base DN and filter. Disabled accounts are not found.',
        ambiguous_user: 'Several accounts match: refine the login or the filter.',
        account_disabled: 'The account is disabled in the directory.',
        no_email: 'The account has no e-mail address in the directory: Arklock cannot create it.',
        password_missing: 'Enter the employee password.',
      },
    },
    trust: {
      button: 'Trust this certificate',
      confirm:
        'Trust the certificate “{subject}”?\n\nSHA-256 fingerprint:\n{fingerprint}\n\nCompare the fingerprint with the domain controller certificate. The connection will accept only this certificate — even a self-signed one or one issued for another name.',
      hint: 'If this is your domain controller certificate, it can be trusted by fingerprint.',
      pinned: 'Trusted server certificate: fingerprint {fingerprint}',
      remove: 'Stop trusting',
    },
    browse: { activeOnly: 'Active accounts only', more: 'Show more' },
  },
};
