# Plan
1. Audit PDF rendering and add bounded rendering with tests.
2. Audit dialogs and keyboard/file controls and test.
3. Audit model compatibility/settings and test.
4. Fix Markdown streaming behavior.
5. Integration review, test, build, audit, document, commit and push existing PR.
Verified: 32 tests pass, single HTML build succeeds, diff check clean. Chrome startup shows new file entry and accessible tab identities. Full real-service/PDF/cross-browser acceptance remains outside this automated pass.
