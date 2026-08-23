# ADR-0099: Systemd-encrypted credentials и отдельный provider broker для native API

**Статус:** Принято
**Дата:** 2026-08-14
**Теги:** providers, credentials, systemd

## Контекст

ADR-0087 определил непрозрачный credential backend и credential-injecting proxy,
но оставил выбор production backend открытым. После удаления Telegram key intake и
legacy runtime authority native API-провайдеры обязаны fail closed, пока нет
реального backend и data-plane, который выполняет model request, не возвращая ключ
процессу Aisy.

Целевой headless Linux-хост использует systemd 255, не имеет внешнего Vault и не
должен хранить provider keys в открытом виде, SQLite или пользовательском checkout.
Уже существующий voice broker решает похожую задачу, но имеет иную authority:
media capability, consent, Deepgram descriptor и transcript projection. Совместный
socket или protocol увеличил бы blast radius и смешал независимые lifecycle.

## Решение

Native API-провайдеры получают отдельную code-owned цепочку
`TTY ingress → root-owned provider broker/backend → непривилегированный streaming worker`.

1. **Отдельная authority.** `aisy-provider-broker` не использует socket, protocol,
   permits, uid worker или metadata voice broker. Общими остаются только проверенные
   инженерные паттерны: root-owned release, kernel peer identity, systemd encrypted
   credentials и manifest-verified install.
2. **Host-encrypted backend.** Активный ключ хранится как
   `systemd-creds --with-key=host` ciphertext в root-owned A/B slots. Открытый ключ
   запрещён в аргументах процесса, runtime-параметрах, обычном stdin, временном файле,
   Aisy state и логах. Отсутствующий host key или неподдерживаемый systemd закрывает
   provider route.
3. **Credential вводит только оператор.** Telegram выдаёт bounded one-use code, а
   `aisy provider credential set --code=<code>` читает ключ из controlling TTY без
   echo. Code не является credential; ключ никогда не проходит через Telegram.
4. **Validate before activate.** Broker atomically claim'ит code, проверяет ключ
   фиксированным provider descriptor и только после успеха публикует новую revision.
   Failed или неоднозначная rotation не заменяет доказанно активный slot.
5. **Не общий HTTP proxy.** Клиент выбирает только code-owned descriptor id и передаёт
   bounded provider request. Origin, TLS hostname, method family, allowed path,
   credential slot, auth scheme, redirect policy и лимиты принадлежат descriptor.
   Произвольные URL, proxy headers и caller-supplied authorization запрещены.
6. **Полный streaming data-plane.** Одноразовый непривилегированный worker получает
   decrypted credential через `LoadCredentialEncrypted=`, добавляет vendor auth header
   и проксирует response stream с backpressure, cancel и deadline. Aisy получает
   status, allowlisted response headers и body stream, но не credential, upstream auth
   headers или raw диагностические данные.
7. **Точная привязка вызова.** Root broker до resolve проверяет `SO_PEERCRED`, exact
   systemd `MainPID`, start time, cgroup, installation и release. Dispatch permit
   одноразовый, связан с provider, descriptor, credential revision и request digest;
   replay, foreign process и stale release завершаются до decrypt и HTTPS.
8. **Статические provider hosts.** Первый LIVE-срез покрывает только code-owned hosts
   OpenAI, Anthropic, OpenRouter, DeepSeek, Qwen, GLM и Gemini OpenAI-compatible.
   Произвольный `openai-compatible` base URL остаётся fail closed до отдельного решения
   об exact-domain enrollment и SSRF/DNS rebinding policy.
9. **Линеаризуемый lifecycle.** Rotation использует A/B publish с fsync/rename/fsync;
   revoke сначала закрывает epoch, отменяет неclaimed permits и дожидается или
   неоднозначно завершает claimed requests, затем удаляет ciphertext. Restart
   восстанавливает только доказанные terminal/committing состояния и не повторяет
   неоднозначно отправленный model request автоматически.
10. **Установка и rollback.** Broker, worker, native bridge, units и interpreter chain
    запускаются только из root-owned manifest-verified release. Rollback переключает
    release symlink после compatibility verdict; credential metadata и ciphertext не
    откатываются автоматически. `doctor` выполняет только read-only проверки и никогда
    не расшифровывает credential.

## Последствия

- Native API route может стать LIVE без передачи ключа процессу Aisy или модели.
- Компрометация user-owned runtime не даёт прямого чтения ciphertext или открытого
  ключа, но может использовать только уже разрешённые provider descriptors в пределах
  broker quotas; full root/host compromise остаётся вне этой границы.
- Каждый поддерживаемый provider требует статического descriptor, тестов protocol и
  release migration; произвольный endpoint нельзя включить одной строкой config.
- systemd-less платформы и Linux старее подтверждённой версии остаются fail closed;
  позднее они могут получить отдельный backend по ADR-0087.
- Provider broker добавляет системный deploy step, отдельный service uid, sockets,
  metadata DB и operational процедуры rotation/revoke/rollback.

## Рассмотренные альтернативы

**Разделить voice broker только логически.** Отклонено: общий root process и protocol
всё равно объединяют media и model credential authority.

**Передавать ключ напрямую в provider adapter.** Отклонено ADR-0087: это открытый
fallback и расширение круга читателей credential.

**Использовать существующий status-only opaque proxy.** Отклонено как недостаточное:
он валидирует credential, но не возвращает поток model response и не может заменить
production provider adapter.

**Vault Agent.** Совместим с ADR-0087, но на текущем single-host deployment добавляет
отдельный auth/availability lifecycle. Остаётся будущим backend для multi-host режима.

**Один generic reverse proxy с caller-supplied URL.** Отклонено из-за SSRF,
credential confusion и невозможности доказать exact-domain authority.

## Ссылки

- [ADR-0087 — opaque credential broker/backend/proxy](./2026-07-29-opaque-secret-broker-backend-proxy.md)
- [ADR-0098 — host-encrypted voice credential proxy](./2026-08-13-systemd-encrypted-voice-credential-proxy.md)
- [ADR-0096 — pinned service API egress](./2026-08-12-service-apis-through-pinned-egress.md)
- [systemd credentials](https://github.com/systemd/systemd/blob/main/docs/CREDENTIALS.md)
