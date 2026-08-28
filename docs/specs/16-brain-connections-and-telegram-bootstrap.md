# Компонент 16: подключения «мозга» и первоначальная настройка через Telegram

**Статус:** принято
**Компонент:** 16
**Связанные ADR:** ADR-0034, ADR-0049, ADR-0057, ADR-0058, ADR-0087, ADR-0088
**Зависит от:** 02 Gateway, 05 Safety, 09 Provider Routing, 13 Onboarding

> Детерминированная первоначальная настройка, которая подключает и проверяет
> первый «мозг» до того, как разрешается какой-либо onboarding под управлением LLM.

## 1. Назначение

Компонент переводит установленного и безопасно связанного с Telegram бота из
состояния «модель недоступна» к проверенному подключению по подписке Claude или
Codex либо к API-провайдеру. Машина состояний, работа с секретами, проверки и
признак завершения принадлежат детерминированному коду. Модель может
персонализировать формулировки только после `BRAIN_READY`.

## 2. Ответственность

Компонент отвечает за:

- долговечное состояние первоначальной настройки и продолжение после restart;
- контракты runtime и аутентификации подключаемого «мозга»;
- выбор, установку, аутентификацию, проверку, health и revoke;
- безопасные для журналирования события прогресса и коды ошибок;
- запрет разговорного onboarding до успешной проверки «мозга».

Компонент не отвечает за первоначальное связывание Telegram (ADR-0049),
маршрутизацию провайдеров после настройки (09), политику инструментов (05) и
состояние проектов (ADR-0060). Runtime-specific drivers реализуют общий
контракт, но остаются в runtime-слое.

## 3. Интерфейсы

```ts
interface BrainDriver {
  detect(): Promise<BrainDetectionResult>
  install(): Promise<BrainInstallResult>
  beginAuth(): Promise<AuthChallenge>
  validate(): Promise<BrainValidationResult>
  run(turn: BrainTurn, signal: AbortSignal): AsyncIterable<BrainEvent>
}

interface BrainBootstrap {
  state(): Promise<BrainBootstrapState>
  dispatch(event: BrainBootstrapEvent): Promise<BrainBootstrapState>
}
```

Предусмотрены два класса реализаций `BrainDriver`:

- `native-api` для Anthropic, OpenAI и OpenRouter-compatible API;
- supervised runtime `claude-code` и `codex-app-server` для подписок.

Необработанные учётные данные являются только входными данными. Они не входят
в `BrainConnection`, `BrainBootstrapState`, `AuthChallenge`, `BrainEvent` или
observability payload.

## 4. Структуры данных

`BrainConnection` хранит provider/runtime/auth mode, безопасные capability
metadata, routes, status, timestamps и стабильные коды ошибок. Учётных данных в
нём нет.

`BrainBootstrapState` версионируется и сохраняется после каждого принятого
события:

```ts
interface BrainBootstrapState {
  version: 1
  phase: BrainBootstrapPhase
  revision: number
  updatedAt: string
  selectedBrain?: SelectedBrain
  lastErrorCode?: string
}
```

Persistence adapter обязан проверять exact schema и согласованность phase/status.
Публикация использует CAS по revision, exclusive owner lock, приватный временный
файл, `fsync(file)`, atomic rename и `fsync(directory)`. Успешный возврат означает,
что и содержимое файла, и rename пересекли границу долговечности. Неудачное
сохранение не публикует transition и не обновляет in-memory state.

## 5. Поведение и поток управления

```text
NO_BRAIN
  → CHOOSE_BRAIN
  → INSTALLING_RUNTIME?
  → AWAITING_AUTH
  → VALIDATING_AUTH
  → BRAIN_READY
  → INTRO_AGENT
  → INTRO_OPERATOR
  → FIRST_PROJECT
  → INITIAL_AUTONOMY
  → COMPLETE
```

Недопустимые переходы закрываются с ошибкой. Ошибка аутентификации или проверки
остаётся повторяемой и никогда не помечает «мозг» готовым. `reset-brain` удаляет
только metadata выбора; удаление учётных данных — отдельное действие
vault/connection.

До `BRAIN_READY` Telegram отвечает детерминированными шаблонами. После
`BRAIN_READY` может начаться обычный разговорный onboarding, но каждая мутация
конфигурации по-прежнему проходит через code-owned cards и validators.

## 6. Зависимости

