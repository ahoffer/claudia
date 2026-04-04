# Claudia Development Guide

Read README.md, ARCHITECTURE.md, and INSTALL.md in the project root for full context on the project, its structure, API surface, and deployment model.

## DO NOT RESTART THE SERVER

NEVER run `./start.sh`, `npm run dev`, or kill/restart the server during development.

The backend uses `tsx watch` which automatically reloads when you change `.ts` files. Wait 1-2 seconds after saving and changes are live.

Restarting the server while tasks are running causes OOM crashes (exit code 137), nested server instances that consume all system memory, and loss of active task connections.

<!-- CODEUI-RULES -->
## Custom Rules

if it's a new feature, try to use a test cli unless it would be much easier to just have the user do a manual test (this is usually the case for visual features).. if it doesn't have functionality to do the test then add it. you can also use playwright mcp or curl if either of these would be easier. make sure you have enough logging to debug any issues.. if you create any test files, clean them up when you are done.  NEVER TOUCH PORT 4001.. if you are having issues with public apis, lookup examples online. always review your changes for gaps and issues after making extensive changes.
<!-- /CODEUI-RULES -->
