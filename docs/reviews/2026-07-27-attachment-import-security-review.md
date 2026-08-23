# Проверка безопасности импорта вложений

Дата: 2026-07-27  
Область: core contract и неактивированный Node/Python production seam
ADR-0060 / WP-23…WP-24

## Реализованные границы

- Import разрешён только для active Project lease; Workspace отклоняется до I/O.
- `ContextLeaseCoordinator` резервирует одну операцию до persistence/file I/O;
  stale lease не достигает портов, начатая атомарная операция дренируется.
- Inbox metadata принимает exact schema и проверяет operator/profile/session,
  SHA-256, размер, timestamp и control characters.
- `originalName` остаётся только untrusted metadata. Destination вычисляет код:
  `imports/<fileId>` либо `knowledge/imports/<fileId>`.
- Обязательный composition-owned limit проверяется до чтения attachment bytes.
- Manifest всегда получает `provenance: untrusted`; caller не может повысить
  доверие.
- Operation id caller-independent и детерминированно связан с binding, file id,
  inbox hash, semantic destination и code-owned path.
- Project-local serializer и CAS-shaped persistence port исключают
  внутрипроцессное пересечение state transitions.
- Recovery повторяет stage/install/publish/audit идемпотентно после каждого
  durable boundary, на каждом retry заново проверяет actual inbox hash и никогда
  не удаляет inbox object.
- Completed retry доверяет только exact published manifest плюс установленный
  hash. `AUDITED` WAL без них блокируется и не удаляется.
- Collision не публикует manifest; overwrite отсутствует и не может быть
  неявно разрешён моделью.
- Permission-restricted Node store сохраняет WAL, manifest и audit receipt через
  create-once/atomic rename, `fsync` и bounded no-follow reads. Повторный
  процесс видит durable effect после исключения сразу за границей записи.
- Binary sidecar не передаёт attachment bytes через JSON. Он открывает оба root
  descriptor-relative, отказывает symlink/hardlink/special/mount nodes,
  перепроверяет SHA-256 в процессе copy и использует no-overwrite publish.
- Manifest-aware confinement скрывает `FILE_INSTALLED` до `PUBLISHED`, запрещает
  обычную запись в reserved import namespace и проверяет published hash/size на
  каждом read/list. Нефильтруемый scan пересекающий import subtree закрыт.
- Attachment-aware turn factory передаёт import service тот же immutable lease,
  который использует runner, и оборачивает все file tools manifest-aware
  confinement. Tool принимает только два code-owned destination, не отражает
  untrusted `originalName` и редактирует внутренние ошибки в стабильный ответ.
- Неактивированный Telegram ingress проверяет allowlisted chat до download,
  фиксирует immutable binding/metadata authority, не сохраняет raw Telegram
  file id в provenance и публикует exact record только после durable binary
  object. Bot API adapter имеет фиксированный origin, запрещённые redirects и
  server-supplied path escape, bounded metadata и редактированные ошибки.

## Проверки

- success с hostile `originalName` и code-owned path;
- crash/retry после 11 side-effect/WAL boundaries;
- concurrent exact retries;
- foreign session и archived target до attachment file I/O;
- hash mismatch, collision и size cap без publication;
- stale lease и Workspace до persistence/file I/O;
- forged `AUDITED` WAL без published manifest.
- real Node restart после восьми storage/file durable effects;
- произвольный binary payload, symlink/hardlink/path escape и collision;
- installed-but-unpublished invisibility, последующая публикация и обнаружение
  tamper через `PATH_CHANGED`.
- model-tool import по exact Project/Session lease, безопасный metadata-only
  результат, последующий manifest-aware `read_file` и идемпотентный restart;
- Telegram media parsing, три inbox crash boundaries, restart без повторного
  download, caller-mutation TOCTOU, foreign chat/oversize до network I/O,
  collision/symlink и malicious Bot API file path.

Целевой regression нового слоя: 11 core attachment tests, Gateway
media-provenance tests, 4 app store + 13 Node→Python runtime tests, 15 app
Telegram inbox tests и 5 Python worker tests зелёные. Последний общий срез:
1324 core + 102 Telegram + 247 app tests; app typecheck/build повторно зелёные
после attachment-aware wiring. Предыдущий Python regression — 34 passed и
1 platform-specific skip.

## Остаточные риски и обязательные следующие слои

- Реальные исключения после durable effects и restart проверены, но нет
  `kill -9`, disk-full/EDQUOT, реального mount crossing и inode-bomb fixtures.
- Control-state directories проверяются как canonical/no-symlink и закрыты
  режимом `0700`; межпроцессное владение writer всё ещё зависит от отдельного
  ADR, поэтому live feature gate остаётся закрыт.
- Telegram attachment receiver и optional bot handler реализованы, но не
  переданы live-композиции `aisy.ts`; `import_attachment` доступен только через
  новый неактивированный v2/preview factory и в legacy runtime остаётся
  fail-closed unavailable.
- Operator-approved overwrite и collision-choice UI отсутствуют.
- Root/import aggregate scan сейчас намеренно запрещён manifest-aware wrapper,
  пока sidecar не умеет фильтровать unpublished paths без утечки counts.

## Вывод

Core state machine, Node store, binary sidecar, Telegram inbox и visibility gate
подтверждают локальный restart path ADR-0060. WP-23/24 и live activation ещё не
доказаны без singleton writer, collision UI и оставшихся adversarial OS
fixtures. Feature gate остаётся закрытым.

Эта AI-проверка является первым защитным проходом, а не заменой независимого
профессионального аудита безопасности перед production deployment.
