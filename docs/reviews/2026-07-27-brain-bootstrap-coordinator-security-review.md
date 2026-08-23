# Проверка безопасности Brain Bootstrap Coordinator

Дата: 2026-07-27  
Область: ADR-0057/0058, Component 16, deterministic setup orchestration,
Telegram callbacks и Codex subscription auth lifecycle

## Проверенные инварианты

- Coordinator разрешает driver только при exact совпадении `connectionId`,
  provider, auth mode и runtime. Missing/mismatched driver не меняет bootstrap
  state.
- Каждая внешняя команда привязана к durable revision. Process-local serial
  barrier превращает concurrent replay в `STALE_REVISION` до второго driver
  call.
- Install/auth/validation/revoke exceptions не сохраняют exception message,
  stdout/stderr или provider response. Durable state получает только bounded
  allowlisted error code.
- Auth challenge не входит в `BrainBootstrapState` и transition events. URL
  обязан быть HTTPS; device code имеет bounded alphabet/length; инструкции не
  содержат control characters или длинных token-like значений.
- Один coordinator не начинает второй auth flow на той же revision. После
  restart in-memory guard исчезает намеренно: durable phase разрешает безопасно
  повторить challenge либо завершить уже выполненный внешний login.
- Crash после `auth-completed` оставляет `VALIDATING_AUTH`; fresh coordinator
  вызывает только validation и не пропускает state напрямую в `BRAIN_READY`.
- Health check не мутирует state. Revoke сначала требует успешного driver
  результата и лишь затем выполняет code-owned `reset-brain`; failure сохраняет
  connection metadata и revision.
- Telegram callback содержит revision и сверяется с текущим persisted state до
  dispatch/coordinator. Stale/replayed callback перерисовывает durable card и не
  вызывает driver.
- Setup transport не преобразует свободный текст в model span и не принимает
  API key в обычном Telegram-чате. Secure-input challenge указывает только на
  отдельный локальный защищённый канал.
- Production Node store принимает только exact schema и согласованные
  phase/status. Unknown fields, non-canonical timestamp, неограниченный error
  code, symlink и state file с правами шире `0600` закрываются до публикации.
- Writer получает owner-bound exclusive lock и под lock повторно проверяет
  предыдущую revision. Lock не перехватывается по времени и удаляется только
  при byte-matching owner token.
- Publication boundary: exclusive private temp → file fsync → atomic rename →
  directory fsync. Fault до rename оставляет предыдущую revision; ambiguous
  failure после rename допускает только canonical byte-equivalent retry той же
  revision.

## Codex-specific граница

- Проверены только официальные команды: version detection, device-code login,
  login status и logout. Challenge parser возвращает только HTTPS URL и user
  code; любой другой CLI output остаётся локальным и bounded.
- Runtime installer является injected port. Без принятого installer Aisy не
  запускает package manager или shell-команду автоматически.
- Официальный Codex app-server остаётся experimental. Auth readiness не
  приравнивается к готовности structured run-driver: tools, approvals,
  cancellation, usage, sandbox и protocol compatibility требуют отдельного
  production bridge.

## Доказательства

- `brain-bootstrap.spec.ts`: переходы, failure/retry, persistence-before-publish,
  restart и redaction-safe events.
- `brain-bootstrap-coordinator.spec.ts`: install, exact revision, challenge
  one-use, unsafe challenge, validation failure, restart resume, concurrent
  replay, driver mismatch, health и revoke.
- `codex-auth.spec.ts`: safe parser, official argv, async device process,
  status validation и logout без raw-output exposure.
- `bootstrap-view.spec.ts` и `setup-bot.spec.ts`: revision callbacks, challenge
  view, foreign chat, stale replay и no-model setup transport.
- `brain-bootstrap-store.spec.ts`: exact schema/private-file policy, lock/CAS,
  temp/fsync/rename fault injection и post-rename idempotence.
- `brain-bootstrap-store.integration.spec.ts`: реальный Node filesystem,
  restart resume, `0600`, symlink isolation и pre-existing lock.
- Полный gate после композиции: core 1337/1337, Telegram gateway 103/103,
  app 273/273, Python sidecars 34 passed/1 platform skip; workspace typecheck и
  build зелёные, `git diff --check` чистый, tracked paths локального приватного
  эталона отсутствуют; его имя и путь не публикуются.

## Остаточные риски и незавершённые работы

- Live setup в `aisy.ts` пока не получает coordinator/drivers; это сохраняет
  прежний безопасный setup-only режим до явной activation.
- API key bytes ещё не имеют nonce-bound vault ingress и потому не принимаются.
- Claude smoke parser готов, но automatic execution закрыт до полной изоляции
  user/project settings, hooks, MCP и cwd.
- Codex/Claude `BrainDriver.run` с typed event bridge, sandbox, approval,
  cancellation и usage accounting ещё не реализован.
- Автоматический takeover abandoned lock намеренно запрещён. Нужна отдельная
  doctor-команда, которая покажет владельца/состояние и потребует явного
  operator recovery; до этого stale lock остаётся fail-closed.

## Вывод

Coordinator безопасно автоматизирует phase/revision orchestration, а Node store
закрывает crash-consistency и multi-writer publication boundary. Это не
расширяет auth readiness до неподтверждённой runtime capability. Live activation
этим review не разрешена.
