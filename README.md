# WorkLog AI

WorkLog AI — offline-first Android-приложение для ежедневного учёта работы программиста и подготовки данных для СППР. Интерфейс написан на HTML, CSS и JavaScript, Android-сборка выполняется через Capacitor 7.

Отдельный сайт больше не развивается. Корневые веб-файлы остаются исходниками интерфейса Android-приложения и локальной средой проверки перед Capacitor-сборкой.

## Данные и Android

- IndexedDB schema version: `2`;
- Android application id: `ru.worklogai.app`;
- уведомления: `@capacitor/local-notifications`, канал `worklog-reminders-v2`;
- нативная навигация назад: `@capacitor/app`;
- камера: `@capacitor/camera`;
- JDK: `D:\ProjectApp\jdk-21`;
- Android SDK: `D:\ProjectApp\android-sdk`.

## Проверка

```powershell
cd D:\ProjectApp\sites\worklog-ai
npm test
npx serve .
```

Локальная страница открывается по `http://localhost:3000/`. Она нужна для проверки общих HTML/CSS/JS-исходников, а не как отдельный поддерживаемый сайт.

## Сборка APK

```powershell
cd D:\ProjectApp\sites\worklog-ai
npm install
npm run android:apk
```

Готовый файл:

```text
android\app\build\outputs\apk\debug\WorkLog-AI-0.6.15.apk
```

Команда `android:apk` подготавливает `www/`, выполняет `npx cap sync android` и запускает Gradle. Глобальные `JAVA_HOME`, `ANDROID_HOME` и `ANDROID_SDK_ROOT` не обязательны.

## Структура

- `index.html` — экраны Android-интерфейса;
- `styles/app.css` — mobile-first стили и safe areas;
- `src/app.js` — маршруты, UI-состояние и пользовательские сценарии;
- `src/domain/` — проверяемая бизнес-логика рабочего дня и истории задачи;
- `src/data/indexeddb/database.js` — схема IndexedDB;
- `src/data/repositories.js` — задачи, записи, дни, вложения, настройки и резервные копии;
- `src/ai/` — клиент, промпты, контракты и контроль качества ответа;
- `src/platform/capacitor.js` — доступ к нативным плагинам;
- `tests/` — модульные тесты;
- `scripts/prepare-web.mjs` — подготовка ресурсов Capacitor и cache-buster версии;
- `AGENTS.md` — обязательные продуктовые правила;
- `docs/HANDOFF.md` — подробное актуальное состояние;
- `docs/NEW_CHAT_PROMPT.md` — готовый промпт для продолжения в новом чате.
