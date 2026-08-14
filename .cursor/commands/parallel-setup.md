---
name: parallel-setup
description: Set up the Parallel plugin (install pinned parallel-cli and authenticate)
---

# Parallel Plugin Setup

Follow the `parallel-setup` skill at `.cursor/skills/parallel-setup/SKILL.md` exactly.

Summary:
1. Ensure `PATH` includes `$HOME/.local/bin`
2. Install with pinned `pip3 install --user 'parallel-web-tools[cli]==0.9.2'` (no curl|bash)
3. Authenticate via Cloud dashboard secret `PARALLEL_API_KEY` (never commit or log the key)
4. Verify with `parallel-cli --version` and `parallel-cli auth`
