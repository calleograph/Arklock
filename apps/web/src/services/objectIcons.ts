/**
 * Значки папок и записей: встроенный каталог (контуры 24×24 в стиле остальных значков), цвет
 * и своё изображение. Выбор хранится внутри зашифрованных данных: сервер не видит, какой значок выбран.
 */
export interface ObjectIcon {
  /** Значок из каталога. */
  name?: string;
  color?: IconColor;
  /** Своё изображение: PNG до 64×64, перерисованное в браузере (активное содержимое не сохраняется). */
  image?: string;
}

export const ICON_COLORS = [
  'default',
  'yellow',
  'orange',
  'red',
  'indigo',
  'blue',
  'green',
] as const;
export type IconColor = (typeof ICON_COLORS)[number];

/** Цвета подобраны так, чтобы читаться и на светлых, и на тёмных темах. */
export const COLOR_CLASS: Record<IconColor, string> = {
  default: 'text-slate-500 dark:text-slate-400',
  yellow: 'text-amber-500',
  orange: 'text-orange-500',
  red: 'text-red-500',
  indigo: 'text-indigo-500',
  blue: 'text-sky-600 dark:text-sky-400',
  green: 'text-emerald-600 dark:text-emerald-400',
};

/** Каталог: имя → контур. Ключевые слова — для поиска на русском и английском. */
export const ICON_CATALOG: Record<string, { path: string; words: string }> = {
  folder: {
    path: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z',
    words: 'папка folder',
  },
  key: {
    path: 'M14.5 9.5a4 4 0 1 1-1.2-2.8M13 10l7 7-2 2-2-2-2 .5L14 15l-1.5-1.5',
    words: 'ключ пароль key password',
  },
  lock: { path: 'M5 11h14v9H5zM8 11V8a4 4 0 0 1 8 0v3', words: 'замок защита lock secure' },
  shield: {
    path: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z',
    words: 'щит безопасность shield',
  },
  server: {
    path: 'M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01M11 7h5M11 17h5',
    words: 'сервер стойка server rack',
  },
  database: {
    path: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    words: 'база данных database sql',
  },
  cloud: {
    path: 'M7 18a4 4 0 0 1-.6-8 6 6 0 0 1 11.5 1.5A3.5 3.5 0 0 1 17.5 18z',
    words: 'облако cloud',
  },
  globe: {
    path: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z',
    words: 'сайт интернет globe web site',
  },
  mail: { path: 'M3 6h18v12H3zM3 7l9 7 9-7', words: 'почта письмо mail email' },
  chat: {
    path: 'M4 5h16v11H9l-5 4zM8 9h8M8 12h5',
    words: 'чат мессенджер chat messenger',
  },
  phone: {
    path: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
    words: 'телефон мобильный phone mobile',
  },
  terminal: { path: 'M3 5h18v14H3zM7 9l3 3-3 3M12 15h5', words: 'терминал консоль ssh terminal' },
  code: { path: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16', words: 'код разработка git code' },
  wifi: {
    path: 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01',
    words: 'wifi сеть network',
  },
  network: {
    path: 'M10 3h4v4h-4zM3 17h4v4H3zM17 17h4v4h-4zM12 7v5M5 17v-2h14v2M12 12v3',
    words: 'сеть маршрутизатор network router',
  },
  bank: {
    path: 'M3 9l9-5 9 5M5 9v8M9.5 9v8M14.5 9v8M19 9v8M3 20h18',
    words: 'банк финансы bank finance',
  },
  card: { path: 'M3 6h18v12H3zM3 10h18M7 15h4', words: 'карта оплата card payment' },
  wallet: {
    path: 'M4 7h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4zM4 7V6a1 1 0 0 1 1-1h11M16 13h.01',
    words: 'кошелёк wallet',
  },
  cart: {
    path: 'M3 4h2l2.5 11h10L20 7H6.3M9 19.5h.01M17 19.5h.01',
    words: 'магазин покупки cart shop',
  },
  building: {
    path: 'M5 21V4h10v17M15 9h4v12M3 21h18M8 8h4M8 12h4M8 16h4',
    words: 'офис компания здание building office',
  },
  briefcase: {
    path: 'M3 8h18v11H3zM9 8V5h6v3M3 13h18',
    words: 'работа портфель briefcase work',
  },
  home: { path: 'M4 11l8-7 8 7v9H4zM10 20v-5h4v5', words: 'дом home' },
  user: {
    path: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c1.2-3.5 4.2-5 8-5s6.8 1.5 8 5',
    words: 'пользователь учётная запись user account',
  },
  users: {
    path: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.8-3 3.3-4.5 6.5-4.5s5.7 1.5 6.5 4.5M16 4.5a3.5 3.5 0 0 1 0 6.8M18.5 15.5c1.1.7 1.8 2 2 4.5',
    words: 'группа команда users team',
  },
  settings: {
    path: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1',
    words: 'настройки admin settings',
  },
  chart: { path: 'M4 20V10M10 20V4M16 20v-7M22 20H2', words: 'отчёты аналитика chart analytics' },
  file: { path: 'M6 3h8l4 4v14H6V3zM14 3v4h4', words: 'файл документ file document' },
  book: {
    path: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4zM5 17a3 3 0 0 1 3-3h11',
    words: 'справочник документация book docs',
  },
  camera: {
    path: 'M4 8h4l2-3h4l2 3h4v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    words: 'камера видеонаблюдение camera cctv',
  },
  video: { path: 'M3 6h13v12H3zM16 10l5-3v10l-5-3', words: 'видео конференции video' },
  printer: {
    path: 'M7 8V3h10v5M5 8h14a1 1 0 0 1 1 1v7h-3M7 16H4V9M7 13h10v8H7z',
    words: 'принтер printer',
  },
  box: {
    path: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
    words: 'склад коробка box package',
  },
  truck: {
    path: 'M2 6h12v10H2zM14 10h4l3 3v3h-7M6 19.5h.01M17 19.5h.01',
    words: 'доставка логистика truck delivery',
  },
  plane: {
    path: 'M10.5 13.5 3 11l1-2 8 1 4.5-5.5a1.8 1.8 0 0 1 2.5 2.5L13.5 12l1 8-2 1-2.5-7.5z',
    words: 'командировки поездки plane travel',
  },
  link: {
    path: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    words: 'ссылка интеграция link api',
  },
  bolt: { path: 'M13 2 4 14h7l-1 8 9-12h-7z', words: 'энергия быстро bolt power' },
  heart: {
    path: 'M12 20s-8-4.6-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.5C20 15.4 12 20 12 20z',
    words: 'избранное здоровье heart',
  },
  star: {
    path: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.2 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z',
    words: 'звезда важное star',
  },
  tag: { path: 'M3 12V4h8l10 10-8 8L3 12zM7.5 8a.5.5 0 1 0 0 .01', words: 'метка tag' },
  flag: { path: 'M5 21V4M5 4h12l-2 4 2 4H5', words: 'флаг отметка flag' },
};

export const iconPath = (name: string | undefined) =>
  name ? (ICON_CATALOG[name]?.path ?? null) : null;

const IMAGE_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;
/** Предел изображения в данных: 64×64 PNG помещается с запасом, а зашифрованное оформление остаётся небольшим. */
export const MAX_IMAGE_CHARS = 16_000;

/** Проверка оформления, пришедшего из расшифрованных данных: в разметку попадает только известное. */
export function cleanIcon(raw: unknown): ObjectIcon | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const icon: ObjectIcon = {};
  if (typeof r.name === 'string' && ICON_CATALOG[r.name]) icon.name = r.name;
  if (typeof r.color === 'string' && (ICON_COLORS as readonly string[]).includes(r.color))
    icon.color = r.color as IconColor;
  if (typeof r.image === 'string' && r.image.length <= MAX_IMAGE_CHARS && IMAGE_RE.test(r.image))
    icon.image = r.image;
  return icon.name || icon.image || icon.color ? icon : undefined;
}

/**
 * Своё изображение: файл рисуется в холст 64×64 и сохраняется как PNG. Скрипты и внешние ссылки SVG
 * при этом не выполняются и не сохраняются — остаются только пиксели.
 */
export async function rasterizeIcon(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|svg\+xml|webp)$/.test(file.type)) throw new Error('unsupported');
  if (file.size > 2 * 1024 * 1024) throw new Error('too_big');
  // data:, а не blob: — политика безопасности страницы разрешает изображения только из data:
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('unsupported'));
    r.readAsDataURL(file);
  });
  {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('unsupported');
    const scale = Math.min(size / (img.naturalWidth || size), size / (img.naturalHeight || size));
    const w = (img.naturalWidth || size) * scale;
    const h = (img.naturalHeight || size) * scale;
    g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    const data = canvas.toDataURL('image/png');
    if (data.length > MAX_IMAGE_CHARS) throw new Error('too_big');
    return data;
  }
}
