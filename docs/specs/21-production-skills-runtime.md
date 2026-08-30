# Компонент 21: Production runtime Skills

**Статус:** LIVE для hash-pinned чтения, prompt-композиции, CLI install/remove и
Telegram-каталога/управления; typed auto-skill path ADR-0108 LIVE в коде только
при explicit `AISY_AUTO_SKILLS=1`, target-canary ещё не принят
**Связанные ADR:** ADR-0015, ADR-0017, ADR-0019, ADR-0027, ADR-0029, ADR-0108  
**Зависит от:** Agent Loop (01), Skills (06), Safety (05), Agent DNA (20)

## 1. Назначение

Production runtime должен давать модели только активные, явно проверенные и
закреплённые по хешу Skills. Краткое меню входит в замороженный префикс сессии,
а полное тело добавляется в рабочий контекст только при детерминированном
совпадении trigger. Повреждение файла или манифеста закрывает конкретный Skill,
но не делает базового агента недоступным.

Этот компонент не разрешает модели публиковать свободный Skill. Staging,
approval, git promotion и живое выполнение verification probes для свободного
Markdown остаются в компонентах 06, 10 и 12. Typed auto-skill ADR-0108 имеет
отдельный private manifest и может активироваться без тапа только потому, что
его vocabulary, scope и prompt projection полностью ограничены кодом.

## 2. Durable contract

`~/.aisy/skills-manifest.json` имеет schema version 1:

```json
{
  "schemaVersion": 1,
  "skills": [{
    "name": "inspect",
    "version": 1,
    "sha256": "<64 lowercase hex>",
    "trustSource": "user",
    "traceVerified": true,
    "status": "active",
    "touchedPaths": ["reports/result.json"]
  }]
}
```

Тело читается только из фиксированного пути
`~/.aisy/skills/<name>/SKILL.md`; манифест не может передать произвольный путь.
`name` соответствует `^[a-z0-9][a-z0-9-]*$`, файл не больше 256 KiB, SHA-256
совпадает с манифестом, frontmatter повторяет `name` и `version`, а тело содержит
`## verification`. Duplicate name и неизвестные значения закрываются.

`touchedPaths` — уже проверенная code-owned граница для делегации. Допускаются
только непустые относительные POSIX-пути без absolute root, `.`/`..`, пустых
сегментов, обратной косой черты и NUL. Runtime выдаёт эти пути только для Skill,
который прошёл все проверки и остался активным.

## 3. Trust и quarantine

В активный каталог попадает только запись одновременно со статусом `active` и
`traceVerified: true`. `trustSource` принимает `builtin`, `trusted-repo`,
`community` или `user`; сам Skill не может изменить source grade.

Причины quarantine: `invalid-manifest`, `invalid-skill`, `hash-mismatch`,
`identity-mismatch`, `unverified`. Node adapter атомарно публикует
`skills-quarantine.json` через временный файл, `fsync`, `rename` и `fsync`
каталога; каталог имеет mode `0700`, quarantine-файл — `0600`.

Quarantine переживает restart. Даже если оператор вернул исходные байты Skill,
он не активируется автоматически: сначала требуется осознанное восстановление
durable state. Исходный Skill не удаляется и остаётся доступен для post-mortem.

## 4. Prompt-композиция

При первом обращении к session в Agent Loop:

1. каталог сортирует `name + description`;
2. меню добавляется к frozen memory prefix;
3. для объединённых байтов пересчитывается `prefixHash`;
4. этот snapshot больше не меняется внутри живой session.

На каждом turn runtime собирает только operator-owned user spans, сопоставляет
их с trigger phrases и добавляет тела совпавших Skills как system spans. Тело не
попадает в prefix и не загружается в prompt без trigger. Ошибка необязательного
menu extension оставляет доступным базового агента.

## 5. Production wiring

- основной Telegram runner и goal runner используют общий активный каталог;
- Telegram-кнопка «Навыки» показывает то же активное меню;
- UI-проекция замораживается при композиции, содержит только
  `name + description` и при заданной main AgentCard фильтруется по её
  capability matrix;
- Telegram-рендерер не получает `SKILL.md` body, нормализует
  управляющие символы и ограничивает текст 4096 символами;
- subagent сначала проходит `resolveAgentCapabilityMatrix`, затем видит только
  Skills из своей immutable AgentCard;
- `touchedPaths` разрешаются из того же проверенного snapshot;
- неизвестная или неактивная ссылка на Skill блокирует AgentCard до model I/O;
- legacy/free-form каталог v1 формируется один раз при startup, поэтому его
  изменение требует контролируемого restart; только typed auto-skill overlay
  §5.1 имеет отдельный versioned next-turn path.

