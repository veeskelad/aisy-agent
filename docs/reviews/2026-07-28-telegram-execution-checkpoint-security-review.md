# Security review: durable Telegram execution checkpoint

**Дата:** 2026-07-28  
**Статус:** offline implementation review; live activation не разрешена

## Граница

Checkpoint — только наблюдающая Telegram-проекция. Он не является transcript,
approval, grant, action evidence или источником resume authority. Authoritative
turn result остаётся в Agent Loop, dialogue — в ADR-0064 transcript, approval —
в nonce/action-hash store. Bot создаёт checkpoint только для turn с
transport-owned Telegram turn id; proactive вызов без устойчивого external id
остаётся на disabled path.

## Проверенные угрозы

| Угроза | Code-owned защита | Доказательство |
|---|---|---|
| Утечка chat/turn identity | raw chat id и turn id заменяются domain-separated SHA-256 binding | binding/serialization tests |
| Утечка model/tool данных | exact schema запрещает steps, args, result, reply, reasoning, note и unknown fields | adversarial schema tests |
| Подмена checkpoint | checksum, exact keys, bounded read, private regular file и `O_NOFOLLOW` | corrupt/permissions/Node restart tests |
| Late edit старого process | каждый network edit предваряется owner/revision replace; recovery сначала меняет owner | stale-owner test |
| Recovery чужого чата/turn | exact binding до output | foreign-binding zero-I/O test |
| Два живых process | recovery требует внешний quiescence proof; PID и возраст не дают authority | non-quiescent zero-I/O test |
| Подмена authority после restart | единый service-manager lease несёт opaque binding и quiescence; checkpoint не является источником authority | invalid/foreign authority tests |
| Потеря quiescence перед network I/O | lease повторно проверяется в output guard; состояние остаётся terminal pending | lease-loss zero-I/O test |
| Утечка ошибки service manager | capture/acquire/release сворачиваются в code-only result | bot/coordinator redaction tests |
| Crash между state и Telegram | `pending` пишется до I/O, `delivered` — после ответа | stream ordering test |
| Crash после принятого первого send до `message_id` | состояние остаётся `prepared`; recovery отправляет отдельную честную replacement-card | ambiguous-send test |
| Telegram edit failure | stable code, terminal остаётся `pending`, следующий recovery повторяет exact edit | retry test |

## Остаточные риски и activation gates

Telegram Bot API не предоставляет транзакцию между `sendMessage` и локальной
записью `message_id`, поэтому возможное старое running-сообщение в ambiguous
окне нельзя найти или отредактировать доказанно. Replacement-card сообщает о
restart, не заявляя обратного.

Live activation запрещена, пока production composition не предоставит:

1. ~~offline contract process/service-manager lease~~ реализован; concrete
   production adapter и фактический singleton требуют согласования
   [варианта service manager](2026-07-28-telegram-execution-service-manager-options.md);
2. canonical private state path и lifecycle owner id;
3. startup recovery до long polling/provider work;
4. ~~read-only doctor для missing/ready/pending/quarantined state~~ — подключён
   к настоящему `aisy doctor`, включая zero-write `--fix`;
5. rollback-to-disabled test без checkpoint writes;
6. ~~Node kill/restart state-boundary matrix~~ — отдельный child покрывает
   `prepared-pending`, `bound-delivered`, `terminal-pending` и clean
   `terminal-delivered`; реальный Telegram sandbox E2E остаётся activation gate.

## Итог

Offline seam не расширяет authority и fail-closed на corrupt/foreign/concurrent
recovery. Bot теперь захватывает только opaque authority до checkpoint/provider,
а startup coordinator владеет lease lifecycle и прошёл abrupt-process test. Для
live статуса доказательств пока недостаточно: отсутствуют concrete service-manager
adapter, startup wiring и real Telegram sandbox E2E; checkbox генерального
плана остаётся открытым.
