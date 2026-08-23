# Проверка безопасности API Credential Ingress

Дата: 2026-07-27  
Область: Component 16, API setup driver, nonce-bound entry, staged rotation,
durable SQLite metadata, raw TTY CLI, native API validators и Telegram UI

## Проверенные инварианты

- `makeApiKeySetupDriver` получает только exact binding и `ApiCredentialBroker`.
  В его интерфейсе нет метода чтения secret; challenge содержит публичный
  bounded one-use code и code-owned terminal command.
- Durable store сохраняет только SHA-256 публичного entry-code. Claim выполняется
  в `BEGIN IMMEDIATE`, удаляет reusable hash и допускает одного победителя между
  процессами. Replay, expiry и superseded challenge не создают vault effects.
- Secret входит только в `submit` как owned `Uint8Array` и зануляется в `finally`
  на всех путях. Он не входит в record, result, error, event или validator args.
- Vault contract транзакционный: `stage` → `validateStaged(handle)` → `activate`.
  Старый active slot не удаляется до успешной validation. Provider detail
  отбрасывается; наружу выходят только code-owned safe detail/error code.
- Crash после stage продолжает validation. Crash после activate, но до
  `markReady`, восстанавливается по safe `activeTransactionId`. Identical
  entry-code уже не может быть claimed повторно.
- Неудачный rollback не превращает record в terminal state: `committing`
  сохраняет authority для повторного cleanup. Revoke удаляет pending stage и
  active slot до публикации `revoked`.
- SQLite store проверяет exact table/index shape, row invariants, integrity,
  journal mode, `secure_delete`, canonical path и private permissions. Raw
  entry-code и secret bytes в БД отсутствуют.
- Telegram по-прежнему не принимает key в chat. Кнопка «Проверить подключение»
  появляется только при `secureEntryAvailable=true`.
- CLI разбирает только точную команду `brain credential set --code=...` и
  закрывает `--secret`, unknown flags, non-TTY и отсутствующий backend до чтения
  credential. Raw terminal не выводит echo, mask или length и восстанавливает
  режим при success/cancel/fault; недоказуемое восстановление закрывает submit.
- OpenAI, Anthropic и OpenRouter validators получают только staged/active opaque
  locator. Их provider, endpoint и auth protocol неизменяемы и полностью заданы
  кодом. Provider также жёстко связан со своим vault slot. Redirect error,
  bounded timeout и status-only обязательны. Только 200 успешен;
  cross-provider binding/slot, rich response, redirect и остальные статусы
  закрываются до активации.

## Доказательства

- `api-key-setup-driver.spec.ts`: exact binding, safe terminal challenge и
  unsafe broker challenge denial.
- `api-credential-ingress.spec.ts`: hash-only issue, one-use submit, zeroization,
  validation failure, stage/activation restart recovery, rollback faults,
  supersede и revoke.
- `sqlite-api-credential-ingress-store.spec.ts`: real SQLite restart,
  cross-instance claim, transitions, symlink, permissions и schema corruption.
- `bootstrap-view.spec.ts`: no-chat secret disclosure и secure-entry-gated
  validation action.
- `cli.spec.ts` и `credential-terminal.spec.ts`: exact syntax, argv denial,
  fail-closed dependency, zeroization, no echo, cancel, size/control-byte denial
  и terminal restore fault.
- `openai-api-credential-validator.spec.ts`: exact staged/active descriptors для
  OpenAI/Anthropic/OpenRouter, wrong-provider denial, fixed endpoint/protocol,
  redirect/status classification, rich response rejection и exception redaction.
- Полный regression gate: core 1383/1383, Telegram gateway 104/104, app
  273/273; workspace typecheck/build и `git diff --check` зелёные. Python
  sidecars не менялись; последний полный gate: 34 passed/1 platform skip.

## Незавершённые границы

- Production opaque secret backend ещё не выбран и не подключён. Legacy
  plaintext `vault.json` сознательно не используется новым ingress.
- CLI и no-echo adapter реализованы, но production app не инъецирует backend;
  показывать рабочий challenge в live runtime до этого запрещено.
- Provider descriptors/classifier реализованы, но физический proxy, который
  внутри network boundary разрешает opaque handle и добавляет auth material и
  обязательные protocol headers, отсутствует.
- Live coordinator/API drivers и activation отсутствуют.

## Вывод

Foundation закрывает nonce, replay, rotation, crash-state, protected CLI input
и OpenAI request classification без расширения legacy vault. Она не является
разрешением live API auth: activation остаётся закрыта до production backend,
credential-injecting proxy и provider-broker restart E2E.
