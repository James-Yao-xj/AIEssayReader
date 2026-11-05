# Plan
1. Archive agent: versioned snapshots, autosave, continuation.
2. AI agent: partial chat state, oversized compression, stable page citations, opt-in resumable segmented tasks.
3. PDF agent: layout, cancellation, archive reattachment and citation navigation, selective OCR retry.
4. Root: partial analysis UI/status/export, segmented task consent/progress controls, incremental rendering and UI module split, export focus/accessibility.
5. Independent integration review then browser and unit verification, update specs, commit and push.

Ownership: agents coordinate APIs before coding. Parent owns integration and direct UI/rendering deliverables. No output token caps. No automatic paid calls on startup.

## Final review

All accepted deliverables implemented: v2 archives/autosave/reattachment; partial result status; fragment compression; page citations; conservative column extraction; stable-block streaming rendering; explicit resumable segmented tasks; failed-page OCR retry; cancellation/export focus; module split and real-browser CI.

Independent checks found and resolved startup restore/load race, segmented imported checkpoint/output mismatch, stale evidence restore, export double print and dialog cleanup ownership.

Validation: 69 module/integration tests passed; 4 real Chrome end-to-end tests passed with generated PDF and mocked AI; production single HTML build passed; diff check passed. Paid model endpoints were not exercised; rotated/table-heavy layouts remain manual-review cases. No output token limits added.