- Внутренние: Gateway pairing и cards, Vault/redactor, Provider Routing,
  Onboarding/Doctor, Observability.
- Внешние: официальный Telegram Bot API, Claude Code runtime, Codex app-server,
  validation endpoints провайдеров.

Чистая машина состояний не вызывает внешние зависимости.

## 7. Отказы и деградированные режимы

| Отказ | Обнаружение | Поведение | Восстановление |
|---|---|---|---|
| «Мозг» не настроен | сохранённый `NO_BRAIN` | Telegram работает только в setup-mode | выбрать подключение |
| Runtime отсутствует | `detect().installed=false` | переход в `INSTALLING_RUNTIME` | установить либо выбрать API |
| Аутентификация отклонена | безопасный код driver | остаться в `AWAITING_AUTH`, не объявлять готовность | повторить либо reset |
| Проверка недоступна | классификация timeout/network | закрыться, оставить connection в staged | повторить validation |
| Store недоступен | ошибка save/load | не публиковать transition | восстановить store и повторить |
| Состояние повреждено | exact schema validation | закрыться и показать doctor finding | восстановить backup либо явно reset |
| Lock уже существует | exclusive-create failure | не красть lock и не писать state | operator-visible doctor recovery |
| Сбой после rename | revision и canonical bytes совпадают | считать результат неоднозначным | идемпотентно повторить тот же revision |
| Протокол runtime изменился | ошибка контракта/parser | пометить driver недоступным | обновить driver/runtime |
| Production backend/proxy недоступен | health или exact binding check | не выдавать challenge и не объявлять connection готовым; plaintext fallback запрещён | восстановить backend/proxy и повторить validation |
| Opaque handle устарел или относится к другому binding | broker/proxy exact check | отклонить до network I/O | создать новый staged handle для точного binding |

## 8. Безопасность и модель угроз

| Угроза | Детерминированная защита |
|---|---|
| Злоумышленник связывает бота первым | pairing code из терминала по ADR-0049 |
| API key попадает в контекст модели | secret-input handler перехватывает его до Gateway spans |
| Секрет попадает в logs/errors | typed safe events/codes и Vault redactor |
| Секрет раскрывается в Telegram | явное предупреждение и рекомендуемый одноразовый local/SSH input |
| OAuth output содержит tokens | parser driver разрешает только поля challenge |
| Модель объявляет setup завершённым | только машина состояний достигает `COMPLETE` |
| Непрозрачный runtime обходит Aisy | supervised event/tool bridge и sandbox по ADR-0057 |
| Restart пропускает validation | точное восстановление phase и revision |
| Два процесса теряют обновление | exclusive owner lock и CAS по revision |
| Symlink перенаправляет state наружу | `lstat`, `O_NOFOLLOW`, private directory/file policy |
| Crash оставляет stale lock | автоматический takeover запрещён; recovery явный |

## 9. Критерии приёмки

### Текущая доказанная композиция (2026-07-27)

`makeBrainBootstrapCoordinator` соединяет durable state machine с exact
allowlisted setup drivers. Каждая команда принимает ожидаемую revision,
выполняется под process-local serial barrier и повторно читает durable state.
Concurrent/stale callback не может повторить install, начать второй auth flow
или подтвердить другую connection. Driver обязан совпасть по `connectionId`,
provider, auth mode и runtime до изменения state.

Цепочка `select → detect → install? → beginAuth → validate` публикует только
стабильные code-owned error codes. Raw runtime output, validation detail,
account metadata и challenge не сохраняются. Device/browser/secure-input
challenge проходит allowlist полей, HTTPS и bounded-text validation; длинные
token-like значения и control characters отклоняются. Один coordinator выдаёт
не более одного challenge на revision. Restart в `VALIDATING_AUTH` повторяет
только validate, а `NO_BRAIN`, `CHOOSE_BRAIN` и `AWAITING_AUTH`
восстанавливаются без внешнего действия.

Ошибка установки остаётся в `INSTALLING_RUNTIME` со статусом `failed` и может
быть повторена только с новой exact revision. Health check не меняет state.
Revoke сбрасывает bootstrap metadata только после успешного driver revoke;
ошибка оставляет выбранное подключение и revision неизменными.

Telegram callbacks содержат durable revision. Старая карточка без revision не
декодируется, а несовпадение с текущим state закрывается до driver call. Setup
transport показывает только проверенный challenge и не принимает API key в
обычном Telegram-чате. Для secure input требуется отдельный локальный,
SSH- или Tailscale-канал.

