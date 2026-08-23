# ADR-0098: Host-encrypted credential и root-owned proxy для облачной транскрипции

**Статус:** Принято
**Дата:** 2026-08-13
**Теги:** voice, secrets, systemd

## Контекст

ADR-0085 требует явного durable-согласия до отправки голоса внешнему
провайдеру. Прямой Deepgram adapter, registry, media inbox, voice ingress и
spend ledger уже импортированы в production composition. Этот переходный путь
разрешает secret через legacy `vault.json`; на целевом headless Linux-хосте key
не настроен, поэтому реальный Deepgram egress не готов. ADR-0087 запрещает
считать legacy resolver production backend для нового credential flow:
отсутствие защищённого backend не должно понижать защиту до plaintext-файла.

Оператор выбрал UX с одноразовым кодом из Telegram и скрытым вводом ключа в
локальном TTY. Целевой хост имеет systemd 255 и системный Python, но не имеет
TPM или внешнего Vault. Запуск root-service из пользовательского checkout или
NVM недопустим: изменяемый пользователем код превратился бы в повышение
привилегий.

## Решение

На headless Linux ключи облачной транскрипции обслуживает отдельная code-owned
цепочка `TTY ingress → root-owned broker/backend → credential-injecting proxy`.

1. **Host-encrypted backend.** Ключ Deepgram сохраняется только как
   `systemd-creds --with-key=host` credential в root-owned хранилище. Host key
   принадлежит системному trust root и не хранится в Aisy state или рядом с
   пользовательским ciphertext. Plaintext fallback в `.env`, JSON, SQLite,
   argv или environment запрещён.
2. **Разделённые privilege domains.** Enrollment/control broker запускается
   системным Python из root-owned immutable release-каталога. Одноразовый
   transcription worker работает отдельным непривилегированным uid
   `aisy-voice-proxy`; systemd передаёт ему decrypted credential только для
   одной activation. Код, интерпретатор, unit и зависимости обоих процессов
   root-owned, но сетевой data-plane никогда не работает с uid 0.
3. **Два узких Unix-socket protocol.** Control socket выдаёт и атомарно
   поглощает одноразовый enrollment code. Приватный activation channel выдаёт
   root permit только текущему supervised Aisy main process, предъявившему
   genuine одноразовую media-inbox capability. Data socket принимает этот
   permit только через root-broker relay и единственный версионированный
   Deepgram descriptor. Приватный channel и sealed audio memfd передаются через
   `SCM_RIGHTS` с `CLOEXEC`; каждое сообщение несёт kernel credentials. Kernel peer,
   pid/start-time/cgroup, release, installation и exact media binding
   проверяются до resolve. Произвольные URL, method, headers, credential slot и
   response policy отсутствуют в запросе клиента.
4. **Ключ не проходит через Telegram.** `/voice connect deepgram-cloud`
   получает bounded one-use code, связанный с exact operator/profile/provider,
   со сроком десять минут. Команда
   `aisy voice credential set --code=<code>` требует интерактивный TTY, читает
   без echo/mask/length, отправляет owned bytes только в локальный control
   socket и зануляет buffer на всех путях. Code публичен; secret запрещён в
   argv, environment, обычном stdin и логах. Узкий внутренний anonymous pipe в
   exact fd 0 процесса `systemd-creds` является backend boundary, а не CLI stdin;
   его fd allowlist, lifetime и cleanup задаются спецификацией компонента 25.
5. **Validate before activate.** Broker атомарно claim'ит code и проверяет key
   фиксированным `GET https://api.deepgram.com/v1/projects` с
   `Authorization: Token …`, без redirect и с bounded status-only response.
   Только HTTP 200 разрешает host-encrypted stage, fsync и atomic activation.
   Старый active ciphertext сохраняется до успеха; failed rotation его не
   заменяет.
6. **Proxy — единственная точка раскрытия.** Socket-activated unprivileged
   worker получает plaintext credential от systemd только на время одного
   запроса, atomically claim'ит root-issued dispatch permit, проверяет exact
   media identity и фиксированный descriptor, отправляет bounded audio на exact
   Deepgram `/v1/listen`, проецирует ответ в typed transcript и зануляет owned
   buffers. Aisy не получает key, auth header, upstream headers или raw error
   body. Подделка, foreign/stale capability, другой same-uid process и replay
   завершаются до credential resolve, spend reservation и HTTPS.
