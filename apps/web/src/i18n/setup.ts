/** Тексты первоначальной настройки: общие для страницы настройки и полос «следующий шаг». */
export const setupMessages = {
  ru: {
    banner: 'Первоначальная настройка: готово {n} из {m}.',
    next: 'Следующий шаг: {step}',
    continue: 'Продолжить',
    all: 'Все шаги',
    start:
      'Arklock установлен. Настройте его для работы компании: адрес, почта, вход сотрудников, группы с сейфами и резервные копии.',
    startBtn: 'Начать настройку',
    hide: 'Скрыть',
    why: 'Почему сотрудники не входят',
    progress: 'Готово {n} из {m}',
    allDone: 'Всё обязательное настроено. Arklock готов к работе.',
    now: 'Сейчас',
    required: 'обязательно',
    recommended: 'рекомендуется',
    optional: 'по желанию',
    setUp: 'Настроить',
    open: 'Открыть',
    change: 'Изменить',
    group: {
      server: 'Сервер',
      signin: 'Как входят сотрудники',
      structure: 'Группы, сейфы и сотрудники',
      protection: 'Защита и сохранность',
    },
    step: {
      url: {
        t: 'Адрес Arklock с HTTPS',
        d: 'Адрес, по которому сотрудники открывают Arklock. Без HTTPS браузер не даёт шифровать пароли.',
      },
      mail: {
        t: 'Почта',
        d: 'Нужна, чтобы отправлять приглашения, коды и уведомления. Без неё коды приглашений передаются вручную.',
      },
      signIn: {
        t: 'Способ входа сотрудников',
        d: 'Через Active Directory сотрудники входят доменным логином, учётные записи создаются сами. По приглашениям вы заводите каждого сотрудника и передаёте ему код.',
      },
      connect: {
        t: 'Подключить Active Directory',
        d: 'Адрес контроллера домена и служебная учётная запись. Остальное Arklock определит сам.',
      },
      login: {
        t: 'Проверить вход сотрудника',
        d: 'Введите логин и пароль любого сотрудника: будет видно, сможет ли он войти и почему нет.',
      },
      access: {
        t: 'Выбрать, кому разрешён вход',
        d: 'Все сотрудники домена или только участники выбранных групп.',
      },
      keys: {
        t: 'Режим ключей шифрования',
        d: 'Строгий: у сотрудника свой пароль разблокировки. Простой вход: доменный логин и второй фактор, пароль разблокировки не нужен.',
      },
      groups: {
        t: 'Создать группы и открыть им сейфы',
        d: 'Группа — сотрудники отдела, назовите её по отделу. Создайте сейф и в его настройках откройте его группе: доступ получат все участники группы.',
      },
      domainGroups: {
        t: 'Связать группы домена',
        d: 'Состав группы домена сам попадает в группу Arklock, а с ней и доступ к сейфам.',
      },
      peopleDirectory: {
        t: 'Сотрудники входят',
        d: 'Сообщите сотрудникам адрес Arklock: достаточно доменного логина и пароля.',
      },
      peopleLocal: {
        t: 'Пригласить сотрудников',
        d: 'Заведите сотрудников по одному или списком и передайте им коды приглашения.',
      },
      mfa: {
        t: 'Второй фактор для администраторов',
        d: 'Код из приложения на телефоне при входе. Защищает панель администратора, если пароль украдут.',
      },
      backup: {
        t: 'Резервные копии',
        d: 'Первая копия и расписание. Ключ шифрования копий храните отдельно от самих копий.',
      },
      recovery: {
        t: 'Корпоративное восстановление',
        d: 'Если все, у кого есть ключ сейфа, недоступны, доступ вернут по заранее подготовленному офлайн-пакету.',
      },
    },
    part: {
      groupCreated: 'Группа создана',
      groupVaults: 'Группе открыт сейф',
      backupFirst: 'Первая копия',
      backupSchedule: 'Расписание',
      backupOffsite: 'Копии на S3 или SMB (по желанию)',
      recRecipient: 'Назначен получатель пакета',
      recVaults: 'Сейфы подключены: {n} из {m}',
    },
    keyMode: { strict: 'Сейчас: строгий', managed: 'Сейчас: простой вход' },
    people: 'Ждут первого входа: {waiting} · вошли: {signedIn}',
    chooseDirectory: 'Active Directory',
    chooseLocal: 'Приглашения',
    chosen: { directory: 'Выбрано: Active Directory', local: 'Выбрано: по приглашениям' },
  },
  en: {
    banner: 'First-time setup: {n} of {m} done.',
    next: 'Next step: {step}',
    continue: 'Continue',
    all: 'All steps',
    start:
      'Arklock is installed. Set it up for your company: address, mail, how employees sign in, groups with vaults and backups.',
    startBtn: 'Start setup',
    hide: 'Hide',
    why: 'Why employees cannot sign in',
    progress: 'Done {n} of {m}',
    allDone: 'Everything required is set up. Arklock is ready for work.',
    now: 'Now',
    required: 'required',
    recommended: 'recommended',
    optional: 'optional',
    setUp: 'Set up',
    open: 'Open',
    change: 'Change',
    group: {
      server: 'Server',
      signin: 'How employees sign in',
      structure: 'Groups, vaults and employees',
      protection: 'Protection and safety',
    },
    step: {
      url: {
        t: 'Arklock address with HTTPS',
        d: 'The address employees open Arklock at. Without HTTPS the browser does not allow encrypting passwords.',
      },
      mail: {
        t: 'Mail',
        d: 'Needed to send invitations, codes and notifications. Without it invitation codes are passed on by hand.',
      },
      signIn: {
        t: 'How employees sign in',
        d: 'With Active Directory employees sign in with their domain login and accounts are created by themselves. With invitations you add each employee and give them a code.',
      },
      connect: {
        t: 'Connect Active Directory',
        d: 'The domain controller address and a service account. Arklock works out the rest itself.',
      },
      login: {
        t: 'Check an employee sign-in',
        d: 'Enter the login and password of any employee: you will see whether they can sign in and why not.',
      },
      access: {
        t: 'Choose who may sign in',
        d: 'Everyone in the domain or only members of selected groups.',
      },
      keys: {
        t: 'Encryption key mode',
        d: 'Strict: each employee has an unlock password. Simple sign-in: domain login and a second factor, no unlock password.',
      },
      groups: {
        t: 'Create groups and open vaults to them',
        d: 'A group is the employees of a team; name it after the team. Create a vault and open it to the group in the vault settings: every member of the group gets access.',
      },
      domainGroups: {
        t: 'Link domain groups',
        d: 'Members of a domain group join an Arklock group by themselves, and with it get vault access.',
      },
      peopleDirectory: {
        t: 'Employees sign in',
        d: 'Tell employees the Arklock address: a domain login and password are enough.',
      },
      peopleLocal: {
        t: 'Invite employees',
        d: 'Add employees one by one or as a list and give them their invitation codes.',
      },
      mfa: {
        t: 'Second factor for administrators',
        d: 'A code from a phone app at sign-in. Protects the administration panel if a password is stolen.',
      },
      backup: {
        t: 'Backups',
        d: 'A first backup and a schedule. Keep the backup encryption key apart from the backups.',
      },
      recovery: {
        t: 'Corporate recovery',
        d: 'If everyone holding a vault key is unavailable, access is restored from a pre-made offline package.',
      },
    },
    part: {
      groupCreated: 'A group is created',
      groupVaults: 'A vault is open to the group',
      backupFirst: 'First backup',
      backupSchedule: 'Schedule',
      backupOffsite: 'Copies to S3 or SMB (optional)',
      recRecipient: 'Package recipient set',
      recVaults: 'Vaults connected: {n} of {m}',
    },
    keyMode: { strict: 'Now: strict', managed: 'Now: simple sign-in' },
    people: 'Waiting for first sign-in: {waiting} · signed in: {signedIn}',
    chooseDirectory: 'Active Directory',
    chooseLocal: 'Invitations',
    chosen: { directory: 'Chosen: Active Directory', local: 'Chosen: invitations' },
  },
};