`makeCodexSubscriptionSetupDriver` связывает coordinator с официальным Codex
auth lifecycle. Реальный auth adapter использует только `codex --version`,
`codex login --device-auth`, `codex login status` и `codex logout`; raw CLI
output не становится state/result detail. Installer остаётся explicit injected
port: Aisy не придумывает и не запускает неизвестную install-команду.

`makeNodeBrainBootstrapStore` подключён к setup-only ветке live composition.
Store принимает только exact schema с согласованными phase/status, canonical
UTC timestamp и bounded stable error code. Файл, lock и temp имеют mode `0600`;
symlink и over-broad state file закрываются до чтения. Сохранение выполняется
под owner-bound lock, проверяет предыдущую revision, публикует через exclusive
temp → file fsync → rename → directory fsync и не крадёт stale lock. После
неоднозначного post-rename fsync сбоя допускается только byte-equivalent повтор
той же revision.

Официальная документация описывает app-server как JSON-RPC 2.0 интерфейс для
глубоких интеграций; experimental и unsupported остаётся WebSocket transport,
а stable stdio использует JSONL. Read-only supervised driver закреплён на
сгенерированном Codex v2 profile `0.144.5`, выполняет
`initialize → initialized → thread/start|resume → turn/start`, проверяет exact
thread/turn binding, стримит agent delta, прерывается через `turn/interrupt` и
продолжает exact thread после restart через injected durable store.

До typed Aisy capability bridge driver принудительно задаёт `sandbox=read-only`,
`approvalPolicy=never` и не включает experimental API. Любой command, file,
MCP, dynamic tool, collaboration item или server-initiated request вызывает
interrupt и redacted failure.

Node transport запускает только канонический абсолютный owner-owned executable
без group/world write с точными аргументами `app-server --listen stdio://` и
таким же owner-controlled рабочим каталогом. Дочерний процесс получает только
allowlist безопасных переменных
окружения; API keys и произвольные parent values не наследуются. JSONL frame,
pending requests и event queue имеют жёсткие пределы. Unknown/replayed response,
malformed/oversized JSON, timeout, overflow и второй event consumer закрывают
всё соединение стабильным кодом без stderr/raw output.

Durable thread store хранит только Project/Session/thread/profile metadata в
приватной SQLite базе `0600` внутри owner-owned каталога `0700`. Canonical path,
symlink, owner, exact tables/indexes/columns, отсутствие лишних view/trigger,
integrity check и каждая существующая строка проверяются на startup. Уникальность
thread и Project/Session публикуется через `BEGIN IMMEDIATE`; identical retry
идемпотентен, а competing process получает conflict. Real-filesystem E2E
доказывает restart и exact `thread/resume` поверх JSONL fake child boundary.

Production factory использует один exact executable для auth lifecycle и
app-server, общий allowlist процесса, SQLite store и `ProviderAdapter`. Вход и
рабочие ходы используют один выделенный `CODEX_HOME`: каталог принадлежит
оператору, имеет mode `0700`, а управляемый `config.toml` — `0600`. Изменение
каталога или config после старта закрывает новый app-server session до spawn.

Для каждого хода Aisy поднимает отдельный loopback MCP server с новым bearer,
передаёт Codex только точный каталог Aisy и после `turn/start` связывает мост с
exact thread/turn metadata. JSON-RPC replay с тем же id возвращает прежний
результат без повторного effect; изменённый replay, чужой thread/turn/server,
unknown tool и вызов до binding отклоняются. Нативные shell/file/web/apps/
plugins/connectors выключены в code-owned thread config; любой наблюдаемый
native item или server request немедленно прерывает ход. Исполнение Aisy tool
по-прежнему проходит общий режим, Safety/HookGate, grant и Telegram approval.
App-server и thread запускаются в отдельном пустом каталоге `0700`, а не в
проекте пользователя: относительное чтение workspace через случайно уцелевший
нативный read-only инструмент не видит файлы проекта.

Live `aisy.ts` создаёт этот runtime только при выборе
`codex-subscription`, сохраняет выбор после setup и закрывает SQLite authority
при штатном завершении. Model `default` не подменяется строкой: app-server
использует текущую модель подписки; явная модель передаётся отдельно.
Provider adapter показывает оператору `tool-requested/tool-result`, принимает
ответ только из terminal `completed` и сохраняет отдельный capability protocol
profile при restart. Отдельный opt-in smoke по-прежнему проверяет реальный
`initialize/initialized` без account login и model turn; реальная подписка и
серверный Telegram E2E остаются эксплуатационной приёмкой.