MCP registry, promotion UI, telemetry результата Skill и выполнение
verification probes этим компонентом пока не объявляются готовыми.
Main-agent capability matrix доступна в live binary только через
opt-in настройку; её default cutover требует отдельного согласования.

## 5.1 Typed auto-skill canary

При `AISY_AUTO_SKILLS=1` private schema v2 хранит immutable recipe revisions,
scoped active/previous pointers, evidence/jobs, forget tombstones и delivery
outbox. `AutoSkillScope` состоит из exact nullable botId, operatorId, profileId,
Project, resource scope и capability revision без session id. Поля выводятся
только из trusted runtime binding, кодируются fixed-order JSON с explicit null,
сравниваются bytewise и образуют domain-separated SHA-256 `scopeKey`. Отдельный
pointer key связывает `scopeKey + codeDerivedSkillIdentity`, поэтому skills
одного scope имеют независимые active/previous CAS. Predicate learning равен
`trusted && !narrowed`. Все файлы `0600`, каталоги `0700`; unknown schema
fail-closed.

До terminal reply bounded local write стадирует verified evidence как
`pending_reply`; оно не считается повторением и не создаёт candidate job.
Только callback после подтверждённой транспортом terminal Telegram reply и с
supervised exact `sessionId + turnId` переводит evidence в `live` и может
поставить job в очередь. Legacy volatile path не передаёт `turnId` и потому не
считается learning evidence. Generator/judge worker идёт после этого. Crash до
подтверждения даёт безопасный false negative; restart не повышает pending
evidence сам по себе. Blocked edit и uncertain delivery не вызывают callback.
Provider text сначала буферизуется для любого хода и выходит только если ответ
доказанно answer-only: неожиданный provider-side effect также отбрасывает ранние
deltas, поэтому модель не может показать ложное «запомнил» до durable receipt.
Lifecycle `queued → generated → validated → shadow_verified → prepared → active`
и forget `forget_claimed → purging → tombstoned` восстанавливаются idempotently.
Active pointer меняется только atomic CAS; durable previous не теряется при
активации другого Skill.

Durable reverse edges `session/project → evidence → job → revision` участвуют
в удалении source state. Session/Project purge начинается только после
`claimBySource` receipt, который одной транзакцией переводит зависимости в
`forget_claimed`, пишет anti-resurrection markers и снимает overlays. После
source purge отдельная idempotent фаза удаляет artifacts/evidence и переводит
record в terminal `tombstoned`. После restart фаза `purging` продолжается сама,
а `forget_claimed` может перейти к purge только если Project registry уже
подтвердил архивирование exact source. Эта recovery выполняется и при canary-on
startup, и при canary-off. Crash до claim не удаляет source; crash после claim
не возвращает skill. Несвязанная session оставляет revision активной.

Перед v2→v1 переключением managed rollback coordinator публикует durable
`preparing` barrier, дожидается отсутствия mutation-in-flight markers, завершает
только безопасно recoverable reverse-edge phases, проверяет пустой dependency
set и заменяет barrier на `certified` с exact v2 state hash и target commit.
Каждый обычный writer проверяет barrier до записи и непосредственно перед
atomic state rename. Handle, увидевший barrier или failed persist, навсегда
poisoned. Persistent store epoch меняется при rollback и explicit resume,
поэтому idle pre-barrier handle также не может сохранить старый snapshot.
Artifact prepare держит тот же in-flight marker: definite failure до state
rename удаляет созданный этой попыткой artifact, а post-rename ambiguity
сохраняет его для restart recovery. Crash-left marker содержит PID owner: живой owner блокирует switch,
dead owner сверяется через OS liveness. Очистка начинается только после
инвентаризации всех marker и глобальной quiescence. Marker v2 связывает exact
temporary basename: dead-owner temporary удаляется до marker, а temporary без
проверяемого владельца блокирует открытие и rollback. Read-only Doctor также
проверяет ожидаемый file/directory type, отсутствие symlink и private mode.
Artifact marker содержит
exact revision hash: directory удаляется только если durable state не содержит эту revision.
Poisoned/fenced handle не обслуживает active execution reads.
Barrier остаётся после active switch, поэтому уже запущенный процесс v2 тоже не
может создать поздний edge. Последняя проверка certificate выполняется перед
active rename. Gate применяется к rollback и ко
всем non-descendant `--allow-rewrite`, а не только к immediate previous.
После roll-forward barrier снимает отдельная команда v2-aware active release
`aisy update --resume-auto-skills`; downgrade target и неактивный release не
могут её выполнить. Read-only Doctor показывает barrier как `degraded`, а
malformed barrier как `corrupt`. Старый v1 binary не обязан понимать v2.

