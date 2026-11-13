<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import MfaSettings from './MfaSettings.vue';

/**
 * Обязательный второй фактор: окно открывается само, когда администратор требует его, а у сотрудника он ещё не настроен.
 * Внутри — пошаговая инструкция и сама настройка (QR-код, проверка кода, резервные коды), без поиска раздела в меню.
 * Закрыть окно без настройки нельзя: до неё доступ к данным закрыт сервером.
 */
const emit = defineEmits<{ done: [] }>();
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      title: 'Подключите двухфакторную защиту',
      lead: 'Администратор требует второй фактор для всех сотрудников: кроме пароля при входе нужен одноразовый код из приложения на телефоне. Без него пароль сам по себе ничего не открывает. Настройка займёт пару минут.',
      stepsTitle: 'Как подключить (на примере приложения Яндекс.ID)',
      s1: 'Установите на смартфон приложение Яндекс.ID (Яндекс Ключ): оно бесплатно в App Store, Google Play и RuStore. Подойдёт и Google Authenticator или Microsoft Authenticator.',
      s2: 'Нажмите «Подключить» ниже: на экране появится QR-код.',
      s3: 'В приложении добавьте новый аккаунт и отсканируйте QR-код. Если камера не подходит, введите ключ вручную: он написан под кодом.',
      s4: 'В приложении начнут появляться шестизначные коды: они меняются каждые 30 секунд. Введите текущий код в поле ниже и нажмите «Включить».',
      s5: 'Сохраните резервные коды: они нужны, если телефон потерян или сломан. После этого в профиле появится отметка о включённой защите.',
      after:
        'С этого момента при входе нужны пароль и одноразовый код из приложения. Это обязательная мера защиты ваших паролей.',
      more: 'Подробная инструкция: раздел «Помощь» в Arklock (вопрос про двухфакторную защиту) и вики проекта, страница «Как включить двухфакторную аутентификацию».',
      wiki: 'Вики проекта',
      help: 'Открыть «Помощь»',
    },
    en: {
      title: 'Turn on two-factor protection',
      lead: 'The administrator requires a second factor for all employees: besides the password you need a one-time code from an app on your phone at sign-in. Without it the password alone opens nothing. It takes a couple of minutes.',
      stepsTitle: 'How to set it up (with the Yandex ID app as an example)',
      s1: 'Install an authenticator app on your smartphone, for example Yandex ID (Yandex Key): it is free in the App Store, Google Play and RuStore. Google Authenticator or Microsoft Authenticator work too.',
      s2: 'Press “Connect” below: a QR code appears on the screen.',
      s3: 'In the app add a new account and scan the QR code. If the camera does not fit, enter the key by hand: it is written under the code.',
      s4: 'The app starts showing six-digit codes that change every 30 seconds. Enter the current code in the field below and press “Turn on”.',
      s5: 'Save the backup codes: you need them if the phone is lost or broken. After that your profile shows that the protection is on.',
      after:
        'From now on you need the password and a one-time code from the app to sign in. This is a mandatory measure to protect your passwords.',
      more: 'Detailed instruction: the “Help” section in Arklock (the question about two-factor protection) and the project wiki, the page “How to turn on two-factor authentication”.',
      wiki: 'Project wiki',
      help: 'Open “Help”',
    },
  },
});
const dialog = ref<HTMLDialogElement | null>(null);
onMounted(() => dialog.value?.showModal());
const WIKI =
  'https://github.com/calleograph/Arklock/wiki/Как-включить-двухфакторную-аутентификацию';
</script>

<template>
  <dialog
    ref="dialog"
    class="modal-fade m-auto w-[min(44rem,calc(100vw-1.5rem))] max-h-[calc(100dvh-1.5rem)] overflow-visible"
    :aria-label="t('title')"
    data-testid="mfa-setup-dialog"
    @cancel.prevent
  >
    <div class="flex max-h-[calc(100dvh-1.5rem)] flex-col">
      <header class="border-b border-slate-200 px-5 py-3 dark:border-slate-800">
        <h2>{{ t('title') }}</h2>
      </header>
      <div class="space-y-4 overflow-y-auto px-5 py-4 text-sm">
        <p>{{ t('lead') }}</p>
        <section class="space-y-2">
          <h3 class="font-medium">{{ t('stepsTitle') }}</h3>
          <ol class="list-decimal space-y-1 pl-5 text-slate-700 dark:text-slate-200">
            <li>{{ t('s1') }}</li>
            <li>{{ t('s2') }}</li>
            <li>{{ t('s3') }}</li>
            <li>{{ t('s4') }}</li>
            <li>{{ t('s5') }}</li>
          </ol>
          <p class="text-slate-600 dark:text-slate-300">{{ t('after') }}</p>
        </section>
        <MfaSettings class="!max-w-none" @enabled="emit('done')" />
        <p class="text-xs text-slate-500">
          {{ t('more') }}
          <a :href="WIKI" target="_blank" rel="noopener" class="underline">{{ t('wiki') }}</a> ·
          <RouterLink to="/help" class="underline" target="_blank">{{ t('help') }}</RouterLink>
        </p>
      </div>
    </div>
  </dialog>
</template>