Каждый Codex run теперь повторно доказывает готовность до открытия app-server:
exact Project/Session request binding, канонический Project root, установленный
runtime с закреплённой версией `codex-cli 0.144.5` и успешную auth validation.
После `started` driver принимает только закреплённую последовательность
событий exact thread/turn: retryable `error` продолжает тот же turn, а
non-retryable или malformed `error`, лишнее событие после terminal и незакрытый
event stream дают стабильный code-only отказ и bounded cleanup. Это усиление
app-server пути. Preflight failure разрешён до `started`, потому что модель ещё
не начала ход; adapter сохраняет его стабильный code-only результат вместо
ложной ошибки порядка событий.

Для Claude Code реализован dormant read-only preview parser/process boundary.
Protocol FSM принимает только точный allowlist событий и exact terminal result;
лишние `stop_reason`, `terminal_reason`, `origin`, `deferred_tool_use`, usage- и
fast-mode поля закрывают turn. Вызов не может сам подтвердить свою изоляцию:
caller-provided attestor/receipt отсутствует. Пока не появился code-owned
managed-policy/container runtime, Node boundary всегда возвращает стабильный
`CLAUDE_ISOLATION_FAILED` до `spawn`/`exec` и очищает staged executable.

Аварийное завершение вынесено в concrete Node supervisor. Он принимает только
точную process group с `PGID === PID`, отправляет `SIGTERM`, затем `SIGKILL` по
отрицательному PGID и считает остановку доказанной лишь после `ESRCH` отдельно
для PID и группы. Любой mismatch, timeout или reject даёт
`CLAUDE_TERMINATION_UNCONFIRMED`: turn карантинируется, staged artifact
сохраняется для расследования, а synthetic terminal success запрещён. Этот
supervisor сам по себе не активирует Claude driver и не заменяет отсутствующий
code-owned isolation runtime.

Claude subscription run-driver отдельно закрыт до завершения его изоляции и
серверной приёмки. Claude automatic smoke закрыт до изоляции cwd,
project settings, hooks и MCP. API
provider live flow всё ещё требует production secret backend, opaque
credential-injecting proxy и unified restart E2E. Live coordinator/drivers и
activation не подключались.

API credential path получил отдельную control-plane границу. Native API setup
driver не принимает и не читает key: он выдаёт только bounded one-use entry-code
для команды `aisy brain credential set` и вызывает broker по exact
`connectionId/provider/vaultKey`. Durable SQLite store сохраняет только SHA-256
публичного code, exact binding, phase и timestamps; raw code удаляется при
atomic claim. Два процесса не могут claim один code, новый challenge
суперседит старый, replay/expiry закрываются.

Ingress получает secret как owned `Uint8Array`, после операции зануляет buffer
и не возвращает bytes. Новый key сначала сохраняется в staged vault transaction,
проверяется provider validator по opaque handle и только затем атомарно
становится active. Старый active key не удаляется до успешной проверки.
Restart восстанавливает crash после stage и после activate; rollback failure
оставляет `committing`, чтобы cleanup можно было повторить. Revoke сначала
удаляет pending stage, затем active handle и только после этого публикует
`revoked`.

CLI принимает только точную команду
`aisy brain credential set --code=<one-use-code>`. Secret запрещён в argv,
environment и pipe; ввод разрешён только из интерактивного TTY без echo,
звёздочек или иной утечки длины. Raw terminal adapter восстанавливает режим
терминала при success, cancel и fault; если восстановление нельзя доказать,
credential не передаётся в ingress. И CLI, и ingress зануляют принадлежащие им
буферы, а exception detail не выводится оператору.

Native API validators принимают только staged/active opaque handle. Код жёстко
задаёт отдельные descriptors: OpenAI `GET https://api.openai.com/v1/models`,
Anthropic `GET https://api.anthropic.com/v1/models` с protocol
`anthropic-x-api-key-2023-06-01` и OpenRouter
`GET https://openrouter.ai/api/v1/models`. Для всех заданы `redirect=error`,
timeout и `status-only`; URL, method, headers и body нельзя получить из config
или от модели. Только точный HTTP 200 считается успехом. 401/403, timeout, rate
limit, provider failure и protocol anomaly превращаются в стабильные redacted
codes. Каждый provider жёстко связан со своим vault slot; cross-provider slot
закрывается до proxy I/O. Ответ proxy с body, headers или дополнительным
metadata отклоняется.

