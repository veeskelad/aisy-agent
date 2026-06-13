# Component NN: <Name> — Specification

**Status:** Draft
**Component:** NN / 12
**Related ADRs:** ADR-XXXX, ADR-YYYY
**Depends on:** <other components>

> One-sentence statement of what this component is responsible for.

## 1. Purpose

What this component does and why it exists in the harness. Tie it to the
OS-around-the-model thesis: which part is deterministic code (100%) and which part
defers to the model (~70%).

## 2. Responsibilities

- What this component **owns**.
- What it explicitly **does not** do (boundaries — name the neighbouring component
  that owns it instead).

## 3. Interfaces

Conceptual API surface (TypeScript-shaped signatures are fine; this is a spec, not
code). For each public entry point: inputs, outputs, errors it can return, and the
events it emits or consumes. Keep the narrow-waist principle in mind (ADR-0014).

```ts
// illustrative, not binding
export interface Example {
  doThing(input: Input): Promise<Result>
}
```

## 4. Data structures

Key types, schemas, on-disk formats, or table layouts this component defines or
owns (e.g. a memory fact row, a plan step, a hook decision). Note any format that
must be byte-stable or deterministic and why (e.g. KV-cache prefix, ADR-0019).

## 5. Behavior & control flow

How it works. Algorithms, ordering guarantees, and any non-trivial flow as an ASCII
or mermaid diagram (state machine, pipeline, decision tree). Call out where a step
is deterministic code vs a model call.

## 6. Dependencies

- Internal: which components it calls / is called by.
- External: libraries, sidecars, services — each with the governing ADR.

## 7. Failure & degraded modes (mandatory)

A table of failure modes. For each: trigger, how it is **detected**, the behavior
(fail-closed / fail-open / degrade / queue), what the user sees, and the recovery
path. Cold start and "dependency unavailable" must appear here.

| Failure | Detection | Behavior | Recovery |
|---|---|---|---|
| … | … | fail-closed | … |

## 8. Security & threat model

For security-relevant components only (delete this section if not applicable, and
say why). Threats (STRIDE / OWASP-LLM), and the **deterministic** mitigation for
each, citing the enforcing ADR. State explicitly what is enforced by code vs by the
model.

## 9. Acceptance criteria (mandatory)

Numbered, each a single verifiable assertion that a Phase-3 test will check. Cover
the happy path, the failure modes in §7, and the security invariants in §8. Each
criterion must be objectively checkable (a file exists, a row changed, a call was
blocked), never "works correctly".

1. **AC-NN-1** — …
2. **AC-NN-2** — …

## 10. Open questions

Anything deferred or unresolved for a later milestone. Link the ADR or roadmap item
that will resolve it. "Nothing open" is a valid answer.

## 11. References

- ADRs: links by canonical filename.
- Concept docs: `docs/concepts/…`.
