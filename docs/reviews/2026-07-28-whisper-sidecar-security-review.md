# Проверка безопасности production-preview Whisper sidecar

**Дата:** 2026-07-28  
**Статус:** worker, Docker adapter, offline inbox coordinator и выключенный
exact-bound bot seam реализованы; live voice не активирован  
**Связанные решения:** ADR-0003, ADR-0012, ADR-0027, ADR-0028

Дополнение 2026-07-28: offline singleton inbox writer реализован и проверен;
live voice по-прежнему не активирован.

## Граница

Проверен путь Telegram download → durable private audio object → bounded
transcript outcome → exact-bound AgentRunner dispatch. Media inbox singleton
writer, model image distribution и composition в `aisy.ts` не входят в этот
срез.

## Доказанные инварианты

- Audio bytes не проходят через JSON/stdout. Control plane содержит private
  root, относительный path, exact SHA-256/size и лимит.
- Root обязан быть canonical directory; worker повторно открывает путь
  descriptor-relative и запрещает escape, symlink, hardlink, special node и
  cross-device traversal.
- Модель вызывается только после повторной проверки всего audio digest и size.
- Container создаётся из exact digest без pull, сети и credentials. Rootfs
  read-only; user non-root; capabilities отсутствуют; включены
  no-new-privileges/seccomp, `ipc=none`, PID/RAM/CPU/time limits и bounded tmpfs.
- Audio root — единственный bind mount и доступен только для чтения. Фактический
  Docker inspect сравнивается с policy до worker stdin.
- Image должен содержать локальную модель `/models/whisper`; worker не имеет
  download fallback. Отсутствие модели даёт `MODEL_UNAVAILABLE`.
- Worker stdout имеет exact version/request id/schema. Transcript не больше
  1 MiB; результат code-owned помечен `untrusted` и `voice`.
- stderr, Python exception, Docker output и inspect detail никогда не входят в
  ошибку результата; наружу выходят только стабильные codes.
- Timeout, abort, output overflow и OOM fail-closed. После подтверждённого create
  container удаляется даже при ошибке.
- Неоднозначный create проходит recovery inspect. Adapter удаляет container
  только если image, labels, mount и вся sandbox policy совпадают; иначе
  возвращает `CLEANUP_FAILED`, не удаляя неизвестный объект.
- Повторный запрос stateless: заново проверяет Docker, file/hash и создаёт новый
  one-shot container.
- Offline coordinator повторно проверяет inbox record, exact
  operator/profile/session binding и детерминированную связь file/provenance/time
  с текущими Telegram update/message/voice; same-authority substitution и forged
  authority не достигают Whisper.
- `text-only|reject` — обязательная явная policy. Temporary failure не создаёт
  span, integrity failure не превращается в мягкую деградацию.
- Retry после restart использует durable inbox object и не скачивает Telegram
  bytes повторно. Cancellation до ingest делает zero download; после ingest
  оставляет object для retry.
- Transcript повторно ограничивается и проверяется coordinator-ом, даже если
  injected transcriber нарушил свой TypeScript contract.
- В одном adapter instance одновременно допускается только один Whisper
  container; concurrent request получает quota failure.
- Bot повторно сверяет outcome binding и transcript bounds, приобретает runtime
  только через exact `acquireBackgroundRuntime(binding)` и не использует legacy
  Gateway seam с Telegram file id. Один AbortSignal покрывает transcription и
  model turn.
- Active и debounce-buffered text считаются занятым single-flight turn slot;
  voice в этом состоянии блокируется до download и не может запустить второй
  turn с новым AbortController.
- Media inbox writer получает process-lifetime ownership через atomic private
  lock directory. Exact owner token проверяется до каждого ingest; завершение
  владения запрещено при active ingest и не меняет подменённого owner.
- Возраст и номер процесса не дают права на автоматический takeover: abandoned
  или повреждённый lock блокирует второй writer до operator-visible recovery.

## Проверки

- Python: success, hash/size/path/duplicate-key отказ до model, symlink/hardlink,
  redacted backend failure, transcript limit и stateless retry.
- TypeScript: exact Docker argv/inspect, отсутствие secret-shaped env/network,
  weakened inspect до stdin, timeout, OOM, worker error, malformed protocol,
  cleanup uncertainty, incompatible Docker и ambiguous-create recovery.
- App coordinator: exact object/hash/binding, restart without redownload,
  обе degrade policies, cancellation boundaries, forged authority/integrity,
  caller mutation TOCTOU, size/transcript limits и single-flight.
- Bot composition: exact runtime binding, substituted outcome refusal,
  code-owned degrade notice, cancellation до provider, buffered-turn race,
  полный bot → inbox → coordinator → AgentRunner restart без повторного
  download и disabled rollback.
- Gateway contract отдельно доказывает narrowing для voice/untrusted; legacy
  file-id seam не используется новым путем и остаётся выключенным.
- Inbox writer отдельно доказывает single-owner collision, clean restart без
  redownload, отказ takeover abandoned lock, foreign-owner tamper и
  release-during-ingest.
- Recovery отдельно доказывает redaction-safe doctor finding, exact
  fingerprint-bound approval, mandatory quiescence lease, atomic private audit
  archive, fencing старого runtime, exact restore, refusal поверх нового writer
  и code-only failure при невозможности освободить quiescence lease.

## Остаточные риски до activation

1. Нет опубликованного multi-arch image с закреплёнными Python wheels и локальной
   моделью; exact image digest пока задаётся только adapter contract. Варианты и
   рекомендуемая supply-chain policy оформлены в
   [предложении решения](2026-07-28-whisper-image-supply-decision-proposal.md),
   но ADR ещё не согласован.
2. Не выполнены реальные Docker/gVisor OOM/timeout tests на целевой Linux host.
3. Private inbox → Whisper → bot → exact-bound AgentRunner path собран offline,
   но `aisy.ts` его не композирует; старый Gateway seam всё ещё принимает
   Telegram file id и поэтому не должен активироваться.
4. Не выбрана operator-visible degrade policy (`reject`, bounded queue или
   `text-only`) и нет durable queue semantics.
5. Read-only finding подключён к `aisy doctor`, а recovery adapter проверен
   offline, но его mutating CLI path ещё не связан с service-manager quiescence
   и approval/grant runtime; feature gate остаётся выключенным.

## Rollback

Singleton wrapper также не подключён к `aisy.ts`. До activation требуется
подключить recovery adapter к code-owned service-stop lease и exact approval;
feature gate остаётся выключенным.

Adapter и voice seam не композируются в `aisy.ts`, feature flag не меняется.
Rollback до activation — не передавать `voiceIngress`; existing Telegram
transport продолжает fixed text-only fallback без download и model turn.

## Вывод

Process, filesystem, model-output и cleanup boundaries доказаны как
production-preview. Называть voice capability `LIVE` до закрытия пяти
остаточных пунктов нельзя.
