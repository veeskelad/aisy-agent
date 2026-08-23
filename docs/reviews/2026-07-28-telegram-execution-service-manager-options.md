# Предложение решения: service manager для Telegram execution recovery

**Дата:** 2026-07-28  
**Статус:** рекомендация для согласования; это не принятый ADR  
**Live activation:** не входит в предложение

## Контекст

Durable execution checkpoint сохраняется самим `aisy run`, но после аварийного
завершения этот же процесс не может доказать две вещи: что старый runtime уже
остановлен и что восстановленный opaque binding был захвачен до начала исходного
turn. PID, возраст файла, checkpoint owner и lock-файл внутри state root не дают
такого доказательства. Обычный lock-файл также не освобождается ядром при crash и
создаёт опасный stale-lock recovery path.

Следовательно, authority и quiescence должен предоставлять более долгоживущий
code-owned service manager, который запускает runtime и не зависит от его state
root. Он не получает Telegram token, тексты сообщений, session id, turn id,
checkpoint bytes или provider credentials.

## Варианты

| Вариант | Quiescence после crash | Cross-platform | Новая поверхность | Оценка |
|---|---:|---:|---:|---|
| Parent supervisor + acknowledged IPC | сильное: новый child создаётся только после `exit` старого | да, Node child IPC | один локальный manager process | рекомендуется |
| Постоянный Unix-socket broker рядом с systemd/launchd | сильное при строгом peer/lease protocol | частично | socket ACL, framing, lifecycle двух services | избыточно для single-user v1 |
| Только systemd/launchd unit | доказывает отсутствие overlap, но не хранит exact turn authority | да с двумя реализациями | platform adapters | недостаточно без отдельного authority channel |
| PID/age/lock-файл в `~/.aisy` | не доказывает отсутствие живого process | да | stale-lock recovery | отклонить |

## Рекомендация

Принять **parent supervisor с acknowledged IPC** как единственный production
источник Telegram execution recovery authority:

1. service unit запускает supervisor, а не `aisy run` напрямую;
2. supervisor держит не больше одного runtime child и создаёт replacement только
   после подтверждённого `exit` предыдущего child;
3. до provider/checkpoint I/O child передаёт только lowercase SHA-256 binding и
   ждёт bounded ACK; отсутствие ACK закрывает turn кодом
   `EXECUTION_AUTHORITY_UNAVAILABLE`;
4. при restart supervisor выдаёт одноразовый recovery lease только replacement
   child и передаёт последний подтверждённый opaque binding;
5. child повторно проверяет lease непосредственно перед Telegram I/O и ждёт ACK
   освобождения lease до long polling, scheduler и provider work;
6. manager death, disconnect, duplicate child, malformed frame, неизвестная
   версия и timeout всегда закрывают recovery и новый turn;
7. IPC имеет exact versioned schema, длину frame, request id, deadline и
   allowlist типов; raw manager/child errors не попадают в Telegram, journal или
   checkpoint;
8. restart loop имеет code-owned backoff и budget; manager не интерпретирует
   model output и не выполняет tools;
9. rollback сохраняется структурно: без согласованной service composition
   `executionCheckpoint` отсутствует, а текущий live runtime остаётся неизменным.

## Почему не достаточно systemd/launchd

Service managers хорошо предотвращают одновременный запуск двух экземпляров,
но сами по себе не знают exact binding конкретного Telegram turn. Передача hash
через environment нового процесса также недостаточна: она не подтверждает, что
manager получил hash до checkpoint/provider work. Нужен acknowledged capture
channel, живущий дольше runtime child.

## Обязательные доказательства до activation

- real child kill/restart на `prepared`, `bound`, `terminal-pending` и
  `terminal-delivered`;
- duplicate-child и manager-disconnect дают zero provider/Telegram I/O;
- capture/release ACK timeout и malformed/oversized IPC frame не раскрывают raw
  detail;
- restart storm останавливается по backoff/budget;
- checkpoint и manager state roots private, не symlink и не принадлежат child
  одновременно;
- Linux service unit и macOS LaunchAgent выполняют один и тот же protocol
  conformance corpus;
- rollback возвращает прежний default-off запуск без migration данных.

## Запрашиваемое решение

После подтверждения следует создать MADR 3.0 ADR, добавить строку в
`docs/decisions/INDEX.md`, затем реализовать supervisor/IPC и только после
отдельного activation approval менять service units. До подтверждения допустимы
только transport-neutral contracts и offline tests.

## Связанные документы

- [Gateway / Connectivity](../specs/02-gateway-connectivity.md)
- [Security review execution checkpoint](2026-07-28-telegram-execution-checkpoint-security-review.md)
- [Runtime composition](../decisions/2026-06-16-runtime-composition-and-app-package.md)
- [Onboarding & Operations](../decisions/2026-06-11-onboarding-operations-layer.md)