7. **Consent остаётся отдельным.** Наличие и проверка credential не выбирают
   внешний provider. Только `/voice deepgram-cloud` сохраняет disclosure
   revision по ADR-0085; revoke credential немедленно делает voice unavailable,
   даже если старый consent-файл существует.
8. **Fail closed и rollback.** Отсутствующий host key, protocol/release drift,
   unsafe socket/unit/artifact, corrupt metadata, ambiguous activation или
   недоступный proxy дают стабильный отказ без legacy resolver. Rollback
   возвращает предыдущий root-owned proxy release; ciphertext и metadata не
   откатываются без отдельного compatibility verdict.
9. **Линеаризуемые lifecycle и audit.** Dispatch permit имеет durable
   `prepared → claimed → attempted → terminal` lifecycle, exact TTL и одну
   credential epoch. Revoke сначала закрывает epoch и отменяет неclaimed
   permits, затем дожидается или неоднозначно завершает claimed work и только
   после остановки workers удаляет ciphertext. Каждая durable transition и
   redacted effective-once outbox row записываются одной SQLite transaction;
   restart повторяет delivery с тем же event id, а sink дедуплицирует его до
   acknowledgement.
10. **Installer имеет отдельный trust root.** Privileged install выполняет уже
    root-owned helper либо bootstrap deployment с операторским expected digest,
    полученным вне bundle. Manifest внутри bundle не является своим же
    доказательством. Helper открывает source через descriptor-relative
    no-symlink API, копирует и хеширует bytes из того же fd, публикует только
    root-owned staged tree и никогда не импортирует или исполняет source из
    пользовательского checkout.

## Последствия

- **Положительное:** ключ не находится в пользовательском Aisy state и не
  передаётся модели, provider adapter или журналу.
- **Положительное:** one-use Telegram code связывает удобный UX с локальным
  no-echo secret entry, не превращая Telegram в credential channel.
- **Положительное:** root broker централизует lifecycle, а отдельный
  непривилегированный worker ограничивает blast radius сетевого data-plane.
- **Нейтральное:** системная установка получает root-owned artifacts, system
  socket/service units, отдельный service uid и host credential key.
- **Отрицательное:** установка и обновление proxy требуют root deployment step;
  обычного user-systemd unit недостаточно.
- **Отрицательное:** host-key backend защищает от утечки user-owned state и
  резервных копий, но не от полного root/host compromise. Для более сильной
  границы требуется TPM или внешний Vault.
- **Отрицательное:** перенос на другой хост требует явной повторной enrollment,
  а не копирования ciphertext.

## Рассмотренные альтернативы

**Legacy `vault.json` или `.env`.** Отклонено ADR-0087: availability backend не
может автоматически понижать защиту до plaintext.

**Ключ в Telegram.** Отклонено: bot chat не является end-to-end secret input,
а удаление сообщения не отменяет доставку Telegram.

**Root-service из checkout/NVM пользователя Aisy.** Отклонено как локальное
повышение привилегий через user-writable executable или import path.

**Внешний Vault.** Совместим с ADR-0087 и остаётся допустимым backend, но для
одного voice credential на текущем хосте добавляет отдельный HA/auth lifecycle.

**Локальный Whisper как единственный путь.** Остаётся безопасной альтернативой,
но не закрывает выбранную оператором облачную транскрипцию и её качество.

## Ссылки

- [ADR-0085 — transcription providers](./2026-07-29-transcription-providers.md)
- [ADR-0087 — opaque secret broker/backend/proxy](./2026-07-29-opaque-secret-broker-backend-proxy.md)
- [ADR-0058 — Telegram-first bootstrap](./2026-07-26-telegram-first-bootstrap-brain-connections.md)
- [systemd credentials](https://github.com/systemd/systemd/blob/main/docs/CREDENTIALS.md)
- [Deepgram authentication](https://developers.deepgram.com/reference/authentication)
- [Deepgram List Projects](https://developers.deepgram.com/reference/manage/projects/list)
