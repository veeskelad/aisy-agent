# ADR-0058: первоначальная настройка и подключения «мозга» через Telegram

**Статус:** принято  
**Дата:** 2026-07-26  
**Теги:** onboarding, telegram, authentication

## Контекст

Существующий installer завершает работу редактированием `.env` в терминале и
`aisy init`. Interactive pairing безопасен и протестирован, но настройка
provider и управляемый BOOTSTRAP flow ещё не собраны в live Telegram product.
Первая модель не может проводить onboarding, пока нет подключения к модели;
поэтому поручить LLM day-zero setup означало бы создать циклическую зависимость.

Желаемый опыт, как у референсного ассистента: указать Telegram bot token,
доказать владение chat и
завершить подключение provider, а затем personal onboarding внутри Telegram.

## Решение

Установка завершается долговечной детерминированной bootstrap state machine,
которой не нужна LLM:

`NO_BRAIN → CHOOSE_BRAIN → INSTALLING? → AWAITING_AUTH → VALIDATING →
BRAIN_READY → IDENTITY → OPERATOR → FIRST_PROJECT → AUTONOMY → COMPLETE`.

Installer запрашивает bot token, проверяет identity бота, выполняет pairing-code
flow из терминала, регистрирует service и запускает Aisy в setup-only Telegram
mode. После pairing оператор подключает:

- Codex/ChatGPT subscription через официальный device/browser authentication;
- Claude Pro/Max через официальный Claude Code authentication flow;
- Anthropic, OpenAI, OpenRouter или compatible API через API keys.

API secret input перехватывается до обычного Gateway: он nonce-bound, никогда
не превращается в model span, не журналируется, атомарно сохраняется в vault,
редактируется в diagnostics, а Telegram message удаляется best-effort. Так как
bot chat не имеет end-to-end encryption, UI обязан явно предупредить об этом и
предложить одноразовый local/SSH/Tailscale secret-entry path.

Каждое подключение проверяется до того, как становится selectable. State machine
продолжается после process restart и остаётся доступной из Settings после
onboarding.

Постоянная Telegram reply keyboard — navigation chrome, а не content разговора.
`/start`, `/menu` и menu-button tap включают navigation mode. Первый free-form
text убирает keyboard до agent turn; последующий текст остаётся conversation
mode без повторных notices, пока оператор явно не откроет меню снова.

## Последствия

- **Положительное:** clean install достигает рабочего agent без ручного
  редактирования config и без модели, настраивающей саму себя.
- **Положительное:** subscription, API, validation, fallback и masked status
  используют единый lifecycle `BrainConnection`.
- **Нейтральное:** terminal pairing остаётся trust root; в Telegram переносится
  только setup после pairing.
- **Отрицательное:** upstream OAuth/device flows требуют integration fixtures и
  регулярных compatibility tests.
- **Отрицательное:** secret entry через Telegram удобнее, но слабее local
  end-to-end input, поэтому поддерживаются оба пути.

## Рассмотренные альтернативы

**Разрешить первой модели провести onboarding.** Отклонено: до первого
подключения модели нет, а dry/model failure оставит установку незавершённой.

**Связать первый chat, написавший боту.** Отклонено: подход подвержен race и
слабее pairing code из терминала по ADR-0049.

**Оставить всю настройку provider в терминале.** Отклонено: это сохраняет
крупнейший day-zero usability gap и не даёт resumable in-product diagnostics.

## Ссылки

- [ADR-0034 — Onboarding & Operations](./2026-06-11-onboarding-operations-layer.md)
- [ADR-0035 — Install & Packaging](./2026-06-11-install-and-packaging.md)
- [ADR-0049 — Interactive Onboarding and Pairing](./2026-06-16-interactive-onboarding-and-telegram-pairing.md)
- [ADR-0056 — npm Package Distribution](./2026-06-24-npm-package-distribution.md)
- [ADR-0057 — Aisy Control Plane](./2026-07-26-aisy-control-plane-supervised-brain-runtimes.md)
