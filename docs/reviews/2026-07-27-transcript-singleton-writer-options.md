# Варианты singleton writer для transcript v2

Дата: 2026-07-27  
Статус: proposal, решение не принято

## 1. Проблема

Core сериализует append только внутри одного процесса. Node persistence хранит
общий `transcript-v2.jsonl`, session manifest и WAL, поэтому два процесса с одним
`AISY_HOME` могут одновременно прочитать одинаковый head и начать несовместимые
commit. Проверки conflict/quarantine обнаружат часть гонок, но обнаружение не
заменяет запрет второго writer.

Service manager обычно запускает один экземпляр unit/LaunchAgent, однако ручной
`aisy run`, второй supervisor или ошибочная конфигурация обходят эту гарантию.
Перед `V2_WRITES_ENABLED` нужен доказуемый межпроцессный барьер.

## 2. Рассмотренные варианты

### A. Полагаться только на supervisor

Плюс — нет нового persistent state. Минус — защита действует только внутри
одного правильно настроенного supervisor и не закрывает ручной второй процесс.
Для production safety boundary этого недостаточно.

### B. Глобальный process-lifetime directory lease — рекомендуется

Первый процесс атомарно создаёт `${AISY_HOME}/.transcript-writer.lock/` и
публикует `owner.json` с exact schema: pid, boot identity, process start identity,
nonce и временем acquisition. Каталог имеет `0700`, owner — `0600`; token и
каталоги fsync до открытия transcript/WAL. Lease удерживается весь срок жизни
процесса, а каждый recorder вызов проверяет byte-identical ownership до I/O.

Второй процесс и corrupt/abandoned lock получают fail-closed отказ. Автоматический
time-based или PID-only takeover запрещён: timeout не доказывает смерть writer,
а PID может быть переиспользован. Recovery выполняет отдельный operator-visible
doctor после проверки boot id и process start identity.

Плюсы — одинаковая семантика на macOS/Linux, защищён и общий JSONL, и все
sessions. Минусы — нужен doctor recovery после crash и graceful release при
штатной остановке.

### C. OS advisory lock (`flock`/`fcntl`)

Lock автоматически снимается после crash, но в Node нет одного встроенного
cross-platform API с одинаковой семантикой для macOS/Linux. Появляется native
dependency и отдельные filesystem/container ограничения. Можно вернуться к
варианту после отдельного compatibility исследования.

### D. Lock на каждую session

Снижает contention, но не защищает общий `transcript-v2.jsonl` и global event-id
lookup. Без отдельного global append coordinator не удовлетворяет текущему
layout.

## 3. Предлагаемое решение для ADR

1. Один global writer lease на canonical `AISY_HOME` удерживается весь process
   lifetime.
2. Acquisition происходит до чтения manifest, WAL и общего JSONL.
3. Exact owner token включает schema version, pid, boot id, process start id,
   nonce и `acquiredAt`; release разрешён только byte-matching владельцу.
4. Corrupt или abandoned lock никогда не перехватывается автоматически.
5. Doctor recovery — отдельное подтверждаемое действие с audit event; runtime
   только сообщает lock metadata без секретов.
6. Transcript production factory требует активный writer lease и проверяет его
   перед каждым `start/history/record`.
7. Activation gate доказывает одновременно service-manager singleton и durable
   writer lease; одного из двух доказательств недостаточно.

## 4. Проверки перед activation

- два реальных OS-процесса: ровно один получает lease;
- corrupt owner и crash residue блокируют writer до doctor recovery;
- PID reuse без совпавшего boot/start identity не разрешает takeover;
- wrong nonce не освобождает чужой lock;
- disk-full между mkdir/owner/fsync оставляет fail-closed recoverable state;
- SIGTERM освобождает свой lock, SIGKILL оставляет operator-visible residue;
- второй writer не открывает manifest/WAL/JSONL и не вызывает provider;
- legacy composition без transcript не требует lock и остаётся rollback path.

## 5. Требуемое согласование

Это durable architecture и security boundary. До принятия ADR код process lock
не добавляется; `V2_WRITES_ENABLED` остаётся закрыт.