Typed manifest является source of truth для исполнения. Для exact активного
single-step `memory.remember` code-owned planner извлекает только безопасный
факт из текущего operator request и создаёт typed ToolCall; first-person и
составные/неоднозначные запросы остаются обычному provider planning. Provider
execution receipts принимаются только при exact call args, session/turn и
ожидаемом ordinal. Delivery подтверждает exact `evidenceId + sessionId + turnId`,
а source-wide nonterminal claim не разрешает новое evidence того же source
между claim и tombstone даже после restart. AgentLoop передаёт provider общий `toolOrdinalBase`, поэтому
локальные и subscription-side вызовы образуют одну монотонную последовательность
через все rounds одного turn; duplicate, foreign или mismatched receipt
fail-closed. Resume восстанавливает code-owned ordinal high-water из exact-turn
durable checkpoint, fsync которого завершён до dispatch. Provider-side attempt
регистрируется code-owned callback до dispatch; durable delegation включает
`toolOrdinalBase` в hashable projection, но держит callback вне persistence и
возвращает его non-enumerable только на exact provider dispatch. Progress остаётся наблюдением.
Thrown/failed
execution делает весь workflow непригодным для learning. Failover разрешён
только если primary ещё не сообщил ни одного tool attempt. Text-delta latch
остаётся закрытым до конца всего turn после plan, tool attempt или evidence, а
не сбрасывается между synthesis rounds. Generator и judge без tools обязаны иметь
разные exact provider/model/revision identity уже при startup canary.

Verified `remember` передаёт стабильный operation id в protected-memory
publication ledger как deterministic fact id. Новый executor после restart
завершает ту же WAL/completed operation без второго факта; другой fact с тем же
operation id получает idempotency conflict до новой публикации. In-process Map
остаётся только оптимизацией.

Следующий turn исходной session получает versioned `learned-procedure` overlay
без изменения frozen memory/history prefix. Новая session видит revision в
обычном scoped menu. Другой Project и child без exact scope/capability её не
видят. Notification использует durable at-most-once outbox: ambiguous Telegram
send не повторяется и отражается в Doctor.

Закрытый permanent failure enum — `descriptor_missing`,
`placeholder_missing`, `postcondition_mismatch`, `required_step_omitted`,
`scope_mismatch`; только receipt с exact recipe hash может демоутить revision.
Provider/network/timeout всегда transient. Re-enable повторяет все gates.

## 6. Критерии приёмки

1. **AC-21-1:** активный hash-pinned и trace-verified Skill присутствует в меню.
2. **AC-21-2:** archived/unverified/tampered/malformed Skill отсутствует в меню и
   получает durable quarantine.
3. **AC-21-3:** quarantine сохраняется после restart и не снимается возвратом
   прежних байтов.
4. **AC-21-4:** manifest не управляет filesystem path; traversal отклоняется до
   чтения.
5. **AC-21-5:** menu заморожено один раз на session, body входит только в
   совпавший turn.
6. **AC-21-6:** child получает только Skills своей capability matrix.
7. **AC-21-7:** небезопасный `touchedPaths` не расширяет делегационный scope.
8. **AC-21-8:** пустой или сломанный optional catalog не выводит базового агента
   из строя.
9. **AC-21-9:** UI-проекция замораживает точное main-AgentCard пересечение
   при композиции и не удерживает Skill body.
10. **AC-21-10:** без main AgentCard UI показывает все записи из уже
    проверенного active catalog, но не читает/не публикует body.
11. **AC-21-11:** Telegram-меню имеет явное empty state, сортирует metadata,
    удаляет управляющие символы и не превышает 4096 символов.

## 7. Критерии приёмки typed auto-skill canary

1. **AC-21-12:** два verified success разных sessions одного AutoSkillScope
   создают одну activation; same-session/retry/replay — ни одной.
2. **AC-21-13:** untrusted/narrowed/unverified/ambiguous turn не создаёт evidence.
3. **AC-21-14:** model output вне registry ids, same judge identity и broken/
   missing shadow effect fail-closed.
4. **AC-21-15:** next-turn overlay scoped по Project/resource/capability и не
   расширяет HookGate authority или child AgentCard.