Эта foundation пока не активна: ADR-0087 фиксирует production-архитектуру
opaque secret broker/backend/proxy без plaintext fallback, но её platform
adapters и live wiring ещё не реализованы и не подключены. CLI routing,
no-echo terminal adapter и provider status-only validators реализованы как
инъецируемые границы, но live app не выдаёт challenge без production backend.
Legacy plaintext `vault.json` не расширялся и не является backend нового пути.
Telegram показывает кнопку validation только когда secure terminal entry
действительно доступен; ввод key в чат всегда отключён.

До появления production backend/proxy LIVE composition применяет отдельный
fail-closed gate: любой native API provider в default, tier, fallback или
agent override переводит запуск в setup-only, а защитная проверка adapter
повторно отказывает стабильным `NATIVE_API_SECRET_PROXY_REQUIRED`. Наличие key
в legacy `.env`/environment/`vault.json` не считается authority и не открывает
provider. Setup Telegram не получает legacy credential writer; ошибочно
отправленное сообщение best-effort удаляется, но его bytes не валидируются, не
сохраняются и не продвигают bootstrap. Subscription-провайдеры этим gate не
затронуты. Это enforcement существующего ADR-0087, а не активация backend.

Доказательства: 10 state-machine, 10 coordinator, 10 Codex auth, 1 Codex setup
adapter, 8 Telegram view, 5 setup transport, 12 durable store unit, 3 Node
integration, 36 CLI, 6 raw TTY, 16 provider validator, 37 Codex
app-server driver, 13 Node JSONL transport, 10 SQLite thread store, 1
transport/store restart, 2 read-only app composition, 3 live Codex subscription
composition, 10 MCP bridge, 7 capability bridge, 5 safety/approval executor,
14 Brain provider adapter, 5 Telegram
reply-stream, 6 Telegram streaming/cancel transport, 6 execution-card stream,
6 Telegram media transport, 1 capability Project-lease E2E и 1 real-process
opt-in smoke tests.
Security reviews:
`docs/reviews/2026-07-27-brain-bootstrap-coordinator-security-review.md`.
`docs/reviews/2026-07-27-codex-app-server-driver-security-review.md`.
Полный regression gate этого среза: core 2163 passed и 1 opt-in skipped,
Telegram gateway 166/166, app 1760 passed и 17 platform/opt-in skipped;
workspace typecheck/build и `git diff --check` зелёные. Python sidecars не
менялись; последний полный gate: 34 passed и 1 platform skip.

