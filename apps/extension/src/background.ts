import { LOCK_ALARM, lock } from './store';

// Автоблокировка: по сигналу таймера ключи и сессия стираются из памяти браузера.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LOCK_ALARM) void lock();
});

// storage.session по умолчанию недоступно контент-скриптам: расширение не раздаёт ключи страницам
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
