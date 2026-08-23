# ADR-0087: Непрозрачный broker секретов, production backend и credential-injecting proxy без plaintext fallback

**Статус:** Принято
**Дата:** 2026-07-29
**Теги:** secrets, providers, security

## Контекст

ADR-0058 разрешает подключать native API providers через безопасный setup flow.
Уже реализованный foundation принимает ключ из локального TTY как owned buffer,
сохраняет только непрозрачный handle, валидирует provider через закреплённый
request descriptor и восстанавливает rotation после сбоя. Но production backend,
broker и proxy, который добавляет credential непосредственно перед сетевым I/O,
ещё не выбраны и не подключены.

Передача ключа обратно driver, модели или обычному HTTP client разрушила бы
opaque boundary. Молчаливый fallback в `.env`, process environment, SQLite или
`vault.json` сделал бы безопасный режим зависимым от доступности платформенного
хранилища и превратил бы отказ защиты в plaintext deployment.

## Решение

Native API credentials обслуживает одна code-owned цепочка
`secure ingress → OpaqueSecretBroker → OpaqueSecretBackend →
CredentialInjectingProxy`. Ни один provider driver, validator, model-facing tool
или observability sink не получает secret bytes.

1. **Непрозрачный handle.** Broker возвращает только версионированный handle,
   связанный с `operatorId`, `profileId`, `connectionId`, provider, provider-owned
   slot, credential revision и состоянием `staged | active | revoking | revoked`.
   Handle не является bearer secret и бесполезен вне broker/proxy.
2. **Production backends.** Разрешены только явно настроенные и успешно
   аттестованные adapters: macOS Keychain; системное защищённое хранилище Linux;
   host-bound encrypted backend для headless Linux, у которого unwrap key
   приходит из отдельного OS/TPM trust root; либо внешний Vault. Локальный файл
   может содержать только ciphertext и metadata, а ключ расшифрования не может
   храниться рядом с ним.
3. **Никакого plaintext fallback.** Недоступный, заблокированный или
   неподдерживаемый backend делает API connection недоступным. Запрещены fallback
   в argv, environment, `.env`, обычный JSON, SQLite plaintext и legacy
   `vault.json`. Переключение backend — явная миграция с verification и rollback,
   а не автоматический поиск «любого работающего» источника.
4. **Proxy — единственное место раскрытия.** Только proxy может на короткое время
   разрешить active handle, добавить provider-specific auth header и немедленно
   занулить owned buffer. Caller передаёт неизменяемый code-owned descriptor с
   точными provider, origin, method, path, auth protocol, timeout, redirect policy,
   request/response bounds и response policy. Config и модель не задают URL,
   заголовок авторизации или slot.
5. **Exact binding до сети.** Proxy повторно проверяет actor/profile,
   connection/provider/slot/revision, active state и descriptor id до DNS/TLS/I/O.
   Validation использует `status-only`; live model/embedding adapters получают
   только свой bounded typed response. Rich error/body/header никогда не
   превращается в state, audit или model context.
6. **Rotation, revoke и restart.** Rotation следует
   `staged → validated → active`: прежняя active revision остаётся доступной до
   успешной проверки новой. Revoke сначала долговечно запрещает новые resolve,
   затем удаляет staged/active material и только после подтверждения backend
   публикует `revoked`. Crash сохраняет повторяемую phase; unknown schema,
   неоднозначная revision или неудачный cleanup закрываются без fallback.
7. **Audit без секретов.** Effective-once outbox пишет только event id,
   actor/profile, connection/provider/slot, backend id, revision, transition,
   стабильный code и timestamp. Handle, secret, длина, request bytes и upstream
   detail в события не входят.

Это решение не активирует live providers. До реализации и проверки production
backend, broker, proxy, doctor и restart/revoke E2E `aisy run` не выдаёт native
API connection как готовое и не использует legacy plaintext storage вместо неё.

## Последствия

- **Положительное:** secret остаётся вне driver/model/log surfaces, а backend
  outage не ослабляет защиту.
- **Положительное:** один proxy централизует provider binding, egress policy,
  redaction и rotation для model и embedding adapters.
- **Нейтральное:** platform adapters различаются, но обязаны проходить один
  capability и lifecycle contract.
- **Отрицательное:** headless host без доступного OS/TPM trust root или внешнего
  Vault не сможет использовать native API credentials.
- **Отрицательное:** migration между backends и crash-safe revoke требуют
  отдельных integration и fault-injection матриц.

## Рассмотренные альтернативы

**Хранить ключи в `.env` или `vault.json` как резервный путь.** Отклонено:
fallback превращает отсутствие secure backend в автоматическое понижение защиты.

**Передавать secret driver после чтения из backend.** Отклонено: это расширяет
число компонентов, способных случайно записать ключ в error, trace или context.

**Разрешить caller задавать произвольный URL proxy.** Отклонено: opaque handle
стал бы универсальным SSRF/credential-forwarding primitive.

## Ссылки

- [ADR-0058 — первоначальная настройка и подключения «мозга»](./2026-07-26-telegram-first-bootstrap-brain-connections.md)
- [ADR-0057 — Aisy как единая control plane](./2026-07-26-aisy-control-plane-supervised-brain-runtimes.md)
- [ADR-0010 — разрыв lethal trifecta](./2026-06-11-break-lethal-trifecta.md)
- [ADR-0088 — долговечное согласие на semantic egress](./2026-07-29-durable-semantic-egress-consent.md)