1. **AC-16-1** — Чтение свежего state возвращает `NO_BRAIN` и ничего не записывает.
2. **AC-16-2** — Выбор native API сразу переводит bootstrap в `AWAITING_AUTH`.
3. **AC-16-3** — Отсутствующий subscription runtime проходит `INSTALLING_RUNTIME` до auth.
4. **AC-16-4** — Только успешная validation достигает `BRAIN_READY`, затем идут фиксированные personal-onboarding phases.
5. **AC-16-5** — Ошибка auth/validation сохраняет только стабильный код и допускает retry.
6. **AC-16-6** — Новый процесс восстанавливает byte-equivalent phase, revision и selected-brain metadata.
7. **AC-16-7** — Ошибка persistence оставляет предыдущее observable state неизменным.
8. **AC-16-8** — Повреждённое persisted state закрывается с ошибкой.
9. **AC-16-9** — Transition events не содержат credential или raw auth material.
10. **AC-16-10** — API secret input не появляется в spans, journal, diagnostics или memory.
11. **AC-16-11** — Codex device auth раскрывает только verification URL/code и проверяет `login status` до readiness.
12. **AC-16-12** — Claude subscription использует только официальный login flow и read-only structured smoke turn.
13. **AC-16-13** — Полный clean-install flow корректно продолжается после restart на каждой phase.
14. **AC-16-14** — Меню постоянно: `/start` и `/menu` показывают reply keyboard, а первое проактивное сообщение после подключения мозга несёт клавиатуру на себе. Разговор её не убирает — обещание «меню внизу» должно быть правдой в тот же момент, когда оно произнесено.
15. **AC-16-15** — При paired Telegram без provider `aisy run` запускает setup-only mode, а не завершает процесс и не создаёт `AgentRunner`.
16. **AC-16-16** — Setup-only mode принимает updates только от paired chat, показывает code-owned views и не отправляет free-form text модели.
17. **AC-16-17** — Brain-choice callbacks allowlisted и отображаются в typed events; stale/replay закрываются.
18. **AC-16-18** — Bootstrap state публикуется через exclusive temp, file fsync, atomic rename и directory fsync; setup card продолжается с durable phase после restart.
19. **AC-16-19** — Codex auth запускает только официальный `codex login --device-auth`, выдаёт HTTPS URL/code и не хранит token.
20. **AC-16-20** — Codex readiness ждёт device process и выполняет `codex login status`; raw CLI output не попадает в state/events/errors.
21. **AC-16-21** — Claude Pro/Max требует официальный interactive `claude` flow; Aisy не изобретает headless login и не копирует credential files.
22. **AC-16-22** — Claude validation принимает только documented JSON envelope, exact smoke marker, plan mode, one turn и explicit disallowed-tools list.
23. **AC-16-23** — Automatic Claude smoke закрыт до изоляции settings, hooks, MCP и cwd; command builder/parser могут тестироваться без account execution.
24. **AC-16-24** — Store отклоняет unknown fields, phase/status mismatch, invalid timestamps/error codes, symlink и state file шире `0600`.
25. **AC-16-25** — Два writer не могут молча перезаписать друг друга: owner lock и CAS допускают только следующую revision либо identical retry.
26. **AC-16-26** — Fault injection на temp write/fsync/rename сохраняет предыдущую selectable revision; post-rename ambiguity восстанавливается identical retry.
27. **AC-16-27** — Stale/corrupt lock никогда не перехватывается автоматически и требует явного doctor recovery.
28. **AC-16-28** — Native API setup driver видит только credential handle и публичный entry-code, но не secret bytes.
29. **AC-16-29** — Durable ingress хранит hash entry-code; atomic claim допускает одного победителя и блокирует replay/expiry/superseded code.
30. **AC-16-30** — Rotation проходит stage → provider validation → atomic activation; прежний active key сохраняется до success.
31. **AC-16-31** — Restart восстанавливает staged и activated-but-unpublished transaction без повторного secret input.
32. **AC-16-32** — SQLite ingress metadata использует exact schema, `synchronous=FULL`, `secure_delete`, mode `0600` и canonical private path.
33. **AC-16-33** — Ingress зануляет owned secret buffer на success, validation failure, replay и invalid-input paths.
34. **AC-16-34** — Telegram никогда не принимает API key и показывает validate action только при доступном protected terminal channel.
35. **AC-16-35** — CLI принимает только `brain credential set --code=...`; secret в argv, environment, pipe и non-TTY закрывается до ingress.
36. **AC-16-36** — Raw TTY input не выводит echo/mask/length и восстанавливает terminal mode; недоказуемое восстановление закрывает activation.
37. **AC-16-37** — CLI и ingress зануляют owned buffers на success/failure/cancel, а raw exception/output не попадает в operator result.
38. **AC-16-38** — OpenAI, Anthropic и OpenRouter validation используют только opaque handle, собственные vault slot и code-owned `GET /v1/models`; cross-provider binding/slot, redirect, любой статус кроме 200 и богатый proxy response закрываются.
39. **AC-16-39** — При отсутствии production secret backend/proxy CLI и live bootstrap fail closed и не объявляют API connection готовым.
40. **AC-16-40** — Первый контакт идёт одной цепочкой: агент пишет первым (клавиатура на этом же сообщении), сразу за ним приходит карточка сервисов из того же каталога, что и `⚙️ Настройки → 🔑 Ключи`, с отметкой уже подключённых. Карточка не заменяет разговор: знакомство ведёт агент.
41. **AC-16-41** — Знакомство закрывается один раз на установку: когда закрыты все шесть тем, агент подводит итог своими словами, предлагает экран часового пояса, если он не задан, и присылает тур по восьми разделам меню, построенный из самого меню. Маркер пишется после отправки, поэтому сбой повторяет попытку, а не пропускает её.
40. **AC-16-40** — Codex app-server run принимает только pinned v2 profile, stable stdio subset и exact Project/Session→thread binding; mismatch/unknown version закрываются до model output.
41. **AC-16-41** — Read-only Codex slice всегда задаёт `sandbox=read-only`, `approvalPolicy=never`; native tool/item/server request вызывает `turn/interrupt` и не раскрывает raw action/output.
42. **AC-16-42** — Codex streaming ограничен по байтам, cancellation закрывает session, а restart возобновляет только exact persisted thread без silent replacement.
43. **AC-16-43** — Node transport запускает только канонические owner-controlled executable/cwd без group/world write, с exact stdio-командой и безопасным environment allowlist; provider/API secrets не наследуются.
44. **AC-16-44** — Malformed/oversized JSONL, unknown response id, timeout, queue overflow и повторный event consumer закрывают всё соединение без raw child output.
45. **AC-16-45** — SQLite thread store проверяет private canonical path, exact schema и все строки на startup; competing writers имеют одного победителя, а restart выполняет exact thread resume.
46. **AC-16-46** — Auth lifecycle и app-server закреплены на одном canonical executable и общем allowlist процесса; auth port запускает только четыре code-owned command shape.
47. **AC-16-47** — App-level factory восстанавливает exact thread после пересборки, invalid config не создаёт store, а opt-in account-free smoke выполняет stable handshake с реальным pinned Codex process.
48. **AC-16-48** — Capability bridge замыкает exact Project/Session/thread/turn и provenance в code-owned контексте; чужой tool, altered replay, превышение budget, inactive binding и close/abort не достигают executor.
49. **AC-16-49** — Разрешённый capability call проходит через общий Safety/HookGate: HARD_DENY не вызывает approval/effect, Tier-2 требует human approval, grant покрывает только exact binding, untrusted-контекст fail closed, а app executor выполняет file effect только через свежую durable Project lease.
50. **AC-16-50** — Read-only Brain adapter передаёт structured deltas в owned
    agent loop, но отклоняет native capability/approval events; terminal reply и
    usage возвращаются как обычный `ModelResponse`, exact Project/Session binding
    сохраняется после restart.
