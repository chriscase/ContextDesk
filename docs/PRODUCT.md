# Product brief — ContextDesk

## Positioning

> Find where it lives. Synthesize with citations. Remember what you learned.  
> Coding agents write code; ContextDesk understands systems.

## Jobs-to-be-done

1. Locate knowledge across sources when the user does not know where it lives  
2. Connect claims across files, memory, DBs, and connectors with provenance  
3. Synthesize durable mental models (architecture notes, decision logs)  
4. Onboard / re-enter a codebase or system quickly  
5. Act safely (reads free; writes confirmed)  
6. Use whatever LLM gateway is available (discovery-first configuration)  
7. Capture repeatable methods as **skills**  
8. Optionally share team knowledge via headless server  

## Magic moment (MVP)

Point at allowlisted folders + memory → ask how a subsystem works → get streaming markdown with file citations, explicit unknowns, and one-click save to project memory—after permission.

## UX principles

| Principle | Detail |
|-----------|--------|
| **Settings-first** | Normal use never requires hand-editing config files |
| **Preflight** | Local/remote dependency health is visible and re-checkable |
| **Live forms** | Validate as you type; probe/debounce expensive checks |
| Citation-first | Answers without sources are incomplete |
| Search trail | Show where the assistant looked |
| Compact density | Tool cards and history stay scannable |
| Permission theater is a feature | Obvious confirm UI for writes |
| Calm chrome | Multi-pane without IDE clutter |
| Themeable | CSS variables; dark default |

Config files and env vars may exist for power users and servers; they are **not** the happy path.

## Personas

- Individual developer mapping a complex stack  
- Small team sharing runbooks/memory via server (later)  
- Host app (e.g. coding agent desktop) embedding ContextDesk core/protocol  

## Success metrics (early)

- Time to first cited multi-source answer  
- % answers with ≥1 citation when retrieval hit  
- Zero HardWrites without UI grant in tests  
- Probe success rate on OpenAI-compatible + local Ollama  