5. **AC-21-16:** concurrent activation и crash каждой lifecycle/forget фазы не
   дублируют job/pointer/notification и сохраняют previous.
6. **AC-21-17:** permanent exact-revision receipt демоутит; transient failure —
   нет; re-enable повторно проходит gates.
7. **AC-21-18:** forget удаляет replayable/raw evidence, оставляет только
   минимальный tombstone и не допускает resurrection; linked source сначала
   снимает revision, unrelated session её не меняет, crash ordering сохраняется.
8. **AC-21-19:** canary-off делает zero auto-skill observation/overlay I/O;
   reverse-edge forget gate при этом остаётся active, а schema rollback и
   Doctor fail-closed проверены. Process-level v2→v1 test требует exact
   persistent barrier и rollback-safe certificate до switch, блокирует late
   writer после switch и допускает снятие barrier только active v2 roll-forward;
   crash/drift/new edge/in-flight mutation запрещают любой downgrade rewrite;
   stale store fenced persistent epoch, а SIGKILL marker снимается только после
   проверки завершившегося PID и global quiescence; exact bound temporary
   удаляется до marker, unattributed temporary блокирует startup/rollback и
   виден Doctor как `corrupt`, valid in-flight — как `degraded`; definite pre-rename artifact удаляется,
   post-rename ambiguity сохраняется для recovery, а dead artifact marker
   сверяется с durable revision inventory; poisoned handle не выдаёт active view.
9. **AC-21-20:** active typed manifest планируется кодом для exact safe request;
   provider не может заменить descriptor, а foreign/duplicate/non-monotonic
   receipt или преждевременный streamed acknowledgement отклоняются; provider
   throw остаётся failed evidence, failover после tool attempt запрещён,
   turn-wide latch и exact-turn resume ordinal high-water сохраняются между
   rounds/restart; delivery связан с exact evidence id, а verified `remember`
   остаётся exactly-once после restart protected-memory executor.
10. **AC-21-21:** exact certified managed rollback barrier после read-only
    проверки certificate и persisted state переводит только optional auto-skill
    canary в paused независимо от canary-флага: writable store handle не
    открывается, planning, observation, overlays и source-forget не исполняются,
    но базовый Telegram runtime, память и обычные tools запускаются. Corrupt,
    `preparing`, неизвестная ошибка store и barrier без rollback-aware
    composition остаются startup failure; после roll-forward требуется explicit
    resume.

## 8. Трассировка тестов

- `runtime/active-skill-catalog.spec.ts`: AC-21-1, 2, 4, 7;
- `runtime/skill-prompt-runtime.spec.ts`: AC-21-5, 8;
- `runtime/agent-runner.spec.ts`: AC-21-5;
- `runtime/sub-agent-runner.spec.ts` и `runtime/agent-capabilities.spec.ts`:
  AC-21-6;
- `app/active-skill-store.spec.ts`: AC-21-2, 3, 4;
- `app/skill-menu-runtime.spec.ts`: AC-21-9, 10;
- `telegram-gw/skill-catalog-view.spec.ts`: AC-21-11;
- `app/bot-skill-menu.spec.ts`: AC-21-1, 11.
- `core/auto-skill-learning/*.spec.ts`: AC-21-12, 13, 14, 15, 17, 18;
- `app/auto-skill-live-runtime.spec.ts`, `app/auto-skill-store.spec.ts` и
  `app/auto-skill-provider-ports.spec.ts`: AC-21-12–19, включая delivery
  confirmation, concurrency, crash/restart, outbox и canary-off;
- `app/managed-install.spec.ts` и `app/auto-skill-store.spec.ts`: AC-21-19 —
  persistent barrier, pre-switch drift, все non-descendant rewrites и explicit
  v2 roll-forward resume, poisoned stale handle и SIGKILL marker recovery;
- `core/agent-loop.spec.ts`, `app/*subscription*.spec.ts` и
  `core/runtime/failover-provider.spec.ts`,
  `app/auto-skill-live-runtime.spec.ts`: AC-21-20, включая failed provider
  evidence, запрет failover после attempt, turn-wide buffering и resume ordinal;
- `app/auto-skill-live-runtime.spec.ts`, `app/auto-skill-store.spec.ts` и
  `app/doctor-live-composition.spec.ts`:
  AC-21-21 — exact certified barrier отключает только canary даже при canary-off,
  production wiring не открывает store повторно, а corrupt/`preparing` barrier
  и остальные ошибки не скрываются;
- `app/telegram-project-runtime.integration.spec.ts`: AC-21-15, 16.