51. **AC-16-51** — Codex run до app-server I/O повторно проверяет exact
    request/Project/Session/root, pinned runtime version и auth readiness, а
    event FSM принимает только exact-bound lifecycle, различает retryable и
    terminal error и требует EOF после terminal. Исключение driver/iterator,
    событие после terminal и незакрытый stream превращаются в стабильный
    redacted code с bounded iterator cleanup.
52. **AC-16-52** — Claude terminal result принимает только exact documented
    allowlist; любое extra/deferred/origin/stop поле отклоняет turn без передачи
    raw child output в model context.
53. **AC-16-53** — без code-owned isolation runtime Claude preview возвращает
    `CLAUDE_ISOLATION_FAILED` до `spawn`/`exec`; caller не может передать
    attestation/receipt и самостоятельно активировать process boundary.
54. **AC-16-54** — Node termination supervisor сигналит только exact
    `PGID === PID`, подтверждает исчезновение PID и process group через `ESRCH`;
    mismatch/timeout/любая ошибка сохраняют stage и дают
    `CLAUDE_TERMINATION_UNCONFIRMED`, не synthetic completion.
55. **AC-16-55** — Production credential path использует только разрешённый
    ADR-0087 backend и opaque handle; отсутствие backend, его повреждение или
    restart не включают fallback в argv/env/plaintext-файл/SQLite.
56. **AC-16-56** — Broker и proxy проверяют exact operator/profile/connection/
    provider/slot/revision и code-owned request descriptor до network I/O;
    secret bytes не возвращаются driver, модели или observability.
57. **AC-16-57** — Rotation/revoke переживают crash без двух active revisions,
    resurrection отозванного handle и публикации `ready` до успешной проверки;
    audit остаётся redacted.
58. **AC-16-58** — Готовность `BrainConnection` не является согласием на
    semantic egress памяти: этот path дополнительно требует отдельную exact
    authority ADR-0088.
59. **AC-16-59** — `codex-subscription` доступен в live provider catalog;
    успешный setup сохраняет его как default и следующий supervised restart
    запускает обычный Aisy runtime, а не повторный setup-only режим.
60. **AC-16-60** — Device auth и app-server используют один private
    `CODEX_HOME`; symlink, чужой owner, небезопасные mode или изменённый
    `config.toml` закрывают запуск до child spawn.
61. **AC-16-61** — Каждый model turn получает один новый loopback MCP bridge с
    bearer и exact Aisy tool allowlist; Codex thread config выключает native
    shell, web, apps, plugins и connectors, process/thread cwd указывает на
    отдельный пустой каталог, а любой native item вызывает interrupt.
