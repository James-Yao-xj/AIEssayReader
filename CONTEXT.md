# Context management

Primary paper-analysis and chat requests pass through `planContext()` in `src/ai/context.js`. The planner returns messages, current paper coverage, retained/omitted history counts, and estimated input size. It does not mutate application state. Conversation compression uses separate bounded batch admission in `client.js`.

## Input budget

`settings.reading.contextTokens` defaults to 24,000 estimated input tokens and is configurable from 2,000 to 200,000. Ten percent remains unused as an estimation margin. Set this below the model's context capacity to leave room for its output. The app does not detect model limits automatically.

The estimate counts ASCII characters at approximately one token per three characters and other Unicode characters at two tokens each, plus message framing. This is a language-aware heuristic, not an exact tokenizer or a guaranteed upper bound for every model.

## Full-paper tasks

Summary, concept explanation, critique, and translation send the complete paper without chat history. If the complete request cannot fit, the app rejects it before sending anything. The error suggests increasing the budget within the model's supported range or asking a focused chat question. The app does not silently truncate the paper or automatically start multiple paid requests.

## Chat planning

1. Reserve the full current question, global instructions, task template, and a bounded conversation summary.
2. Exclude the history already represented by `conversationSummary.summarizedUpTo` when a summary exists. Retain recent unsummarized messages within the history allowance and the recent-round limit.
3. Send the full paper if it fits. Otherwise choose bounded chunks, giving priority to the opening, conclusion, and keyword matches from the current question and summary. Previously selected matching chunks receive a small score bonus.
4. Return the selected chunks in source order. Tell the model that missing chunks are not evidence that the paper lacks that information.

The current question is never silently shortened. Oversized questions and templates fail before history is modified.

## Conversation compression

After a successful chat, messages older than the most recent 12 become candidates for compression. Each turn compresses one bounded batch. An oversized old message is compressed in fragments with an exclusive UTF-16 cursor, so it cannot permanently block later history. Incomplete assistant replies are retained for display and export but excluded from future model context. The summary request is capped at the smaller of 8,000 estimated tokens and the configured usable input budget. Stored summaries are capped at 1,200 estimated tokens.

The exclusive `summarizedUpTo` index advances only after successful compression and only through content included in that batch; a partial message retains its pending cursor. Failed compression keeps the old summary and index. Large pairs that do not fit are deferred; coverage status states when history was omitted or compression failed. Summaries are lossy, and no claim is made that every omitted detail was preserved.

## Coverage and lifecycle

The shared AI status line reports the task, estimated input/configured budget, selected/total paper chunks, and sent/omitted original history. It describes the planned request, not an accumulated count across earlier requests.

Changing the paper clears chat, summary, retrieval indices, and context status. Old responses and summaries cannot write into the new paper. Failed or cancelled chat requests roll back their pending turn. Archive restore retains saved messages but resets compression/retrieval state because the original PDF text is not archived.

## Implementation and tests

- `src/ai/context.js`: pure planning and token estimation.
- `src/ai/client.js`: requests, bounded incremental compression, status, cancellation guards.
- `src/config/storage.js` and `src/ui/settings.js`: budget persistence and editing.
- `tests/context.test.js` and `tests/ai-client.test.js`: budget, coverage, compression, and lifecycle regressions.

## Output policy

The app does not send `max_tokens`, `max_completion_tokens`, or `max_output_tokens`. User-facing default task prompts have no fixed word-count ceiling. Input budgets and the internal compressed-history size do not cap displayed answers. Provider/model limits still apply.

## Reading workflows

`chunkPaper()` assigns stable per-page IDs. Requests carry only the selected evidence labels; citation navigation resolves against the complete retained paper. It validates the label, not whether the claim is semantically supported.

Explicit segmented tasks group bounded source chunks. Translation retains completed parts; analysis synthesizes section notes with bounded reduction requests when necessary. Checkpoints are document/configuration-specific and survive archive/autosave recovery. Additional reductions are announced before opting in; no model requests run merely from opening the confirmation dialog.

New v2 archives retain the source text and summary cursor, so recovery can resume context without loading the PDF binary. A matching PDF fingerprint restores the preview while preserving this state. Legacy archives without text remain viewable but need a source document.