62. **AC-16-62** — MCP effect выполняется только после exact
    thread/turn binding. Missing/foreign metadata, unknown server/tool,
    duplicate binding и altered replay дают zero effect; exact replay не
    исполняется второй раз.
63. **AC-16-63** — Capability provider передаёт
    `tool-requested/tool-result` в execution card, но не принимает native
    approval event; preflight failure до `started` сохраняет стабильный код.
64. **AC-16-64** — Capability thread сохраняется с отдельным pinned profile,
    read-only/capability profile нельзя взаимозаменить после restart; model
    `default` означает account default и не отправляется как выдуманный id.
65. **AC-16-65** — Полный onboarding-бриф входит только в code-owned prompt
    первого проактивного контакта и не входит в frozen prefix Session. После
    отправленного приветствия незакрытые темы не добавляют анкету в обычный ход;
    bounded follow-up scheduler сохраняется.
66. **AC-16-66** — Restart после первого контакта не возвращает onboarding-бриф
    в обычный диалог, даже если часть тем всё ещё не закрыта.

Трассировка AC-16-51…54:
`runtime/codex-app-server-driver.spec.ts` и
`runtime/brain-provider-adapter.spec.ts`, а также
`runtime/claude-code-driver.spec.ts` и `runtime/claude-code-node.spec.ts`.
AC-16-59…64 трассируются в `codex-subscription-runtime.spec.ts`,
`mcp-bridge-server.spec.ts`, `codex-app-server-driver.spec.ts`,
`brain-provider-adapter.spec.ts` и `sqlite-codex-thread-store.spec.ts`.
Сквозной тест использует локальный fake app-server и реальный loopback bridge,
но не обращается к подписке или внешней сети.
AC-16-55…58 — обязательный gate будущей реализации ADR-0087/ADR-0088; live
integration-тестов для него пока нет.

## 10. Открытые вопросы

- Точная автоматизация Claude Code headless OAuth и code-owned
  managed-policy/container isolation runtime остаются integration spike;
  fallback — один явный SSH/terminal login без неофициального извлечения token.
- Архитектура production secret backend и credential-injecting proxy принята в
  ADR-0087. Остаются platform adapters, doctor, fault/restart E2E и отдельная
  live-активация; plaintext fallback запрещён.
- Команда doctor для проверки и явного восстановления abandoned bootstrap lock
  ещё не реализована; до неё lock остаётся fail-closed.
- Официальные `dynamicTools` и `item/tool/call` требуют experimental API и не
  могут расширять stable-only driver. Transport-independent Aisy capability
  bridge, общий Safety/Approval executor и Project-lease app seam уже готовы;
  следующий ADR должен выбрать wire transport локального MCP bridge с exact
  allowlist, прежними scope, budget и verification.
- Финальная MCP-ревизия `2026-07-28` была запланирована на 28 июля, но на момент
  проверки canonical `latest` всё ещё `2025-11-25`, versioned final schema нет,
  а TypeScript SDK v2 уже выпущен как stable `2.0.0`. Adapter нельзя закреплять
  на draft wire без финальной versioned schema.
  После GA он обязан pin’ить финальную schema/SDK, явно выбирать modern или
  legacy era и проверять фактическую поддержку со стороны pinned Codex runtime.
  Modern core stateless и не использует прежний MCP initialize/session contract.
  Локальный binary `codex-cli 0.144.5` уже содержит markers modern и legacy
  revisions, но это не доказывает выбранную client era; требуется negotiation
  E2E с controlled local server.

## 11. Ссылки

- [ADR-0034](../decisions/2026-06-11-onboarding-operations-layer.md)
- [ADR-0049](../decisions/2026-06-16-interactive-onboarding-and-telegram-pairing.md)
- [ADR-0057](../decisions/2026-07-26-aisy-control-plane-supervised-brain-runtimes.md)
- [ADR-0058](../decisions/2026-07-26-telegram-first-bootstrap-brain-connections.md)
- [ADR-0111](../decisions/2026-08-28-silent-learned-context-and-bounded-onboarding.md)
- [ADR-0087](../decisions/2026-07-29-opaque-secret-broker-backend-proxy.md)
- [ADR-0088](../decisions/2026-07-29-durable-semantic-egress-consent.md)
- [OpenAI Models API](https://developers.openai.com/api/docs/models)
- [Anthropic Models API](https://platform.claude.com/docs/en/api/models/list)
- [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
